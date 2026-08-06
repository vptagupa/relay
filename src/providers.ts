// Git provider adapters (MAIN-PROCESS ONLY) — GitHub / GitLab / Bitbucket behind one small registry.
// Each adapter speaks its own REST API using an app-owned token encrypted in the OS keychain (keys.ts);
// the renderer never sees a token, only { connected, login } + normalized issues / repos / PRs. Adding a
// provider is one entry in PROVIDERS (Open/Closed) — the generic IPC handlers in main.ts don't change.
//
// Auth model per provider:
//  • GitHub    — OAuth device-flow token ('github_oauth'), Bearer.        (connect handled in main.ts)
//  • GitLab    — Personal Access Token ('gitlab_pat'), PRIVATE-TOKEN header; custom host in 'gitlab_host'.
//  • Bitbucket — OAuth 2.0 authorization-code + loopback redirect (Bitbucket Cloud has NO device flow and
//                NO PKCE, so a confidential consumer secret ships in the app — an accepted "public secret").
//                Access token 'bitbucket_oauth' (Bearer), refresh 'bitbucket_refresh', expiry 'bitbucket_expires'
//                (epoch ms). Access tokens live ~2h, so we auto-refresh. The loopback dance lives in main.ts;
//                token exchange + refresh live here. (App passwords were removed by Atlassian on 2026-07-28.)
import * as https from 'node:https';
import * as keys from './keys';
import type { Issue } from './shared/types';

export type ProviderId = 'github' | 'gitlab' | 'bitbucket';
export type IssueState = 'open' | 'closed'; // which issues to pull; default 'open'
export const PROVIDER_IDS: ProviderId[] = ['github', 'gitlab', 'bitbucket'];
const isProvider = (s: unknown): s is ProviderId => typeof s === 'string' && (PROVIDER_IDS as string[]).includes(s);

export interface RepoRow { repo: string; desc: string; priv: boolean; }
export interface RepoListOpts { workspaces?: string[]; } // Bitbucket lists per workspace (CHANGE-2770); others ignore this
export interface PrRow { number: number; branch: string; url: string; draft: boolean; }
interface ApiResult { ok: boolean; status: number; json: unknown; }

// A minimal HTTPS request that resolves to { status, text } and never rejects. A 20s timeout guards the
// panel/poll from a hung connection. Exported for main.ts's GitHub device-flow handlers.
export function httpsReq(host: string, pathname: string, method: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { status: number; text: string }) => { if (!done) { done = true; resolve(v); } };
    const req = https.request({ host, path: pathname, method, headers: { 'User-Agent': 'SlayerT', ...headers }, timeout: 20000 }, (res) => {
      let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => finish({ status: res.statusCode || 0, text: data }));
    });
    req.on('error', () => finish({ status: 0, text: '' }));
    req.on('timeout', () => { req.destroy(); finish({ status: 0, text: '' }); });
    if (body) req.write(body);
    req.end();
  });
}
// A GET that resolves to { ok, status, json }; ok = 2xx and body parsed. Never rejects.
async function apiGet(host: string, pathname: string, headers: Record<string, string>): Promise<ApiResult> {
  const r = await httpsReq(host, pathname, 'GET', headers);
  let json: unknown = null; try { json = JSON.parse(r.text); } catch { /* non-json error body */ }
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json };
}
const asObj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? x as Record<string, unknown> : {});
const asArr = (x: unknown): Array<Record<string, unknown>> => (Array.isArray(x) ? x as Array<Record<string, unknown>> : []);
const str = (x: unknown): string => (x == null ? '' : String(x));

/* ============================== GitHub ============================== */
async function ghHeaders(): Promise<Record<string, string> | null> {
  const token = await keys.getSecret('github_oauth');
  return token ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } : null;
}
async function ghApi(pathname: string): Promise<ApiResult> {
  const h = await ghHeaders(); if (!h) return { ok: false, status: 401, json: null };
  return apiGet('api.github.com', pathname, h);
}
const github = {
  async authState(): Promise<{ connected: boolean; login?: string }> {
    const h = await ghHeaders(); if (!h) return { connected: false };
    const who = await ghApi('/user');
    if (who.status === 401) return { connected: false };   // ONLY a real 401 means the token is revoked
    return { connected: true, login: str(asObj(who.json).login) };
  },
  async issues(repo: string, state: IssueState = 'open'): Promise<{ ok: boolean; issues?: Issue[]; error?: string }> {
    const raw: Array<Record<string, unknown>> = [];
    for (let page = 1; page <= 4; page++) {
      const r = await ghApi(`/repos/${repo}/issues?state=${state === 'closed' ? 'closed' : 'open'}&per_page=100&page=${page}`);
      if (!r.ok || !Array.isArray(r.json)) {
        if (page > 1) break;
        const msg = str(asObj(r.json).message);
        if (r.status === 401) return { ok: false, error: 'Not connected — reconnect GitHub in Sources.' };
        if (r.status === 403 || r.status === 404) return { ok: false, error: `${msg || 'No access'} (HTTP ${r.status}). If this repo is in an organization, an org owner may need to approve the Slayer T OAuth app (Org → Settings → Third-party Access).` };
        return { ok: false, error: `${msg || 'Could not pull issues'} (HTTP ${r.status})` };
      }
      const arr = asArr(r.json); raw.push(...arr);
      if (arr.length < 100) break;
    }
    const issues: Issue[] = raw.filter((i) => !i.pull_request).map((i) => ({
      number: Number(i.number) || 0, title: str(i.title), body: str(i.body), state: str(i.state) || 'open', url: str(i.html_url),
      labels: asArr(i.labels).map((l) => ({ name: str(l.name), color: l.color ? str(l.color) : undefined })),
      assignees: asArr(i.assignees).map((a) => str(a.login)).filter(Boolean),
      author: str(asObj(i.user).login) || undefined,
      milestone: i.milestone ? str(asObj(i.milestone).title) || undefined : undefined,
    }));
    return { ok: true, issues };
  },
  async repos(): Promise<{ ok: boolean; repos?: RepoRow[]; error?: string }> {
    const r = await ghApi('/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member');
    if (!r.ok || !Array.isArray(r.json)) return { ok: false, error: r.status === 401 ? 'Not connected to GitHub' : 'Could not list repos' };
    const repos = asArr(r.json).map((x) => ({ repo: str(x.full_name), desc: str(x.description), priv: !!x.private })).filter((x) => /^[\w.-]+\/[\w.-]+$/.test(x.repo));
    return { ok: true, repos };
  },
  async prs(repo: string): Promise<{ ok: boolean; prs?: PrRow[]; error?: string }> {
    const r = await ghApi(`/repos/${repo}/pulls?state=open&per_page=100`);
    if (!r.ok || !Array.isArray(r.json)) return { ok: false, error: 'Could not list PRs' };
    const prs = asArr(r.json).map((p) => ({ number: Number(p.number) || 0, branch: str(asObj(p.head).ref), url: str(p.html_url), draft: !!p.draft })).filter((p) => p.branch);
    return { ok: true, prs };
  },
  repoFromRemote: (url: string): string | null => {
    const m = url.trim().match(/github\.com[:/]([^\s]+?)(?:\.git)?\/?$/i);
    return m && /^[\w.-]+\/[\w.-]+$/.test(m[1]) ? m[1] : null;
  },
  async cloneUrl(repo: string): Promise<string> { return `https://github.com/${repo}.git`; },
  cli: 'gh',
  cliCloneArgs: (repo: string, dest: string): string[] => ['repo', 'clone', repo, dest],
  // A token connect isn't used for GitHub (device flow lives in main.ts), but keep the shape uniform.
  async connect(token: string): Promise<{ ok: boolean; login?: string; error?: string }> {
    await keys.setSecret('github_oauth', token);
    const s = await github.authState();
    return s.connected ? { ok: true, login: s.login } : { ok: false, error: 'Token rejected' };
  },
  async disconnect(): Promise<void> { await keys.setSecret('github_oauth', ''); },
};

/* ============================== GitLab ============================== */
async function glHost(): Promise<string> { return (await keys.getSecret('gitlab_host')) || 'gitlab.com'; }
async function glHeaders(): Promise<Record<string, string> | null> {
  const token = await keys.getSecret('gitlab_pat');
  return token ? { 'PRIVATE-TOKEN': token } : null;
}
async function glApi(pathname: string): Promise<ApiResult> {
  const h = await glHeaders(); if (!h) return { ok: false, status: 401, json: null };
  return apiGet(await glHost(), `/api/v4${pathname}`, h);
}
const enc = (repo: string) => encodeURIComponent(repo); // GitLab wants the project path URL-encoded
const gitlab = {
  async authState(): Promise<{ connected: boolean; login?: string }> {
    const h = await glHeaders(); if (!h) return { connected: false };
    const who = await glApi('/user');
    if (who.status === 401) return { connected: false };
    return { connected: true, login: str(asObj(who.json).username) };
  },
  async issues(repo: string, state: IssueState = 'open'): Promise<{ ok: boolean; issues?: Issue[]; error?: string }> {
    const raw: Array<Record<string, unknown>> = [];
    for (let page = 1; page <= 4; page++) {
      const r = await glApi(`/projects/${enc(repo)}/issues?state=${state === 'closed' ? 'closed' : 'opened'}&per_page=100&page=${page}`);
      if (!r.ok || !Array.isArray(r.json)) {
        if (page > 1) break;
        const msg = str(asObj(r.json).message || asObj(r.json).error);
        if (r.status === 401) return { ok: false, error: 'Not connected — reconnect GitLab in Sources.' };
        return { ok: false, error: `${msg || 'Could not pull issues'} (HTTP ${r.status})` };
      }
      const arr = asArr(r.json); raw.push(...arr);
      if (arr.length < 100) break;
    }
    // GitLab numbers issues by project-internal iid (that's what URLs and "Closes #iid" use, not id).
    const issues: Issue[] = raw.map((i) => ({
      number: Number(i.iid) || 0, title: str(i.title), body: str(i.description), state: str(i.state) || 'opened', url: str(i.web_url),
      labels: (Array.isArray(i.labels) ? i.labels as unknown[] : []).map((l) => ({ name: str(l), color: undefined })),
      assignees: asArr(i.assignees).map((a) => str(a.username)).filter(Boolean),
      author: str(asObj(i.author).username) || undefined,
      milestone: i.milestone ? str(asObj(i.milestone).title) || undefined : undefined,
    }));
    return { ok: true, issues };
  },
  async repos(): Promise<{ ok: boolean; repos?: RepoRow[]; error?: string }> {
    const r = await glApi('/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at&archived=false');
    if (!r.ok || !Array.isArray(r.json)) return { ok: false, error: r.status === 401 ? 'Not connected to GitLab' : 'Could not list projects' };
    const repos = asArr(r.json).map((x) => ({ repo: str(x.path_with_namespace), desc: str(x.description), priv: str(x.visibility) !== 'public' })).filter((x) => x.repo.includes('/'));
    return { ok: true, repos };
  },
  async prs(repo: string): Promise<{ ok: boolean; prs?: PrRow[]; error?: string }> {
    const r = await glApi(`/projects/${enc(repo)}/merge_requests?state=opened&per_page=100`);
    if (!r.ok || !Array.isArray(r.json)) return { ok: false, error: 'Could not list merge requests' };
    const prs = asArr(r.json).map((m) => ({ number: Number(m.iid) || 0, branch: str(m.source_branch), url: str(m.web_url), draft: !!m.draft || !!m.work_in_progress })).filter((p) => p.branch);
    return { ok: true, prs };
  },
  repoFromRemote(url: string): string | null {
    // gitlab.com or a self-managed host (matched loosely by "gitlab" in the hostname).
    const m = url.trim().match(/(?:@|https?:\/\/)([^/:]*gitlab[^/:]*)[:/](.+?)(?:\.git)?\/?$/i);
    return m && m[2].includes('/') ? m[2] : null;
  },
  async cloneUrl(repo: string): Promise<string> { return `https://${await glHost()}/${repo}.git`; },
  cli: 'glab',
  cliCloneArgs: (repo: string, dest: string): string[] => ['repo', 'clone', repo, dest],
  async connect(token: string, host?: string): Promise<{ ok: boolean; login?: string; error?: string }> {
    await keys.setSecret('gitlab_host', (host || 'gitlab.com').replace(/^https?:\/\//, '').replace(/\/+$/, ''));
    await keys.setSecret('gitlab_pat', token);
    const s = await gitlab.authState();
    return s.connected ? { ok: true, login: s.login } : { ok: false, error: 'Token rejected — check the PAT scope (read_api) and host' };
  },
  async disconnect(): Promise<void> { await keys.setSecret('gitlab_pat', ''); },
};

/* ============================== Bitbucket ============================== */
// Bitbucket Cloud OAuth 2.0 consumer (CONFIDENTIAL). Bitbucket Cloud offers neither the device flow nor
// PKCE, so the authorization-code grant needs a client secret. Rather than bake it into the binary, the
// consumer Key + Secret are supplied ONCE in the app and stored encrypted in the OS keychain (via the
// generic OAuth-app config below) — nothing sensitive lives in source or git. Create the consumer at
// Bitbucket → Workspace settings → OAuth consumers|clients with callback http://localhost and permissions
// Account/Repositories/Issues/Pull requests → Read, then paste its Key/Secret in the Connect dialog.
//
// REDIRECT: Atlassian's identity server (id.atlassian.com) matches the redirect_uri BYTE-FOR-BYTE against the
// registered callback and does NOT allow an arbitrary loopback port — and its form won't register a portful
// localhost. So we register the bare `http://localhost` and listen on its default port (80), sending exactly
// that as redirect_uri. The auth code arrives as a query on the root path (handled path-agnostically in main).
export const BB_OAUTH_PORT = 80;                                     // default port for http://localhost
export const BB_REDIRECT_URI = 'http://localhost';                  // MUST equal the registered callback exactly
const bbClientId = () => keys.getSecret('bitbucket_client_id');
const bbClientSecret = () => keys.getSecret('bitbucket_client_secret');
export const bbOAuthConfigured = async (): Promise<boolean> => !!(await bbClientId()) && !!(await bbClientSecret());
export async function bitbucketAuthorizeUrl(state: string): Promise<string> {
  const id = (await bbClientId()) || '';
  return `https://bitbucket.org/site/oauth2/authorize?client_id=${encodeURIComponent(id)}&response_type=code&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(BB_REDIRECT_URI)}`;
}

// POST the Bitbucket token endpoint (Basic client_id:secret). On success, persist access + refresh + a
// pre-expiry deadline (renew 60s early). Returns the HTTP status so callers can tell a revoked grant
// (4xx → clear) from a network blip (status 0 → keep the tokens and retry later).
async function bbTokenRequest(body: string): Promise<{ ok: boolean; status: number; error?: string }> {
  const id = await bbClientId(); const secret = await bbClientSecret();
  if (!id || !secret) return { ok: false, status: 0, error: 'Bitbucket OAuth app is not configured' };
  const auth = 'Basic ' + Buffer.from(`${id}:${secret}`, 'utf8').toString('base64');
  const r = await httpsReq('bitbucket.org', '/site/oauth2/access_token', 'POST',
    { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body);
  let j: Record<string, unknown> = {}; try { j = JSON.parse(r.text) as Record<string, unknown>; } catch { /* non-json */ }
  if (j.access_token) {
    await keys.setSecret('bitbucket_oauth', String(j.access_token));
    if (j.refresh_token) await keys.setSecret('bitbucket_refresh', String(j.refresh_token)); // a refresh keeps the old one if none returned
    const ttl = Number(j.expires_in) || 7200;                        // Bitbucket access tokens live ~2h
    await keys.setSecret('bitbucket_expires', String(Date.now() + Math.max(60, ttl - 60) * 1000));
    return { ok: true, status: r.status };
  }
  return { ok: false, status: r.status, error: String(j.error_description || j.error || `token request failed (HTTP ${r.status})`) };
}

// Exchange an authorization code for tokens (called by the main-process loopback handler after the browser
// callback). redirectUri MUST equal the one sent to /authorize.
export async function bitbucketExchangeCode(code: string, redirectUri: string): Promise<{ ok: boolean; login?: string; error?: string }> {
  const t = await bbTokenRequest(`grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirectUri)}`);
  if (!t.ok) return { ok: false, error: t.error };
  const s = await bitbucket.authState();
  return s.connected ? { ok: true, login: s.login } : { ok: false, error: 'Authorized, but the token was rejected' };
}

// Refresh the access token, coalescing concurrent callers onto one in-flight request. A 4xx means the
// refresh token is dead (revoked/expired) → disconnect so authState reports a clean "not connected"
// instead of looping; a network failure (status 0) leaves the tokens for the next attempt.
let bbRefreshInFlight: Promise<boolean> | null = null;
async function bbRefresh(): Promise<boolean> {
  if (bbRefreshInFlight) return bbRefreshInFlight;
  bbRefreshInFlight = (async () => {
    const refresh = await keys.getSecret('bitbucket_refresh');
    if (!refresh) return false;
    const r = await bbTokenRequest(`grant_type=refresh_token&refresh_token=${encodeURIComponent(refresh)}`);
    if (!r.ok && r.status >= 400 && r.status < 500) await bitbucket.disconnect();
    return r.ok;
  })().finally(() => { bbRefreshInFlight = null; });
  return bbRefreshInFlight;
}
// The current access token, proactively refreshed once it's within the pre-expiry window.
async function bbAccessToken(): Promise<string | null> {
  const token = await keys.getSecret('bitbucket_oauth');
  if (!token) return null;
  const exp = Number(await keys.getSecret('bitbucket_expires')) || 0;
  if (exp && Date.now() >= exp) { await bbRefresh(); return keys.getSecret('bitbucket_oauth'); }
  return token;
}
async function bbHeaders(): Promise<Record<string, string> | null> {
  const token = await bbAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : null;
}
async function bbApi(pathname: string): Promise<ApiResult> {
  let h = await bbHeaders(); if (!h) return { ok: false, status: 401, json: null };
  let r = await apiGet('api.bitbucket.org', pathname, h);
  if (r.status === 401) {                                            // token went stale early — force one refresh + retry
    if (await bbRefresh()) { h = await bbHeaders(); if (h) r = await apiGet('api.bitbucket.org', pathname, h); }
  }
  return r;
}
const OPEN_BB = new Set(['new', 'open']); // Bitbucket issue states that count as "open"
const bitbucket = {
  async authState(): Promise<{ connected: boolean; login?: string }> {
    const h = await bbHeaders(); if (!h) return { connected: false };
    const who = await bbApi('/2.0/user');
    if (who.status === 401 || who.status === 403) return { connected: false };
    const u = asObj(who.json);
    return { connected: true, login: str(u.nickname || u.username || u.display_name) };
  },
  async issues(repo: string, state: IssueState = 'open'): Promise<{ ok: boolean; issues?: Issue[]; error?: string }> {
    const raw: Array<Record<string, unknown>> = [];
    for (let page = 1; page <= 4; page++) {
      const r = await bbApi(`/2.0/repositories/${repo}/issues?pagelen=50&page=${page}&sort=-updated_on`);
      if (!r.ok || !Array.isArray(asObj(r.json).values)) {
        if (page > 1) break;
        const msg = str(asObj(r.json).error && asObj(asObj(r.json).error).message);
        if (r.status === 401 || r.status === 403) return { ok: false, error: 'Not connected — reconnect Bitbucket in Sources.' };
        if (r.status === 404) return { ok: false, error: 'No issue tracker on this repo (Bitbucket repos ship with it disabled — enable it in repo Settings, or the project uses Jira).' };
        return { ok: false, error: `${msg || 'Could not pull issues'} (HTTP ${r.status})` };
      }
      const arr = asArr(asObj(r.json).values); raw.push(...arr);
      if (arr.length < 50) break;
    }
    // Bitbucket has no state= query param, so filter the fetched page client-side: open = new/open, closed = the rest.
    const issues: Issue[] = raw.filter((i) => (state === 'closed') !== OPEN_BB.has(str(i.state))).map((i) => {
      const links = asObj(asObj(i.links).html);
      const assignee = asObj(i.assignee);
      const reporter = asObj(i.reporter);
      const kind = str(i.kind); // bug/enhancement/proposal/task — surfaced as a pseudo-label (Bitbucket has no labels)
      return {
        number: Number(i.id) || 0, title: str(i.title), body: str(asObj(i.content).raw), state: str(i.state) || 'open', url: str(links.href),
        labels: kind ? [{ name: kind, color: undefined }] : [],
        assignees: assignee.nickname || assignee.display_name ? [str(assignee.nickname || assignee.display_name)] : [],
        author: str(reporter.nickname || reporter.display_name) || undefined,
        milestone: i.milestone ? str(asObj(i.milestone).name) || undefined : undefined,
      };
    });
    return { ok: true, issues };
  },
  // CHANGE-2770 (2026-04-14): Atlassian PERMANENTLY REMOVED every cross-workspace listing —
  // GET /2.0/repositories, GET /2.0/workspaces, and GET /2.0/user/permissions/workspaces all return HTTP 410
  // now, so the API can no longer discover which workspaces a user belongs to. The only surviving path is the
  // per-workspace list GET /2.0/repositories/{workspace}, so the user supplies their workspace ids (opts.workspaces)
  // and we list each. A workspace that errors is skipped; its error surfaces only if nothing loaded at all.
  async repos(opts?: RepoListOpts): Promise<{ ok: boolean; repos?: RepoRow[]; error?: string }> {
    const workspaces = (opts?.workspaces || []).map((w) => w.trim()).filter(Boolean);
    if (!workspaces.length) return { ok: false, error: 'Add your Bitbucket workspace first (the “workspace” in bitbucket.org/<workspace>/<repo>). Atlassian removed cross-workspace repo discovery (CHANGE-2770), so repos are listed per workspace.' };
    const out: RepoRow[] = [];
    let lastErr = '';
    for (const ws of workspaces) {
      for (let page = 1; page <= 4; page++) {
        const r = await bbApi(`/2.0/repositories/${encodeURIComponent(ws)}?role=member&pagelen=100&page=${page}&sort=-updated_on`);
        if (!r.ok || !Array.isArray(asObj(r.json).values)) {
          if (page > 1) break;
          const msg = str(asObj(asObj(r.json).error).message);
          if (r.status === 401) return { ok: false, error: 'Not connected — reconnect Bitbucket in Sources.' };
          lastErr = r.status === 404
            ? `Workspace “${ws}” not found (HTTP 404) — check the exact workspace id (bitbucket.org/<workspace>).`
            : r.status === 403
              ? `No access to “${ws}” (HTTP 403)${msg ? ' — ' + msg : ''}. Ensure the OAuth client has Repositories → Read.`
              : `${msg || 'Could not list repositories'} for “${ws}” (HTTP ${r.status})`;
          break;
        }
        const arr = asArr(asObj(r.json).values);
        for (const x of arr) out.push({ repo: str(x.full_name), desc: str(x.description), priv: !!x.is_private });
        if (arr.length < 100) break;
      }
    }
    if (!out.length && lastErr) return { ok: false, error: lastErr };
    return { ok: true, repos: out.filter((x) => x.repo.includes('/')) };
  },
  async prs(repo: string): Promise<{ ok: boolean; prs?: PrRow[]; error?: string }> {
    const r = await bbApi(`/2.0/repositories/${repo}/pullrequests?state=OPEN&pagelen=50`);
    if (!r.ok || !Array.isArray(asObj(r.json).values)) {
      const msg = str(asObj(asObj(r.json).error).message);
      return { ok: false, error: `${msg || 'Could not list pull requests'} (HTTP ${r.status})` };
    }
    const prs = asArr(asObj(r.json).values).map((p) => ({
      number: Number(p.id) || 0, branch: str(asObj(asObj(p.source).branch).name), url: str(asObj(asObj(p.links).html).href), draft: false,
    })).filter((p) => p.branch);
    return { ok: true, prs };
  },
  repoFromRemote(url: string): string | null {
    const m = url.trim().match(/bitbucket\.org[:/](.+?)(?:\.git)?\/?$/i);
    return m && m[1].includes('/') ? m[1] : null;
  },
  async cloneUrl(repo: string): Promise<string> { return `https://bitbucket.org/${repo}.git`; },
  cli: undefined as string | undefined, // no ubiquitous first-party CLI — clone via git + the OS credential helper
  cliCloneArgs: undefined as ((repo: string, dest: string) => string[]) | undefined,
  // Bitbucket connects through the browser (OAuth loopback in main.ts), not a pasted token. This exists to
  // honor the Adapter contract; the generic provider:connect IPC routes here only if something calls it.
  async connect(): Promise<{ ok: boolean; login?: string; error?: string }> {
    return { ok: false, error: 'Bitbucket connects in your browser — use "Connect Bitbucket".' };
  },
  async disconnect(): Promise<void> {
    await keys.setSecret('bitbucket_oauth', '');
    await keys.setSecret('bitbucket_refresh', '');
    await keys.setSecret('bitbucket_expires', '');
    await keys.setSecret('bitbucket_pat', '');   // clear any legacy app-password too
  },
};

/* ============================== registry ============================== */
export interface Adapter {
  authState(): Promise<{ connected: boolean; login?: string }>;
  issues(repo: string, state?: IssueState): Promise<{ ok: boolean; issues?: Issue[]; error?: string }>;
  repos(opts?: RepoListOpts): Promise<{ ok: boolean; repos?: RepoRow[]; error?: string }>;
  prs(repo: string): Promise<{ ok: boolean; prs?: PrRow[]; error?: string }>;
  repoFromRemote(url: string): string | null;
  cloneUrl(repo: string): Promise<string>;
  cli?: string;
  cliCloneArgs?: (repo: string, dest: string) => string[];
  connect(token: string, host?: string): Promise<{ ok: boolean; login?: string; error?: string }>;
  disconnect(): Promise<void>;
}
export const PROVIDERS: Record<ProviderId, Adapter> = { github, gitlab, bitbucket };
export const providerOf = (id: unknown): Adapter | null => (isProvider(id) ? PROVIDERS[id] : null);

// Which provider (and native repo id) does a git remote URL belong to? Used to infer the active repo
// from the open folder. Tries each adapter's matcher.
export function providerFromRemote(url: string): { provider: ProviderId; repo: string } | null {
  for (const id of PROVIDER_IDS) { const repo = PROVIDERS[id].repoFromRemote(url); if (repo) return { provider: id, repo }; }
  return null;
}

/* ============================== OAuth-app config (runtime, encrypted) ==============================
// The OAuth *app* credentials a provider needs to start its login flow live in the OS keychain, entered
// once in-app — never hardcoded in source. GitHub's device flow needs only a public client id; Bitbucket's
// authorization-code flow needs a client id + secret. Stored under `<provider>_client_id` / `_client_secret`.
// The secret is write-only across the IPC boundary: getOAuthApp returns the (public) client id + a hasSecret
// flag, never the secret itself. */
interface OAuthAppNeed { needsSecret: boolean; }
const OAUTH_APP: Partial<Record<ProviderId, OAuthAppNeed>> = { github: { needsSecret: false }, bitbucket: { needsSecret: true } };
export const providerNeedsOAuthApp = (id: ProviderId): boolean => id in OAUTH_APP;
export interface OAuthAppState { clientId: string; hasSecret: boolean; needsSecret: boolean; configured: boolean; }
// Read the stored OAuth-app config for a provider (null if the provider doesn't use one). Never returns the secret.
export async function getOAuthApp(id: ProviderId): Promise<OAuthAppState | null> {
  const spec = OAUTH_APP[id]; if (!spec) return null;
  const clientId = (await keys.getSecret(`${id}_client_id`)) || '';
  const hasSecret = !!(await keys.getSecret(`${id}_client_secret`));
  return { clientId, hasSecret, needsSecret: spec.needsSecret, configured: !!clientId && (!spec.needsSecret || hasSecret) };
}
// Store the OAuth-app config. A blank secret keeps the previously-stored one (so editing the id alone is fine),
// but the first save of a secret-requiring provider must include one.
export async function setOAuthApp(id: ProviderId, clientId: string, secret?: string): Promise<{ ok: boolean; error?: string }> {
  const spec = OAUTH_APP[id]; if (!spec) return { ok: false, error: 'This provider has no OAuth app to configure' };
  const cid = (clientId || '').trim(); if (!cid) return { ok: false, error: 'Client ID is required' };
  if (spec.needsSecret) {
    const sec = (secret || '').trim();
    if (!sec && !(await keys.getSecret(`${id}_client_secret`))) return { ok: false, error: 'Client secret is required' };
    if (sec) await keys.setSecret(`${id}_client_secret`, sec);
  }
  await keys.setSecret(`${id}_client_id`, cid);
  return { ok: true };
}
// Clear the OAuth-app config (does not touch the connection tokens — call provider.disconnect() for those).
export async function clearOAuthApp(id: ProviderId): Promise<void> {
  await keys.setSecret(`${id}_client_id`, '');
  await keys.setSecret(`${id}_client_secret`, '');
}
// GitHub's device flow reads its client id here (main.ts owns the flow but not the key store).
export const githubClientId = (): Promise<string | null> => keys.getSecret('github_client_id');
