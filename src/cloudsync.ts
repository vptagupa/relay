// Cloud-sync orchestration — MAIN PROCESS ONLY. Ties together the secret store (keys.ts), the end-to-end
// crypto (sync-crypto.ts), and the Drive client (gdrive.ts):
//
//   PUSH  = read slayert.json + workspace.json + decrypt all secrets  ->  one JSON bundle
//           ->  AES-256-GCM encrypt under the user's passphrase       ->  upload to Drive appDataFolder.
//   PULL  = download the envelope  ->  decrypt with the passphrase    ->  write the data files + re-encrypt
//           the secrets into THIS machine's keychain  ->  the app relaunches to load the fresh state.
//
// The passphrase lives only in the local keychain (DPAPI) and is NEVER uploaded. Only ciphertext reaches Drive.

import { app } from 'electron';
import { promises as fs, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import * as keys from './keys';
import * as gdrive from './gdrive';
import * as store from './store';
import { encryptString, decryptString, passphraseVerifier } from './sync-crypto';

const BUNDLE_VERSION = 1;
const P = (name: string) => path.join(app.getPath('userData'), name);
const safeParse = (s: string): unknown => { try { return JSON.parse(s); } catch { return {}; } };

// Restore-time path localization: workspace roots are absolute (e.g. D:\projects\x) and won't exist on a
// different PC. KEEP any path that DOES exist here (same layout on both machines is common); null the rest so
// the restored workspace shows unrooted (prompt to pick a folder) instead of silently pointing at a phantom
// path. Tab cwds in workspace.json are left alone — pty.ts already falls back to the home dir for a missing cwd.
function localizePaths(slayert: unknown): unknown {
  if (!slayert || typeof slayert !== 'object') return slayert;
  const s = slayert as Record<string, unknown>;
  const missing = (v: unknown): boolean => typeof v === 'string' && v.length > 0 && !existsSync(v);
  const settings = s.settings as Record<string, unknown> | undefined;
  if (settings && missing(settings.workspace)) settings.workspace = null;
  if (Array.isArray(s.workspaces)) for (const w of s.workspaces as Array<Record<string, unknown>>) if (w && missing(w.root)) w.root = null;
  return slayert;
}
async function readOr(name: string, fallback: string): Promise<string> { try { return await fs.readFile(P(name), 'utf8'); } catch { return fallback; } }
async function writeAtomic(name: string, data: string): Promise<void> {
  const f = P(name); const tmp = `${f}.sync.tmp`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, f);
}

interface Bundle {
  v: number; ts: number; machine: string;
  slayert: unknown;                  // parsed slayert.json (sessions + settings + workspace defs)
  workspace: unknown;                // parsed workspace.json (per-workspace tab snapshots)
  secrets: Record<string, string>;   // plaintext secrets — protected only by the envelope's encryption
}

/* ----------------------------- passphrase (device-local) ----------------------------- */
export async function hasPassphrase(): Promise<boolean> { return !!(await keys.getSecret('sync:passphrase')); }
export async function setPassphrase(passphrase: string): Promise<{ ok: boolean; error?: string }> {
  const p = passphrase || '';
  if (p.length < 8) return { ok: false, error: 'Use a passphrase of at least 8 characters' };
  await keys.setSecret('sync:passphrase', p);
  await keys.setSecret('sync:pass_verifier', passphraseVerifier(p)); // lets us confirm a match without storing it in the clear elsewhere
  return { ok: true };
}
const getPassphrase = (): Promise<string | null> => keys.getSecret('sync:passphrase');

/* ----------------------------- status ----------------------------- */
export async function status(): Promise<{ configured: boolean; connected: boolean; email: string; hasPassphrase: boolean; lastPush: number; lastPull: number; remoteExists: boolean; remoteModified: string }> {
  const cfg = await gdrive.getConfig();
  const auth = await gdrive.authState();
  const remote = auth.connected ? await gdrive.findSyncFile() : null;
  return {
    configured: cfg.configured,
    connected: auth.connected,
    email: auth.email || '',
    hasPassphrase: await hasPassphrase(),
    lastPush: Number(await keys.getSecret('sync:last_push')) || 0,
    lastPull: Number(await keys.getSecret('sync:last_pull')) || 0,
    remoteExists: !!remote,
    remoteModified: remote?.modifiedTime || '',
  };
}

/* ----------------------------- push ----------------------------- */
export async function push(): Promise<{ ok: boolean; error?: string; ts?: number }> {
  const pass = await getPassphrase(); if (!pass) return { ok: false, error: 'Set a sync passphrase first' };
  if (!(await gdrive.authState()).connected) return { ok: false, error: 'Connect Google Drive first' };
  // Read the persisted state from disk (kept current by the store's flushes) + decrypt every secret.
  const bundle: Bundle = {
    v: BUNDLE_VERSION, ts: Date.now(), machine: (() => { try { return hostname(); } catch { return 'unknown'; } })(),
    slayert: safeParse(await readOr('slayert.json', '{}')),
    workspace: safeParse(await readOr('workspace.json', '{}')),
    secrets: await keys.exportSecrets(),
  };
  const envelope = encryptString(JSON.stringify(bundle), pass); // encrypted BEFORE it leaves the process
  const up = await gdrive.uploadSyncFile(envelope);
  if (!up.ok) return { ok: false, error: up.error };
  await keys.setSecret('sync:last_push', String(bundle.ts));
  return { ok: true, ts: bundle.ts };
}

/* ----------------------------- pull ----------------------------- */
// Downloads + decrypts + applies the bundle. On success the caller MUST relaunch the app (relaunchAfterPull)
// so the fresh files load — the store caches state in memory, so persistence is suspended here to make sure
// nothing overwrites what we just wrote before the relaunch.
export async function pull(): Promise<{ ok: boolean; error?: string; applied?: boolean; ts?: number; missing?: boolean }> {
  const pass = await getPassphrase(); if (!pass) return { ok: false, error: 'Set your sync passphrase first' };
  if (!(await gdrive.authState()).connected) return { ok: false, error: 'Connect Google Drive first' };
  const dl = await gdrive.downloadSyncFile();
  if (!dl.ok) return { ok: false, error: dl.error, missing: dl.missing };
  let bundle: Bundle;
  try { bundle = JSON.parse(decryptString(dl.content || '', pass)) as Bundle; }
  catch (e) { return { ok: false, error: (e as Error).message || 'Could not decrypt the backup' }; } // wrong passphrase / tamper
  if (!bundle || bundle.v !== BUNDLE_VERSION || !bundle.slayert) return { ok: false, error: 'Unrecognized backup format' };
  // Freeze the store BEFORE touching files so no in-flight/subsequent flush (incl. the shutdown flush) can
  // clobber the restored data between now and the relaunch.
  store.suspendPersistence();
  await writeAtomic('slayert.json', JSON.stringify(localizePaths(bundle.slayert)));
  await writeAtomic('workspace.json', JSON.stringify(bundle.workspace ?? { version: 1, byId: {} }));
  await keys.importSecrets(bundle.secrets || {}); // re-encrypted under this machine's keychain
  await keys.setSecret('sync:last_pull', String(bundle.ts || Date.now()));
  return { ok: true, applied: true, ts: bundle.ts };
}

// Relaunch to load the freshly-restored state (called by the renderer after a confirmed pull).
export function relaunchAfterPull(): void {
  app.relaunch();
  app.exit(0);
}
