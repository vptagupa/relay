// Reusable building blocks for PM provider plugins (MAIN PROCESS ONLY). A plugin composes these so that adding
// a provider is mostly declaration: `configStore` implements getConfig/setConfig from a ConfigField[] list,
// `tokenStore` handles OAuth token persistence + refresh-on-expiry, `pmReq` is a scheme-aware HTTP(S) client
// (Echo/Jira can be self-hosted on http://localhost), and genVerifier/challenge are PKCE. Every secret is
// namespaced per provider under `${ws}:pm:${id}:*` in the OS keychain, so providers never collide and the
// renderer never sees a token.

import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import * as keys from '../keys';
import type { ConfigField, PmConfig } from './types';

export const str = (x: unknown): string => (typeof x === 'string' ? x : x == null ? '' : String(x));
export const enc = encodeURIComponent;
export const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Per-provider keychain key. Every provider's secrets live under its own namespace so two providers can define
// the same field name without clashing, and disconnecting one never touches another.
export const skey = (ws: string, id: string, name: string): string => `${ws}:pm:${id}:${name}`;

/* ----------------------------- PKCE (RFC 7636) ----------------------------- */
// 32 random bytes → a 43-char base64url verifier (in-range); challenge = base64url(sha256(verifier)). The
// verifier is held only in the main-process OAuth handler closure — never persisted, never sent to the renderer.
export function genVerifier(): string { return b64url(randomBytes(32)); }
export function challenge(verifier: string): string { return b64url(createHash('sha256').update(verifier).digest()); }

/* ----------------------------- scheme-aware request ----------------------------- */
// Picks http/https from the URL scheme (a provider may be a local http host) and takes a FULL url (discovery /
// token / API endpoints are absolute). Never rejects — resolves { status:0 } on error/timeout, like httpsReq.
export function pmReq(fullUrl: string, method: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    let u: URL;
    try { u = new URL(fullUrl); } catch { resolve({ status: 0, text: '' }); return; }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      { hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, method, headers: { 'User-Agent': 'SlayerT', ...headers } },
      (res) => { let text = ''; res.setEncoding('utf8'); res.on('data', (c) => (text += c)); res.on('end', () => resolve({ status: res.statusCode || 0, text })); },
    );
    req.on('error', () => resolve({ status: 0, text: '' }));
    req.setTimeout(20000, () => { try { req.destroy(); } catch { /* */ } resolve({ status: 0, text: '' }); });
    if (body) req.write(body);
    req.end();
  });
}

/* ----------------------------- generic config store ----------------------------- */
// Implements a provider's getConfig/setConfig straight from its ConfigField[] declaration: non-secret fields are
// read back, secret fields expose only a hasSecret flag (write-only), and a blank secret on save keeps the
// stored one. `configured` = every required field present. `field(ws,key)` reads one raw value for the plugin.
export function configStore(id: string, fields: ConfigField[], redirectUri?: string) {
  return {
    async get(ws: string): Promise<PmConfig> {
      const outFields: Record<string, string> = {}; const hasSecrets: Record<string, boolean> = {};
      let configured = true;
      for (const f of fields) {
        const v = (await keys.getSecret(skey(ws, id, f.key))) || '';
        if (f.secret) hasSecrets[f.key] = !!v; else outFields[f.key] = v;
        if (f.required && !v) configured = false;
      }
      return { fields: outFields, hasSecrets, configured, redirectUri };
    },
    async set(ws: string, values: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
      // Validate + normalize FIRST so a bad payload writes nothing (all-or-nothing). url fields must carry a
      // scheme and lose any trailing slash, else request-URL joins silently break.
      const norm: Record<string, string> = {};
      for (const f of fields) {
        let v = (values[f.key] || '').trim();
        if (f.url && v) { if (!/^https?:\/\//i.test(v)) return { ok: false, error: `${f.label} must start with http:// or https://` }; v = v.replace(/\/+$/, ''); }
        if (f.required && !f.secret && !v) return { ok: false, error: `${f.label} is required` };
        if (f.required && f.secret && !v && !(await keys.getSecret(skey(ws, id, f.key)))) return { ok: false, error: `${f.label} is required` };
        norm[f.key] = v;
      }
      for (const f of fields) {
        const v = norm[f.key];
        if (f.secret) { if (v) await keys.setSecret(skey(ws, id, f.key), v); } // blank = keep existing
        else await keys.setSecret(skey(ws, id, f.key), v);
      }
      return { ok: true };
    },
    field: (ws: string, key: string): Promise<string | null> => keys.getSecret(skey(ws, id, key)),
  };
}

/* ----------------------------- generic OAuth token store ----------------------------- */
// Persists access/refresh/expires/account for one provider, and vends a valid access token — refreshing via the
// plugin-supplied refresh function when the (early) expiry passes. The plugin owns the refresh HTTP (its
// endpoints differ); this owns the storage + expiry bookkeeping so every OAuth plugin doesn't re-implement it.
export function tokenStore(id: string) {
  return {
    async store(ws: string, j: Record<string, unknown>): Promise<void> {
      if (j.access_token) await keys.setSecret(skey(ws, id, 'oauth'), str(j.access_token));
      if (j.refresh_token) await keys.setSecret(skey(ws, id, 'refresh'), str(j.refresh_token)); // keep the old one if not rotated
      const ttl = Number(j.expires_in) || 3600;
      await keys.setSecret(skey(ws, id, 'expires'), String(Date.now() + Math.max(60, ttl - 60) * 1000)); // renew 60s early
    },
    token: (ws: string): Promise<string | null> => keys.getSecret(skey(ws, id, 'oauth')),
    refreshToken: (ws: string): Promise<string | null> => keys.getSecret(skey(ws, id, 'refresh')),
    setAccount: (ws: string, account: string): Promise<void> => keys.setSecret(skey(ws, id, 'account'), account),
    account: (ws: string): Promise<string | null> => keys.getSecret(skey(ws, id, 'account')),
    async clear(ws: string): Promise<void> { for (const n of ['oauth', 'refresh', 'expires', 'account']) await keys.setSecret(skey(ws, id, n), ''); },
    // A valid access token, refreshing on expiry via `refreshFn`. null if not connected / refresh failed.
    async access(ws: string, refreshFn: () => Promise<boolean>): Promise<string | null> {
      const t = await keys.getSecret(skey(ws, id, 'oauth'));
      if (!t) return null;
      const exp = Number(await keys.getSecret(skey(ws, id, 'expires'))) || 0;
      if (exp && Date.now() >= exp) return (await refreshFn()) ? keys.getSecret(skey(ws, id, 'oauth')) : null;
      return t;
    },
  };
}
