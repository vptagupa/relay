import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Provider } from './shared/models';
import type { DbCredMeta } from './shared/types';

// API keys are encrypted at rest with the OS keychain (via Electron safeStorage)
// and never sent to the renderer. Only the main process reads them.

const keyFile = () => path.join(app.getPath('userData'), 'keys.json');

async function readRaw(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(keyFile(), 'utf8'));
  } catch {
    return {};
  }
}

// Writes are SERIALIZED and ATOMIC. keys.json is a read-modify-write store, so two concurrent writers (e.g.
// the boot-time global→workspace migration racing a Bitbucket token refresh) would clobber each other's
// changes — a lost update. Chain every mutation so its read+write runs to completion before the next starts,
// and swap the file in via temp-file + rename so a reader never sees a half-written file. (Mirrors store.ts.)
let writeChain: Promise<unknown> = Promise.resolve();
function enqueueWrite(mutate: (raw: Record<string, string>) => void): Promise<void> {
  const run = writeChain.then(async () => {
    const raw = await readRaw();
    mutate(raw);
    const tmp = keyFile() + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(raw), 'utf8');
    await fs.rename(tmp, keyFile());
  });
  writeChain = run.catch(() => {}); // keep the chain alive even if one write fails
  return run;
}
// Encode a value for storage: OS-keychain-encrypted where available, else base64 (documented fallback).
function encode(value: string): string {
  return safeStorage.isEncryptionAvailable()
    ? 'enc:' + safeStorage.encryptString(value).toString('base64')
    : 'raw:' + Buffer.from(value, 'utf8').toString('base64');
}
// Inverse of encode(): decrypt an `enc:`/`raw:` value, or null if it can't be read (wrong prefix / bad ciphertext).
function decode(v: string | undefined): string | null {
  if (!v) return null;
  if (v.startsWith('enc:')) { try { return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')); } catch { return null; } }
  if (v.startsWith('raw:')) return Buffer.from(v.slice(4), 'base64').toString('utf8');
  return null;
}

export function setKey(provider: Provider, value: string): Promise<void> {
  return enqueueWrite((raw) => { if (!value) delete raw[provider]; else raw[provider] = encode(value); });
}

export async function getKey(provider: Provider): Promise<string | null> {
  const raw = await readRaw();
  const v = raw[provider];
  if (!v) return null;
  if (v.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
    } catch {
      return null;
    }
  }
  if (v.startsWith('raw:')) return Buffer.from(v.slice(4), 'base64').toString('utf8');
  return null;
}

// Generic encrypted secret store (same at-rest encryption as API keys) for tokens like the GitHub
// OAuth access token — keyed by an arbitrary name, never exposed to the renderer.
export function setSecret(name: string, value: string): Promise<void> {
  return enqueueWrite((raw) => { if (!value) delete raw[name]; else raw[name] = encode(value); });
}
export async function getSecret(name: string): Promise<string | null> {
  const raw = await readRaw();
  const v = raw[name];
  if (!v) return null;
  if (v.startsWith('enc:')) { try { return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')); } catch { return null; } }
  if (v.startsWith('raw:')) return Buffer.from(v.slice(4), 'base64').toString('utf8');
  return null;
}

export async function hasKeys(): Promise<Record<string, boolean>> {
  const raw = await readRaw();
  return {
    anthropic: !!raw.anthropic,
    openai: !!raw.openai,
    google: !!raw.google,
  };
}

/* ----------------------------- database credential templates ----------------------------- */
// Saved DB connection templates the user can reference from a pipeline run. The WHOLE record — including the
// password and every extra-var value — is stored encrypted at rest (one JSON blob per template, under the key
// `dbcred:<id>`), and the plaintext never leaves the main process. The renderer only ever gets the sanitized
// DbCredMeta (connection metadata + which env-var names get injected, but no secret values), and at run time
// the main process resolves the id → the env map that seeds the run's shell. Nothing is persisted in the
// renderer-visible settings/store, and no value is ever written into a brief or worktree file.

const DBC_PREFIX = 'dbcred:';

// The full stored record (main-only). `extras` are extra env vars whose VALUES are secret.
export interface DbCredRecord {
  id: string;
  label: string;
  engine?: string;
  host?: string;
  port?: string;
  database?: string;
  user?: string;
  password?: string;
  extras?: Record<string, string>;
  ts?: number;
}
// The renderer's save payload. On EDIT, an omitted/blank password keeps the stored one, and an extra whose value
// is blank keeps its stored value (the renderer can't see secret values, so a blank means "unchanged").
export interface DbCredInput {
  id?: string;
  label: string;
  engine?: string;
  host?: string;
  port?: string;
  database?: string;
  user?: string;
  password?: string;
  extras?: Record<string, string>;
}

const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
// URL scheme for engines we can build a DATABASE_URL for ('' → no URL, only the discrete DB_* vars).
function schemeFor(engine?: string): string {
  switch ((engine || '').toLowerCase()) {
    case 'postgres': case 'postgresql': return 'postgresql';
    case 'mysql': case 'mariadb': return 'mysql';
    case 'mongodb': case 'mongo': return 'mongodb';
    case 'mssql': case 'sqlserver': return 'sqlserver';
    case 'redis': return 'redis';
    default: return '';
  }
}
// Pure record → env-var map. The single source of truth for BOTH the injected environment (resolveDbCredEnv)
// and the advertised variable names (DbCredMeta.envVars) so the brief note can't drift from what's set.
export function buildDbEnv(rec: DbCredRecord): Record<string, string> {
  const env: Record<string, string> = {};
  const put = (k: string, v?: string) => { if (v) env[k] = v; };
  put('DB_ENGINE', rec.engine); put('DB_HOST', rec.host); put('DB_PORT', rec.port);
  put('DB_NAME', rec.database); put('DB_USER', rec.user); put('DB_PASSWORD', rec.password);
  const scheme = schemeFor(rec.engine);
  if (scheme && rec.host) {
    const auth = rec.user ? `${encodeURIComponent(rec.user)}${rec.password ? ':' + encodeURIComponent(rec.password) : ''}@` : '';
    const port = rec.port ? `:${rec.port}` : '';
    const db = rec.database ? `/${encodeURIComponent(rec.database)}` : '';
    env.DATABASE_URL = `${scheme}://${auth}${rec.host}${port}${db}`;
  }
  // libpq/psql/pg auto-read these — a real convenience for Postgres runs.
  if (scheme === 'postgresql') { put('PGHOST', rec.host); put('PGPORT', rec.port); put('PGDATABASE', rec.database); put('PGUSER', rec.user); put('PGPASSWORD', rec.password); }
  // User-defined extras last, so an explicit override wins (the user typed them deliberately).
  for (const [k, v] of Object.entries(rec.extras || {})) if (k) env[k] = v;
  return env;
}
// Sanitize a record for the renderer: connection metadata + advertised env-var NAMES, but no secret VALUES.
function toMeta(rec: DbCredRecord): DbCredMeta {
  return {
    id: rec.id, label: rec.label, engine: rec.engine, host: rec.host, port: rec.port, database: rec.database, user: rec.user,
    hasPassword: !!rec.password, extraKeys: Object.keys(rec.extras || {}), envVars: Object.keys(buildDbEnv(rec)), ts: rec.ts,
  };
}
async function readAllDbCreds(): Promise<DbCredRecord[]> {
  const raw = await readRaw();
  const out: DbCredRecord[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith(DBC_PREFIX)) continue;
    const json = decode(v); if (!json) continue;
    try { const rec = JSON.parse(json) as DbCredRecord; if (rec && rec.id) out.push(rec); } catch { /* skip a corrupt entry */ }
  }
  out.sort((a, b) => (a.ts || 0) - (b.ts || 0)); // stable creation order
  return out;
}

export async function listDbCreds(): Promise<DbCredMeta[]> {
  return (await readAllDbCreds()).map(toMeta);
}
// Full record — MAIN PROCESS ONLY (never sent to the renderer); used to build the run env.
export async function getDbCred(id: string): Promise<DbCredRecord | null> {
  const raw = await readRaw();
  const json = decode(raw[DBC_PREFIX + id]); if (!json) return null;
  try { return JSON.parse(json) as DbCredRecord; } catch { return null; }
}
// The environment a template injects into a run's shell (empty if the id is unknown).
export async function resolveDbCredEnv(id: string): Promise<Record<string, string>> {
  const rec = id ? await getDbCred(id) : null;
  return rec ? buildDbEnv(rec) : {};
}
// Create or update a template; returns the fresh sanitized list. Merges secrets on edit (blank = keep).
export async function saveDbCred(input: DbCredInput): Promise<DbCredMeta[]> {
  const id = s(input.id) || `db_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  const existing = s(input.id) ? await getDbCred(id) : null;
  // Merge extras: a blank value on edit keeps the stored value; a non-blank replaces/adds; a dropped key removes it.
  const extras: Record<string, string> = {};
  for (const [k0, v0] of Object.entries(input.extras || {})) {
    const k = k0.trim(); if (!k) continue;
    const v = typeof v0 === 'string' ? v0 : '';
    if (v === '' && existing?.extras?.[k] != null) extras[k] = existing.extras[k];
    else if (v !== '') extras[k] = v;
  }
  const password = s(input.password) || existing?.password || '';
  const rec: DbCredRecord = {
    id, label: s(input.label) || 'database', engine: s(input.engine) || undefined,
    host: s(input.host) || undefined, port: s(input.port) || undefined, database: s(input.database) || undefined,
    user: s(input.user) || undefined, password: password || undefined,
    extras: Object.keys(extras).length ? extras : undefined,
    ts: existing?.ts || Date.now(),
  };
  await enqueueWrite((raw) => { raw[DBC_PREFIX + id] = encode(JSON.stringify(rec)); });
  return listDbCreds();
}
export async function deleteDbCred(id: string): Promise<DbCredMeta[]> {
  await enqueueWrite((raw) => { delete raw[DBC_PREFIX + id]; });
  return listDbCreds();
}
