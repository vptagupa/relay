// Echo — the reference PM provider plugin. Self-hosted; OAuth 2.1 (authorization-code + PKCE); a desk REST API
// (/api/v1) for projects + tasks. Implements PmProvider using the shared configStore / tokenStore / pmReq, so
// the provider-specific part is just: its endpoints, its request shapes, and the mapping to the normalized model.

import type { PmProvider, PmResult, PmProject, PmTask, PmRef, PmComment, ConfigField, PmTaskQuery } from './types';
import { pmReq, configStore, tokenStore, genVerifier, challenge, str, enc } from './shared';

const ID = 'echo';
const PORT = 47826;                      // fixed loopback port — Echo matches redirect_uri EXACTLY, so it can't be ephemeral
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
// tasks:write implies tasks:read; projects:read lists the projects tasks live under; offline_access earns a
// refresh token; openid/profile/email identify the user.
const SCOPES = 'openid profile email offline_access projects:read tasks:read tasks:write';

const CONFIG_FIELDS: ConfigField[] = [
  { key: 'web_host', label: 'Web host (sign-in server)', placeholder: 'https://echo.example.com', required: true, url: true, help: 'The Echo app that hosts sign-in + OAuth.' },
  { key: 'desk_host', label: 'Desk host (task API)', placeholder: 'https://desk.example.com', required: true, url: true, help: 'The Echo app that serves /api/v1 (may equal the web host).' },
  { key: 'client_id', label: 'Client ID', required: true },
  { key: 'client_secret', label: 'Client secret', secret: true, required: true },
];
const cfg = configStore(ID, CONFIG_FIELDS, REDIRECT_URI);
const tokens = tokenStore(ID);

const webHost = (ws: string) => cfg.field(ws, 'web_host').then((v) => v || '');
const deskHost = (ws: string) => cfg.field(ws, 'desk_host').then((v) => v || '');
const basicAuth = async (ws: string): Promise<string> =>
  'Basic ' + Buffer.from(`${(await cfg.field(ws, 'client_id')) || ''}:${(await cfg.field(ws, 'client_secret')) || ''}`, 'utf8').toString('base64');

// Resolve authorize/token/userinfo from RFC 8414 discovery, falling back to Better Auth's known paths.
async function endpoints(ws: string): Promise<{ authorize: string; token: string; userinfo: string }> {
  const web = await webHost(ws);
  const r = await pmReq(`${web}/.well-known/oauth-authorization-server`, 'GET', { Accept: 'application/json' });
  let d: Record<string, unknown> = {};
  try { d = JSON.parse(r.text) as Record<string, unknown>; } catch { /* fall back */ }
  return {
    authorize: str(d.authorization_endpoint) || `${web}/api/auth/oauth2/authorize`,
    token: str(d.token_endpoint) || `${web}/api/auth/oauth2/token`,
    userinfo: str(d.userinfo_endpoint) || `${web}/api/auth/oauth2/userinfo`,
  };
}

// Coalesce concurrent refreshes per workspace: when several Echo calls hit an expired token at once, they must
// trigger ONE refresh grant, not a stampede — with one-time-use rotating refresh tokens a stampede would race and
// self-revoke. Callers share the single in-flight promise; it's cleared when it settles.
const refreshInFlight = new Map<string, Promise<boolean>>();
function refresh(ws: string): Promise<boolean> {
  const existing = refreshInFlight.get(ws);
  if (existing) return existing;
  const p = doRefresh(ws).finally(() => refreshInFlight.delete(ws));
  refreshInFlight.set(ws, p);
  return p;
}
async function doRefresh(ws: string): Promise<boolean> {
  const rt = await tokens.refreshToken(ws);
  if (!rt) return false;
  const { token } = await endpoints(ws);
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt }).toString();
  const r = await pmReq(token, 'POST', { Authorization: await basicAuth(ws), 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(body)), Accept: 'application/json' }, body);
  let j: Record<string, unknown> = {};
  try { j = JSON.parse(r.text) as Record<string, unknown>; } catch { /* */ }
  if (j.access_token) { await tokens.store(ws, j); return true; }
  // A 4xx from the token endpoint means the grant is DEAD (invalid_grant = refresh token expired/revoked,
  // invalid_client = the app's access was revoked) → clear so authState reports disconnected and the user is
  // prompted to re-auth. A network error/timeout (status 0) or a 5xx is transient — KEEP the tokens so a blip
  // never signs the user out; the next call retries the refresh. This makes `refresh` the single authority on
  // when the grant is truly gone, so no other layer has to guess.
  if (r.status >= 400 && r.status < 500) await tokens.clear(ws);
  return false;
}

async function fetchUser(ws: string, token: string): Promise<string> {
  const { userinfo } = await endpoints(ws);
  const r = await pmReq(userinfo, 'GET', { Authorization: `Bearer ${token}`, Accept: 'application/json' });
  try { const j = JSON.parse(r.text) as Record<string, unknown>; return str(j.email) || str(j.name) || str(j.preferred_username) || ''; } catch { return ''; }
}

// Authenticated desk request with a one-shot 401 refresh-retry; a still-401 means the grant is dead → disconnect.
async function apiFetch<T = unknown>(ws: string, method: string, path: string, body?: unknown): Promise<PmResult<T>> {
  const desk = await deskHost(ws);
  if (!desk) return { ok: false, status: 0, error: 'Echo is not configured', code: 'CONFIG' };
  const token = await tokens.access(ws, () => refresh(ws));
  if (!token) return { ok: false, status: 401, error: 'Not connected to Echo', code: 'UNAUTHORIZED' };
  const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
  const hdr = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}`, Accept: 'application/json', ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(bodyStr)) } : {}) });
  let r = await pmReq(desk + path, method, hdr(token), bodyStr);
  if (r.status === 401) {
    // One-shot refresh + retry. `refresh` already clears the tokens if the grant is dead (a 4xx from the token
    // endpoint) and keeps them on a transient failure, so we only clear HERE for the remaining case: a freshly
    // refreshed token that STILL 401s (an audience/scope/config mismatch the user must resolve by re-connecting).
    if (await refresh(ws)) {
      const t2 = await tokens.token(ws);
      if (t2) r = await pmReq(desk + path, method, hdr(t2), bodyStr);
      if (r.status === 401) await tokens.clear(ws);
    }
  }
  let j: Record<string, unknown> | null = null;
  try { j = JSON.parse(r.text) as Record<string, unknown>; } catch { /* non-JSON */ }
  if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status, data: j?.data as T };
  const e = (j?.error as Record<string, unknown>) || {};
  return { ok: false, status: r.status, error: str(e.message) || `Request failed (${r.status})`, code: str(e.code) || undefined };
}

// --- normalized mappers (Echo API shapes → PmProject / PmTask / PmRef) ---
const toProject = (p: Record<string, unknown>): PmProject => ({ id: str(p.id), title: str(p.title) || str(p.id), subtitle: str(p.project_type) || undefined });
const toTask = (t: Record<string, unknown>): PmTask => ({
  id: str(t.id), key: str(t.task_key) || str(t.id), title: str(t.title),
  status: str(t.status) || undefined, priority: str(t.priority) || undefined,
  assignee: str(t.assignee_email) || undefined, deadline: str(t.deadline) || undefined,
  url: undefined, description: str(t.description) || undefined,
});
const toRef = (r: Record<string, unknown>): PmRef => ({ id: str(r.id), title: str(r.title) || str(r.name) || str(r.display_name) || str(r.email) });
const toComment = (c: Record<string, unknown>): PmComment => ({ id: str(c.id), author: str(c.author_email) || undefined, body: str(c.body), at: str(c.created_at) || undefined });
const arr = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? (x as Record<string, unknown>[]) : []);
// Re-type an error result to the caller's data shape (data is absent on failure, so this is safe).
const failed = <T>(r: PmResult<unknown>): PmResult<T> => ({ ok: false, status: r.status, error: r.error, code: r.code });

export const echo: PmProvider = {
  id: ID, name: 'Echo', icon: '🛰️', containerLabel: 'Project',
  configFields: CONFIG_FIELDS,
  capabilities: {
    createTask: true,
    editFields: [
      { key: 'status', label: 'Status', control: 'select', optionsRef: 'task-statuses' },
      { key: 'priority', label: 'Priority', control: 'select', optionsRef: 'task-priorities' },
      { key: 'title', label: 'Title', control: 'text' },
    ],
    references: ['task-statuses', 'task-priorities', 'members'],
    filters: [
      { key: 'query', label: 'Search', control: 'text', placeholder: 'Search title…' },
      { key: 'status', label: 'Status', control: 'select', optionsRef: 'task-statuses' },
      { key: 'assignee', label: 'Assignee', control: 'select', optionsRef: 'members' },
    ],
    paginated: true,
    canComment: true, // POST /api/v1/tasks/{id}/comments — see postComment
  },
  auth: {
    kind: 'oauth-pkce', port: PORT, redirectUri: REDIRECT_URI,
    scopesNote: `Register an OAuth app at <web>/integrations/oauth-apps with redirect ${REDIRECT_URI} and scopes: ${SCOPES}`,
    getConfig: (ws) => cfg.get(ws),
    setConfig: (ws, values) => cfg.set(ws, values),
    async authorizeUrl(ws, state, codeChallenge) {
      const { authorize } = await endpoints(ws);
      const p = new URLSearchParams({ response_type: 'code', client_id: (await cfg.field(ws, 'client_id')) || '', redirect_uri: REDIRECT_URI, scope: SCOPES, state, code_challenge: codeChallenge || '', code_challenge_method: 'S256' });
      return authorize + (authorize.includes('?') ? '&' : '?') + p.toString();
    },
    async exchangeCode(ws, code, verifier, redirectUri) {
      const { token } = await endpoints(ws);
      const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }).toString();
      const r = await pmReq(token, 'POST', { Authorization: await basicAuth(ws), 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(body)), Accept: 'application/json' }, body);
      let j: Record<string, unknown> = {};
      try { j = JSON.parse(r.text) as Record<string, unknown>; } catch { /* */ }
      if (!j.access_token) return { ok: false, error: str(j.error_description) || str(j.error) || `Token exchange failed (${r.status})` };
      await tokens.store(ws, j);
      const account = await fetchUser(ws, str(j.access_token));
      if (account) await tokens.setAccount(ws, account);
      return { ok: true, account };
    },
    async authState(ws) {
      if (!(await tokens.token(ws))) return { connected: false };
      return { connected: true, account: (await tokens.account(ws)) || '' };
    },
    disconnect: (ws) => tokens.clear(ws),
  },
  async projects(ws) { const r = await apiFetch<Record<string, unknown>[]>(ws, 'GET', '/api/v1/projects'); return r.ok ? { ok: true, status: r.status, data: arr(r.data).map(toProject) } : failed<PmProject[]>(r); },
  async tasks(ws, projectId, query?: PmTaskQuery) {
    // Map the generic filter/pagination values onto Echo's task-list query params (assignee/status/query/limit/offset).
    const p = new URLSearchParams();
    const f = query?.filters || {};
    for (const k of ['status', 'assignee', 'query'] as const) if (f[k]) p.set(k, f[k]);
    if (query?.limit != null) p.set('limit', String(query.limit));
    if (query?.offset) p.set('offset', String(query.offset));
    const qs = p.toString();
    const r = await apiFetch<Record<string, unknown>[]>(ws, 'GET', `/api/v1/projects/${enc(projectId)}/tasks${qs ? '?' + qs : ''}`);
    return r.ok ? { ok: true, status: r.status, data: arr(r.data).map(toTask) } : failed<PmTask[]>(r);
  },
  async taskDetail(ws, idOrKey) { const r = await apiFetch<Record<string, unknown>>(ws, 'GET', `/api/v1/tasks/${enc(idOrKey)}`); return r.ok && r.data ? { ok: true, status: r.status, data: toTask(r.data) } : failed<PmTask>(r); },
  async createTask(ws, projectId, body) { const r = await apiFetch<Record<string, unknown>>(ws, 'POST', `/api/v1/projects/${enc(projectId)}/tasks`, body); return r.ok && r.data ? { ok: true, status: r.status, data: { id: str(r.data.id), key: str(r.data.task_key) || str(r.data.id) } } : failed<{ id: string; key: string }>(r); },
  async updateTask(ws, idOrKey, patch) { const r = await apiFetch<Record<string, unknown>>(ws, 'PATCH', `/api/v1/tasks/${enc(idOrKey)}`, patch); return r.ok && r.data ? { ok: true, status: r.status, data: { id: str(r.data.id), key: str(r.data.task_key) || str(r.data.id) } } : failed<{ id: string; key: string }>(r); },
  async reference(ws, name) { const r = await apiFetch<Record<string, unknown>[]>(ws, 'GET', `/api/v1/reference/${enc(name)}`); return r.ok ? { ok: true, status: r.status, data: arr(r.data).map(toRef) } : failed<PmRef[]>(r); },
  // Post a comment on the task's thread — REST: POST /api/v1/tasks/{idOrKey}/comments with { body } (scope
  // tasks:write). @mentions notify and updated_at bumps, same as the UI. Goes through apiFetch (Bearer token +
  // 401-refresh + Echo error parsing) like every other call.
  postComment(ws, idOrKey, body) { return apiFetch(ws, 'POST', `/api/v1/tasks/${enc(idOrKey)}/comments`, { body }); },
  // Read the thread (oldest-first), for the hover preview / detail view. Same Bearer + 401-refresh path.
  async listComments(ws, idOrKey) { const r = await apiFetch<Record<string, unknown>[]>(ws, 'GET', `/api/v1/tasks/${enc(idOrKey)}/comments?limit=100`); return r.ok ? { ok: true, status: r.status, data: arr(r.data).map(toComment) } : failed<PmComment[]>(r); },
};
