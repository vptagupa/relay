import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Provider } from './shared/models';

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
