// End-to-end encryption for cloud sync. PURE (node:crypto only — no electron), so the whole envelope format
// is unit-testable and has no side effects. The user's passphrase never leaves the machine; only the envelope
// below (ciphertext + public KDF params) is ever uploaded, so the cloud provider only ever sees opaque bytes.
//
// Scheme: scrypt(passphrase, random salt) -> 256-bit key; AES-256-GCM(random 96-bit IV) -> ciphertext + auth
// tag. GCM is authenticated: a wrong passphrase OR any tampering fails `final()` (we surface that as an error,
// never silently return garbage). Salt + IV are random per encryption, so the same data encrypts differently
// each time and a key is never reused across messages.

import { scryptSync, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';

// scrypt cost params (public — stored in the envelope so future changes stay decryptable). N=16384 keeps
// maxmem (128*N*r = 16 MB) under node's 32 MB default while being expensive to brute-force.
const KDF = { N: 16384, r: 8, p: 1, keyLen: 32 } as const;

export interface SyncEnvelope {
  v: 1;
  kdf: 'scrypt';
  N: number; r: number; p: number;
  salt: string;   // base64
  iv: string;     // base64 (96-bit GCM nonce)
  tag: string;    // base64 (128-bit GCM auth tag)
  ct: string;     // base64 ciphertext
}

function deriveKey(passphrase: string, salt: Buffer, N: number, r: number, p: number): Buffer {
  // maxmem must be raised above the default for larger N/r; 256 MB is a safe ceiling for these params.
  return scryptSync(passphrase, salt, KDF.keyLen, { N, r, p, maxmem: 256 * 1024 * 1024 });
}

// Encrypt a UTF-8 string under a passphrase → a JSON envelope string (safe to upload).
export function encryptString(plaintext: string, passphrase: string): string {
  if (!passphrase) throw new Error('passphrase required');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt, KDF.N, KDF.r, KDF.p);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const env: SyncEnvelope = {
    v: 1, kdf: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p,
    salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64'),
  };
  return JSON.stringify(env);
}

// Decrypt an envelope produced by encryptString. Throws 'wrong passphrase or corrupted data' on any mismatch/
// tamper (GCM auth), and 'unrecognized backup format' on a structurally invalid envelope.
export function decryptString(envelope: string, passphrase: string): string {
  let e: SyncEnvelope;
  try { e = JSON.parse(envelope) as SyncEnvelope; } catch { throw new Error('unrecognized backup format'); }
  if (!e || e.v !== 1 || e.kdf !== 'scrypt' || !e.salt || !e.iv || !e.tag || !e.ct) throw new Error('unrecognized backup format');
  const key = deriveKey(passphrase, Buffer.from(e.salt, 'base64'), e.N || KDF.N, e.r || KDF.r, e.p || KDF.p);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(e.tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(e.ct, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('wrong passphrase or corrupted data');
  }
}

// A short, NON-reversible verifier for a passphrase (scrypt over a fixed label + its own salt). Lets the app
// confirm "same passphrase as before" WITHOUT storing the passphrase — e.g. to warn before a first push, or to
// check a re-entered passphrase. It reveals nothing about the passphrase and can't decrypt anything.
export function passphraseVerifier(passphrase: string): string {
  const salt = randomBytes(16);
  const h = deriveKey('slayert-sync-verifier\x00' + passphrase, salt, KDF.N, KDF.r, KDF.p);
  return `${salt.toString('base64')}:${h.toString('base64')}`;
}
export function verifyPassphrase(passphrase: string, verifier: string): boolean {
  const [saltB64, hB64] = (verifier || '').split(':');
  if (!saltB64 || !hB64) return false;
  const h = deriveKey('slayert-sync-verifier\x00' + passphrase, Buffer.from(saltB64, 'base64'), KDF.N, KDF.r, KDF.p);
  const want = Buffer.from(hB64, 'base64');
  return h.length === want.length && timingSafeEqual(h, want);
}
