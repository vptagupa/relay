// Google Drive client for cloud sync — MAIN PROCESS ONLY. Mirrors the Bitbucket OAuth pattern: a user-supplied
// OAuth client (id + secret, stored encrypted in the keychain), an authorization-code + loopback-redirect flow
// (the loopback server lives in main.ts, which calls exchangeCode here), and REST calls via the shared httpsReq.
//
// The encrypted sync bundle is stored as a single file in Drive's hidden **appDataFolder** (scope
// drive.appdata) — an app-private space that doesn't appear in the user's normal Drive and can't be read by
// other apps. Tokens live encrypted in the OS keychain under `sync:*` and NEVER reach the renderer or the
// synced bundle (they're device-local). The renderer only ever sees { connected, email }.

import { httpsReq } from './providers';
import * as keys from './keys';

const AUTH_HOST = 'accounts.google.com';
const TOKEN_HOST = 'oauth2.googleapis.com';
const API_HOST = 'www.googleapis.com';
// drive.appdata = app-private hidden folder; openid+email = just enough to show which account is connected.
const SCOPES = 'https://www.googleapis.com/auth/drive.appdata openid email';
const SYNC_FILENAME = 'slayert-sync.enc';

// Fixed loopback port. A Google "Desktop app" OAuth client accepts any http://127.0.0.1:<port> redirect
// without pre-registering the exact port, so this needs no extra Google-side setup.
export const GD_OAUTH_PORT = 47825;
export const GD_REDIRECT_URI = `http://127.0.0.1:${GD_OAUTH_PORT}`;

const enc = encodeURIComponent;
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
async function postForm(host: string, path: string, o: Record<string, string>): Promise<Record<string, unknown>> {
  const body = form(o);
  const r = await httpsReq(host, path, 'POST', { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(body)) }, body);
  try { return JSON.parse(r.text) as Record<string, unknown>; } catch { return {}; }
}

/* ----------------------------- OAuth client config (id/secret) ----------------------------- */
// Read returns the public client id + a hasSecret flag — never the secret itself.
export async function getConfig(): Promise<{ clientId: string; hasSecret: boolean; configured: boolean }> {
  const clientId = (await keys.getSecret('sync:google_client_id')) || '';
  const hasSecret = !!(await keys.getSecret('sync:google_client_secret'));
  return { clientId, hasSecret, configured: !!clientId && hasSecret };
}
export async function setConfig(clientId: string, secret?: string): Promise<{ ok: boolean; error?: string }> {
  const cid = (clientId || '').trim();
  if (!cid) return { ok: false, error: 'Client ID is required' };
  if (typeof secret === 'string' && secret.trim()) await keys.setSecret('sync:google_client_secret', secret.trim());
  else if (!(await keys.getSecret('sync:google_client_secret'))) return { ok: false, error: 'Client secret is required' };
  await keys.setSecret('sync:google_client_id', cid);
  return { ok: true };
}
export async function isConfigured(): Promise<boolean> { return (await getConfig()).configured; }

/* ----------------------------- OAuth flow (loopback lives in main.ts) ----------------------------- */
export async function authorizeUrl(state: string): Promise<string> {
  const clientId = (await keys.getSecret('sync:google_client_id')) || '';
  const p = form({ client_id: clientId, redirect_uri: GD_REDIRECT_URI, response_type: 'code', scope: SCOPES, access_type: 'offline', prompt: 'consent', state });
  return `https://${AUTH_HOST}/o/oauth2/v2/auth?${p}`;
}

async function storeTokens(j: Record<string, unknown>): Promise<void> {
  if (j.access_token) await keys.setSecret('sync:google_oauth', String(j.access_token));
  if (j.refresh_token) await keys.setSecret('sync:google_refresh', String(j.refresh_token)); // Google omits it on refresh — keep the old one
  const ttl = Number(j.expires_in) || 3600;
  await keys.setSecret('sync:google_expires', String(Date.now() + Math.max(60, ttl - 60) * 1000));
}

// Exchange the authorization code for tokens (called by the loopback handler in main.ts). Stores the refresh
// token so future syncs work headlessly; fetches the account email for display.
export async function exchangeCode(code: string, redirectUri: string): Promise<{ ok: boolean; email?: string; error?: string }> {
  const clientId = (await keys.getSecret('sync:google_client_id')) || '';
  const secret = (await keys.getSecret('sync:google_client_secret')) || '';
  const j = await postForm(TOKEN_HOST, '/token', { code, client_id: clientId, client_secret: secret, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  if (!j.access_token) return { ok: false, error: String(j.error_description || j.error || 'Token exchange failed') };
  await storeTokens(j);
  const email = await fetchEmail(String(j.access_token));
  if (email) await keys.setSecret('sync:google_email', email);
  return { ok: true, email };
}

async function refresh(): Promise<boolean> {
  const clientId = (await keys.getSecret('sync:google_client_id')) || '';
  const secret = (await keys.getSecret('sync:google_client_secret')) || '';
  const rt = await keys.getSecret('sync:google_refresh');
  if (!rt) return false;
  const j = await postForm(TOKEN_HOST, '/token', { client_id: clientId, client_secret: secret, refresh_token: rt, grant_type: 'refresh_token' });
  if (!j.access_token) return false;
  await storeTokens(j);
  return true;
}

// A valid access token, refreshing if the stored one has expired. null if not connected / refresh failed.
async function accessToken(): Promise<string | null> {
  const token = await keys.getSecret('sync:google_oauth');
  if (!token) return null;
  const exp = Number(await keys.getSecret('sync:google_expires')) || 0;
  if (exp && Date.now() >= exp) return (await refresh()) ? keys.getSecret('sync:google_oauth') : null;
  return token;
}

async function fetchEmail(token: string): Promise<string> {
  const r = await httpsReq(API_HOST, '/oauth2/v2/userinfo', 'GET', { Authorization: `Bearer ${token}` });
  try { return String((JSON.parse(r.text) as Record<string, unknown>).email || ''); } catch { return ''; }
}

export async function authState(): Promise<{ connected: boolean; email?: string }> {
  if (!(await keys.getSecret('sync:google_oauth'))) return { connected: false };
  return { connected: true, email: (await keys.getSecret('sync:google_email')) || '' };
}
export async function disconnect(): Promise<void> {
  for (const k of ['sync:google_oauth', 'sync:google_refresh', 'sync:google_expires', 'sync:google_email']) await keys.setSecret(k, '');
}

/* ----------------------------- Drive REST (appDataFolder) ----------------------------- */
export interface DriveFileInfo { id: string; modifiedTime: string; }
const DEAD_TOKEN = 'Google Drive disconnected — reconnect';

// Authenticated Drive request with a one-shot 401 refresh-retry. accessToken() already refreshes on EXPIRY;
// a 401 here means the token was REJECTED (revoked, or expired in the gap since the check), so refresh once
// and retry. If it's still 401 the credentials are dead — clear them so authState() reports "not connected"
// and the user reconnects, instead of every sync silently failing against a connected-looking account.
async function driveFetch(method: string, pathname: string, extraHeaders: Record<string, string> = {}, body?: string): Promise<{ status: number; text: string }> {
  const token = await accessToken();
  if (!token) return { status: 401, text: '' };
  const call = (t: string) => httpsReq(API_HOST, pathname, method, { Authorization: `Bearer ${t}`, ...extraHeaders }, body);
  let r = await call(token);
  if (r.status === 401) {
    if (await refresh()) { const t2 = await keys.getSecret('sync:google_oauth'); if (t2) r = await call(t2); }
    if (r.status === 401) await disconnect();
  }
  return r;
}
const ok2xx = (s: number) => s >= 200 && s < 300;

export async function findSyncFile(): Promise<DriveFileInfo | null> {
  const path = `/drive/v3/files?spaces=appDataFolder&fields=${enc('files(id,modifiedTime)')}&q=${enc(`name='${SYNC_FILENAME}'`)}`;
  const r = await driveFetch('GET', path);
  if (!ok2xx(r.status)) return null;
  try {
    const f = ((JSON.parse(r.text) as { files?: Array<Record<string, unknown>> }).files || [])[0];
    return f ? { id: String(f.id), modifiedTime: String(f.modifiedTime || '') } : null;
  } catch { return null; }
}
// Create (first push) or overwrite the single sync file in appDataFolder with `content` (the encrypted envelope).
export async function uploadSyncFile(content: string): Promise<{ ok: boolean; modifiedTime?: string; error?: string }> {
  let id = (await findSyncFile())?.id;
  if (!id) {
    const meta = JSON.stringify({ name: SYNC_FILENAME, parents: ['appDataFolder'] });
    const cr = await driveFetch('POST', '/drive/v3/files?fields=id', { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(meta)) }, meta);
    if (!ok2xx(cr.status)) return { ok: false, error: cr.status === 401 ? DEAD_TOKEN : `Could not create the Drive file (${cr.status})` };
    try { id = String((JSON.parse(cr.text) as Record<string, unknown>).id || ''); } catch { /* fallthrough */ }
    if (!id) return { ok: false, error: 'Could not create the Drive file' };
  }
  const up = await driveFetch('PATCH', `/upload/drive/v3/files/${enc(id)}?uploadType=media&fields=${enc('id,modifiedTime')}`, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(content)) }, content);
  if (!ok2xx(up.status)) return { ok: false, error: up.status === 401 ? DEAD_TOKEN : `Drive upload failed (${up.status})` };
  try { return { ok: true, modifiedTime: String((JSON.parse(up.text) as Record<string, unknown>).modifiedTime || '') }; } catch { return { ok: true }; }
}
export async function downloadSyncFile(): Promise<{ ok: boolean; content?: string; modifiedTime?: string; missing?: boolean; error?: string }> {
  const f = await findSyncFile();
  if (!f) {
    // findSyncFile returns null both for "no backup" and for auth failure — disambiguate so a dead token isn't
    // reported as "no backup yet" (which would wrongly disable the Restore button).
    if (!(await authState()).connected) return { ok: false, error: DEAD_TOKEN };
    return { ok: false, missing: true, error: 'No sync data in Drive yet' };
  }
  const r = await driveFetch('GET', `/drive/v3/files/${enc(f.id)}?alt=media`);
  if (!ok2xx(r.status)) return { ok: false, error: r.status === 401 ? DEAD_TOKEN : `Drive download failed (${r.status})` };
  return { ok: true, content: r.text, modifiedTime: f.modifiedTime };
}
