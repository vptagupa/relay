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

export async function setKey(provider: Provider, value: string): Promise<void> {
  const raw = await readRaw();
  if (!value) {
    delete raw[provider];
  } else if (safeStorage.isEncryptionAvailable()) {
    raw[provider] = 'enc:' + safeStorage.encryptString(value).toString('base64');
  } else {
    // Fallback (e.g. Linux without a keyring): store plainly. Documented in README.
    raw[provider] = 'raw:' + Buffer.from(value, 'utf8').toString('base64');
  }
  await fs.writeFile(keyFile(), JSON.stringify(raw), 'utf8');
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

export async function hasKeys(): Promise<Record<string, boolean>> {
  const raw = await readRaw();
  return {
    anthropic: !!raw.anthropic,
    openai: !!raw.openai,
    google: !!raw.google,
  };
}
