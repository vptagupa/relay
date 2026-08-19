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
export interface PrRow { number: number; branch: string; url: string; draft: boolean; title?: string; author?: string; state?: string; updatedAt?: number; }
// Mergeability, as far as the provider will tell us: 'conflict' = the head can't auto-merge into the base (needs
// manual resolution); 'clean' = merges cleanly; 'unknown' = the provider hasn't computed it (GitHub is lazy) or
// doesn't expose it (Bitbucket). Only 'conflict' drives the ⚠ badge + resolve action — 'unknown' shows nothing.
export type MergeState = 'clean' | 'conflict' | 'unknown';
// The full PR/MR — fetched on demand for the details view (kept off the list so list payloads stay lean).
export interface PrDetail {
  number: number; title: string; body: string; state: string; draft: boolean; url: string;
  author?: string; sourceBranch: string; baseBranch: string; mergeState: MergeState;
  labels: string[]; reviewers: string[]; createdAt?: number; updatedAt?: number;
}
interface ApiResult { ok: boolean; status: number; json: unknown; }

// A minimal HTTPS request that resolves to { status, text } and never rejects. A 20s timeout guards the
// panel/poll from a hung connection. Exported for main.ts's GitHub device-flow handlers.
export function httpsReq(host: string, pathname: string, method: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { status: number; text: string; headers: Record<string, string | string[] | undefined> }) => { if (!done) { done = true; resolve(v); } };
    const req = https.request({ host, path: pathname, method, headers: { 'User-Agent': 'SlayerT', ...headers }, timeout: 20000 }, (res) => {
      let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => finish({ status: res.statusCode || 0, text: data, headers: res.headers }));
    });
    req.on('error', () => finish({ status: 0, text: '', headers: {} }));
    req.on('timeout', () => { req.destroy(); finish({ status: 0, text: '', headers: {} }); });
    if (body) req.write(body);
    req.end();
  });
}
// Conditional-request cache + rate-limit tracker. GitHub/GitLab honour If-None-Match: an unchanged resource comes
// back 304 and DOESN'T count against the hourly limit — the difference between a poller that drains the quota
// and one that costs ~nothing. Keyed by host+path+token so a different account never reads another's cached body.
interface EtagEntry { etag: string; json: unknown; }
const etagCache = new Map<string, EtagEntry>();
let rlRemaining = Infinity;   // last-seen X-RateLimit-Remaining (core)
let rlReset = 0;              // epoch ms when the window resets
let rlBackoffUntil = 0;       // pause API calls until this epoch ms (set on a 403/429 rate-limit hit)
export function rateLimitStatus(): { remaining: number; resetMs: number; backoffUntil: number; limited: boolean } {
  return { remaining: rlRemaining, resetMs: rlReset, backoffUntil: rlBackoffUntil, limited: Date.now() < rlBackoffUntil };
}
const hdr = (h: Record<string, string | string[] | undefined>, k: string): string => { const v = h[k]; return Array.isArray(v) ? (v[0] || '') : (v || ''); };
// A short, non-reversible tag of the auth header, so the ETag cache never serves one token's body to another.
function tokenTag(headers: Record<string, string>): string {
  const a = headers['Authorization'] || headers['PRIVATE-TOKEN'] || '';
  let h = 0; for (let i = 0; i < a.length; i++) h = (Math.imul(h, 31) + a.charCodeAt(i)) | 0;
  return String(h);
}
// A GET that resolves to { ok, status, json }; ok = 2xx and body parsed. Never rejects. Uses a conditional
// request (If-None-Match) so an unchanged resource returns 304 — free (no rate-limit cost) — and serves the
// cached body; also records X-RateLimit headers and sets a backoff window on a rate-limit hit.
async function apiGet(host: string, pathname: string, headers: Record<string, string>): Promise<ApiResult> {
  const ck = `${host} ${pathname} ${tokenTag(headers)}`;
  const cached = etagCache.get(ck);
  const r = await httpsReq(host, pathname, 'GET', cached ? { ...headers, 'If-None-Match': cached.etag } : headers);
  const rem = Number(hdr(r.headers, 'x-ratelimit-remaining')); if (!Number.isNaN(rem)) rlRemaining = rem;
  const rst = Number(hdr(r.headers, 'x-ratelimit-reset')); if (rst) rlReset = rst * 1000;
  if (r.status === 304 && cached) return { ok: true, status: 200, json: cached.json };   // unchanged → free; serve cache
  if ((r.status === 403 || r.status === 429) && (rem === 0 || hdr(r.headers, 'retry-after'))) {
    const ra = Number(hdr(r.headers, 'retry-after'));
    rlBackoffUntil = Date.now() + (Number.isNaN(ra) || !ra ? Math.max(60000, rlReset - Date.now()) : ra * 1000);
  }
  let json: unknown = null; try { json = JSON.parse(r.text); } catch { /* non-json error body */ }
  const etag = hdr(r.headers, 'etag');
  if (r.status >= 200 && r.status < 300 && etag) {
    if (etagCache.size > 800) etagCache.delete(etagCache.keys().next().value as string); // soft cap (oldest-out)
    etagCache.set(ck, { etag, json });
  }
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json };
}
// A JSON POST (creating an issue), same shape as apiGet. Never rejects. Sends an explicit Content-Length so a
// strict API can't reject a chunked body with 411.
async function apiPost(host: string, pathname: string, headers: Record<string, string>, bodyObj: unknown): Promise<ApiResult> {
  const bodyStr = JSON.stringify(bodyObj);
  const r = await httpsReq(host, pathname, 'POST', { ...headers, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(bodyStr)) }, bodyStr);
  let json: unknown = null; try { json = JSON.parse(r.text); } catch { /* non-json error body */ }
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json };
}
// PUT / PATCH / DELETE for writes (apiPost covers POST). A DELETE has no body; PUT/PATCH may carry a body ± query.
async function apiSend(method: 'PUT' | 'PATCH' | 'DELETE', host: string, pathname: string, headers: Record<string, string>, bodyObj?: unknown): Promise<ApiResult> {
  const bodyStr = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  const h = bodyStr !== undefined ? { ...headers, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(bodyStr)) } : headers;
  const r = await httpsReq(host, pathname, method, h, bodyStr);
  let json: unknown = null; try { json = JSON.parse(r.text); } catch { /* non-json error body */ }
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json };
}
const asObj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? x as Record<string, unknown> : {});
const asArr = (x: unknown): Array<Record<string, unknown>> => (Array.isArray(x) ? x as Array<Record<string, unknown>> : []);
const str = (x: unknown): string => (x == null ? '' : String(x));
type Raw = Array<Record<string, unknown>>;
// A label's normalized shape (matches Issue.labels) + a stable default colour for a NEW GitHub label (GitHub
// requires a colour when creating one; the user can recolour it later on the provider).
export type Lbl = { name: string; color?: string };
// A single comment/note on the shared PR/issue conversation (for the in-app thread view).
export type Comment = { author: string; body: string; createdAt: number; url?: string };
export type ItemKind = 'pr' | 'issue';
const LABEL_PALETTE = ['0e8a16', '1d76db', '5319e7', 'b60205', 'd93f0b', 'fbca04', '0052cc', '006b75', 'e99695', 'c5def5', 'bfdadc', 'd4c5f9'];
function labelColor(name: string): string { let h = 0; for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) >>> 0; return LABEL_PALETTE[h % LABEL_PALETTE.length]; }
const ghLabels = (x: unknown): Lbl[] => asArr(x).map((l) => ({ name: str(l.name), color: l.color ? str(l.color) : undefined }));
const glLabels = (x: unknown): Lbl[] => (Array.isArray(asObj(x).labels) ? asObj(x).labels as unknown[] : []).map((l) => ({ name: str(l) }));

// Server-side author filtering. Where the provider's list endpoint takes a native author param (GitHub issues
// `creator=`, GitLab `author_username=`) we fan out one request per selected author IN PARALLEL and merge — the
// server does the filtering, so only matches come back. Endpoints with no native author filter (GitHub PRs,
// Bitbucket) are deep-scanned up to SCAN_PAGES and filtered by author in main. Either way the result is bounded
// (recent matches, no infinite scroll under a filter) — mirrors the "All repos" scope's bounded fan-out.
const SCAN_PAGES = 5;
// Merge fan-out / scan rows: keep the first row per number (they don't overlap across authors), newest first.
function dedupSort<T extends { number: number }>(rows: T[], recency: (r: T) => number): T[] {
  const seen = new Set<number>(); const out: T[] = [];
  for (const r of rows) if (r.number && !seen.has(r.number)) { seen.add(r.number); out.push(r); }
  out.sort((a, b) => recency(b) - recency(a));
  return out;
}

/* ============================== GitHub ============================== */
// Connections + OAuth-app creds are scoped PER SLAYER T WORKSPACE — every secret is keyed `${ws}:<name>`
// so a provider connected in one workspace is fully isolated from another (no shared credentials). The
// active workspace id `ws` is threaded in from the renderer via the IPC boundary.
async function ghHeaders(ws: string): Promise<Record<string, string> | null> {
  const token = await keys.getSecret(`${ws}:github_oauth`);
  return token ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } : null;
}
async function ghApi(ws: string, pathname: string): Promise<ApiResult> {
  const h = await ghHeaders(ws); if (!h) return { ok: false, status: 401, json: null };
  return apiGet('api.github.com', pathname, h);
}
const github = {
  async authState(ws: string): Promise<{ connected: boolean; login?: string }> {
    const h = await ghHeaders(ws); if (!h) return { connected: false };
    const who = await ghApi(ws, '/user');
    if (who.status === 401) return { connected: false };   // ONLY a real 401 means the token is revoked
    return { connected: true, login: str(asObj(who.json).login) };
  },
  // Create an issue (used by Tasks: file a validated task as a real issue). Returns its number + url.
  async createIssue(ws: string, repo: string, title: string, body: string): Promise<{ ok: boolean; number?: number; url?: string; error?: string }> {
    const h = await ghHeaders(ws); if (!h) return { ok: false, error: 'Not connected to GitHub' };
    const r = await apiPost('api.github.com', `/repos/${repo}/issues`, h, { title, body });
    if (!r.ok) return { ok: false, error: `${str(asObj(r.json).message) || 'Could not create issue'} (HTTP ${r.status})` };
    const j = asObj(r.json);
    return { ok: true, number: Number(j.number) || 0, url: str(j.html_url) };
  },
  // Current open/closed state of a single issue (Tasks track their filed issue's lifecycle).
  async issueState(ws: string, repo: string, number: number): Promise<{ ok: boolean; state?: 'open' | 'closed'; error?: string }> {
    const r = await ghApi(ws, `/repos/${repo}/issues/${number}`);
    if (!r.ok || !r.json || typeof r.json !== 'object') return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true, state: str(asObj(r.json).state) === 'closed' ? 'closed' : 'open' };
  },
  // Add a label to an issue ON the repo (Issues rail's + button). A brand-new name is created in the repo first
  // (an existing one 422s → ignored), then attached; returns the issue's full updated label set.
  async addLabel(ws: string, repo: string, number: number, label: string): Promise<{ ok: boolean; labels?: Lbl[]; error?: string }> {
    const h = await ghHeaders(ws); if (!h) return { ok: false, error: 'Not connected to GitHub' };
    await apiPost('api.github.com', `/repos/${repo}/labels`, h, { name: label, color: labelColor(label) }); // create if missing
    const r = await apiPost('api.github.com', `/repos/${repo}/issues/${number}/labels`, h, { labels: [label] });
    if (!r.ok) return { ok: false, error: `${str(asObj(r.json).message) || 'Could not add label'} (HTTP ${r.status})` };
    return { ok: true, labels: ghLabels(r.json) };
  },
  async removeLabel(ws: string, repo: string, number: number, label: string): Promise<{ ok: boolean; labels?: Lbl[]; error?: string }> {
    const h = await ghHeaders(ws); if (!h) return { ok: false, error: 'Not connected to GitHub' };
    const r = await apiSend('DELETE', 'api.github.com', `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`, h);
    if (!r.ok) return { ok: false, error: `${str(asObj(r.json).message) || 'Could not remove label'} (HTTP ${r.status})` };
    return { ok: true, labels: ghLabels(r.json) };
  },
  // The conversation thread — GitHub uses the shared issues-comments endpoint for BOTH PRs and issues.
  async comments(ws: string, repo: string, number: number, _kind: ItemKind): Promise<{ ok: boolean; comments?: Comment[]; error?: string }> {
    const r = await ghApi(ws, `/repos/${repo}/issues/${number}/comments?per_page=100`);
    if (!r.ok || !Array.isArray(r.json)) return { ok: false, error: `Could not load comments (HTTP ${r.status})` };
    return { ok: true, comments: asArr(r.json).map((c) => ({ author: str(asObj(c.user).login), body: str(c.body), createdAt: Date.parse(str(c.created_at)) || 0, url: str(c.html_url) || undefined })) };
  },
  // Post a comment (PR conversation = the same issues-comments endpoint).
  async postComment(ws: string, repo: string, number: number, body: string, _kind: ItemKind): Promise<{ ok: boolean; url?: string; error?: string }> {
    const h = await ghHeaders(ws); if (!h) return { ok: false, error: 'Not connected to GitHub' };
    const r = await apiPost('api.github.com', `/repos/${repo}/issues/${number}/comments`, h, { body });
    if (!r.ok) return { ok: false, error: `${str(asObj(r.json).message) || 'Could not post comment'} (HTTP ${r.status})` };
    return { ok: true, url: str(asObj(r.json).html_url) };
  },
  async prMerge(ws: string, repo: string, number: number, method?: string): Promise<{ ok: boolean; error?: string }> {
    const h = await ghHeaders(ws); if (!h) return { ok: false, error: 'Not connected to GitHub' };
    const r = await apiSend('PUT', 'api.github.com', `/repos/${repo}/pulls/${number}/merge`, h, { merge_method: method === 'squash' || method === 'rebase' ? method : 'merge' });
    if (!r.ok) return { ok: false, error: `${str(asObj(r.json).message) || 'Could not merge'} (HTTP ${r.status})` };
    return { ok: true };
  },
  async setState(ws: string, repo: string, number: number, state: 'open' | 'closed', kind: ItemKind): Promise<{ ok: boolean; error?: string }> {
    const h = await ghHeaders(ws); if (!h) return { ok: false, error: 'Not connected to GitHub' };
    const r = await apiSend('PATCH', 'api.github.com', `/repos/${repo}/${kind === 'pr' ? 'pulls' : 'issues'}/${number}`, h, { state });
    if (!r.ok) return { ok: false, error: `${str(asObj(r.json).message) || 'Could not update state'} (HTTP ${r.status})` };
    return { ok: true };
  },
  // Review verdict on a PR: approve | request_changes | comment.
  async prReview(ws: string, repo: string, number: number, event: 'approve' | 'request_changes' | 'comment', body?: string): Promise<{ ok: boolean; error?: string }> {
    const h = await ghHeaders(ws); if (!h) return { ok: false, error: 'Not connected to GitHub' };
    const ev = event === 'approve' ? 'APPROVE' : event === 'request_changes' ? 'REQUEST_CHANGES' : 'COMMENT';
    const r = await apiPost('api.github.com', `/repos/${repo}/pulls/${number}/reviews`, h, { event: ev, body: body || '' });
    if (!r.ok) return { ok: false, error: `${str(asObj(r.json).message) || 'Could not submit review'} (HTTP ${r.status})` };
    return { ok: true };
  },
  // Replace the FULL assignee list (logins); a PR is an issue on GitHub, so one endpoint serves both.
  async setAssignees(ws: string, repo: string, number: number, logins: string[], _kind: ItemKind): Promise<{ ok: boolean; assignees?: string[]; error?: string }> {
    const h = await ghHeaders(ws); if (!h) return { ok: false, error: 'Not connected to GitHub' };
    const r = await apiSend('PATCH', 'api.github.com', `/repos/${repo}/issues/${number}`, h, { assignees: logins });
    if (!r.ok) return { ok: false, error: `${str(asObj(r.json).message) || 'Could not set assignees'} (HTTP ${r.status})` };
    return { ok: true, assignees: asArr(asObj(r.json).assignees).map((a) => str(a.login)).filter(Boolean) };
  },
  // One page (100) of issues, for infinite scroll. hasMore = the raw page was full (issues + PRs, before the
  // PR filter), so another page likely exists.
  async issues(ws: string, repo: string, state: IssueState = 'open', page = 1, authors?: string[]): Promise<{ ok: boolean; issues?: Issue[]; hasMore?: boolean; error?: string }> {
    const st = state === 'closed' ? 'closed' : 'open';
    const norm = (raw: Raw): Issue[] => raw.filter((i) => !i.pull_request).map((i) => ({
      number: Number(i.number) || 0, title: str(i.title), body: str(i.body), state: str(i.state) || 'open', url: str(i.html_url),
      labels: asArr(i.labels).map((l) => ({ name: str(l.name), color: l.color ? str(l.color) : undefined })),
      assignees: asArr(i.assignees).map((a) => str(a.login)).filter(Boolean),
      author: str(asObj(i.user).login) || undefined,
      milestone: i.milestone ? str(asObj(i.milestone).title) || undefined : undefined,
    }));
    if (authors && authors.length) {
      // Native server-side author filter: /issues?creator= takes one login, so fan out per selected author.
      const results = await Promise.all(authors.map((a) => ghApi(ws, `/repos/${repo}/issues?state=${st}&creator=${encodeURIComponent(a)}&per_page=100`)));
      const oks = results.filter((r) => r.ok && Array.isArray(r.json));
      if (!oks.length) { const s = results[0]?.status || 0; return { ok: false, error: s === 401 ? 'Not connected — reconnect GitHub in Sources.' : `Could not pull issues (HTTP ${s})` }; }
      return { ok: true, issues: dedupSort(oks.flatMap((r) => norm(asArr(r.json))), (i) => i.number), hasMore: false };
    }
    const r = await ghApi(ws, `/repos/${repo}/issues?state=${st}&per_page=100&page=${page}`);
    if (!r.ok || !Array.isArray(r.json)) {
      const msg = str(asObj(r.json).message);
      if (r.status === 401) return { ok: false, error: 'Not connected — reconnect GitHub in Sources.' };
      if (r.status === 403 || r.status === 404) return { ok: false, error: `${msg || 'No access'} (HTTP ${r.status}). If this repo is in an organization, an org owner may need to approve the Slayer T OAuth app (Org → Settings → Third-party Access).` };
      return { ok: false, error: `${msg || 'Could not pull issues'} (HTTP ${r.status})` };
    }
    const raw = asArr(r.json);
    return { ok: true, issues: norm(raw), hasMore: raw.length === 100 };
  },
  async repos(ws: string): Promise<{ ok: boolean; repos?: RepoRow[]; error?: string }> {
    const r = await ghApi(ws, '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member');
    if (!r.ok || !Array.isArray(r.json)) return { ok: false, error: r.status === 401 ? 'Not connected to GitHub' : 'Could not list repos' };
    const repos = asArr(r.json).map((x) => ({ repo: str(x.full_name), desc: str(x.description), priv: !!x.private })).filter((x) => /^[\w.-]+\/[\w.-]+$/.test(x.repo));
    return { ok: true, repos };
  },
  // One page of PRs for the given state. Enriched (title/author/state) for the PR rail; issues.ts's review
  // detection just reads branch/url/draft on the default open+page-1 call, so its behaviour is unchanged.
  async prs(ws: string, repo: string, state: IssueState = 'open', page = 1, authors?: string[]): Promise<{ ok: boolean; prs?: PrRow[]; hasMore?: boolean; error?: string }> {
    const st = state === 'closed' ? 'closed' : 'open';
    const norm = (raw: Raw): PrRow[] => raw.map((p) => ({ number: Number(p.number) || 0, branch: str(asObj(p.head).ref), url: str(p.html_url), draft: !!p.draft, title: str(p.title), author: str(asObj(p.user).login) || undefined, state: p.merged_at ? 'merged' : (str(p.state) || undefined), updatedAt: Date.parse(str(p.updated_at)) || 0 })).filter((p) => p.branch);
    if (authors && authors.length) {
      // /pulls has no author param, so deep-scan (bounded) and keep the selected authors' PRs. Branch/state stay intact.
      const want = new Set(authors); const out: PrRow[] = [];
      for (let pg = 1; pg <= SCAN_PAGES; pg++) {
        const r = await ghApi(ws, `/repos/${repo}/pulls?state=${st}&per_page=100&page=${pg}&sort=updated&direction=desc`);
        if (!r.ok || !Array.isArray(r.json)) { if (pg === 1) return { ok: false, error: r.status === 401 ? 'Not connected — reconnect GitHub in Sources.' : `Could not list PRs (HTTP ${r.status})` }; break; }
        const raw = asArr(r.json); out.push(...norm(raw).filter((p) => want.has(p.author || '')));
        if (raw.length < 100) break;   // exhausted the list
      }
      return { ok: true, prs: dedupSort(out, (p) => p.updatedAt || 0), hasMore: false };
    }
    const r = await ghApi(ws, `/repos/${repo}/pulls?state=${st}&per_page=100&page=${page}&sort=updated&direction=desc`);
    if (!r.ok || !Array.isArray(r.json)) {
      const msg = str(asObj(r.json).message);
      if (r.status === 401) return { ok: false, error: 'Not connected — reconnect GitHub in Sources.' };
      return { ok: false, error: `${msg || 'Could not list PRs'} (HTTP ${r.status})` };
    }
    const raw = asArr(r.json);
    return { ok: true, prs: norm(raw), hasMore: raw.length === 100 };
  },
  // Repo collaborators (for the PR author filter). Needs push access; a read-only token 403s, and the caller
  // then falls back to the authors already in the loaded PRs. `login` matches the PR author's login.
  async repoMembers(ws: string, repo: string): Promise<{ ok: boolean; members?: string[]; error?: string }> {
    const r = await ghApi(ws, `/repos/${repo}/collaborators?per_page=100`);
    if (!r.ok || !Array.isArray(r.json)) return { ok: false, error: r.status === 401 ? 'Not connected to GitHub' : `Could not list members (HTTP ${r.status})` };
    return { ok: true, members: asArr(r.json).map((u) => str(u.login)).filter(Boolean) };
  },
  // Full PR (with body) fetched on demand for the details hover.
  async prDetail(ws: string, repo: string, number: number): Promise<{ ok: boolean; detail?: PrDetail; error?: string }> {
    const r = await ghApi(ws, `/repos/${repo}/pulls/${number}`);
    if (!r.ok || !r.json || typeof r.json !== 'object') return { ok: false, error: `Could not load PR (HTTP ${r.status})` };
    const p = asObj(r.json);
    // `mergeable_state === 'dirty'` is the ONLY value that means a real conflict; 'blocked'/'behind'/'unstable'
    // are mergeable-with-caveats (not conflicts). `mergeable === null` / state 'unknown' = GitHub still computing.
    const ms = str(p.mergeable_state);
    const mergeState: MergeState = ms === 'dirty' ? 'conflict' : (p.mergeable == null || ms === '' || ms === 'unknown') ? 'unknown' : 'clean';
    return { ok: true, detail: {
      number: Number(p.number) || 0, title: str(p.title), body: str(p.body), state: p.merged_at ? 'merged' : (str(p.state) || ''), draft: !!p.draft, url: str(p.html_url),
      author: str(asObj(p.user).login) || undefined, sourceBranch: str(asObj(p.head).ref), baseBranch: str(asObj(p.base).ref), mergeState,
      labels: asArr(p.labels).map((l) => str(l.name)).filter(Boolean), reviewers: asArr(p.requested_reviewers).map((u) => str(u.login)).filter(Boolean),
      createdAt: Date.parse(str(p.created_at)) || 0, updatedAt: Date.parse(str(p.updated_at)) || 0,
    } };
  },
  repoFromRemote: (url: string): string | null => {
    const m = url.trim().match(/github\.com[:/]([^\s]+?)(?:\.git)?\/?$/i);
    return m && /^[\w.-]+\/[\w.-]+$/.test(m[1]) ? m[1] : null;
  },
  async cloneUrl(repo: string): Promise<string> { return `https://github.com/${repo}.git`; },
  cli: 'gh',
  cliCloneArgs: (repo: string, dest: string): string[] => ['repo', 'clone', repo, dest],
  // A token connect isn't used for GitHub (device flow lives in main.ts), but keep the shape uniform.
  async connect(ws: string, token: string): Promise<{ ok: boolean; login?: string; error?: string }> {
    await keys.setSecret(`${ws}:github_oauth`, token);
    const s = await github.authState(ws);
    return s.connected ? { ok: true, login: s.login } : { ok: false, error: 'Token rejected' };
  },
  async disconnect(ws: string): Promise<void> { await keys.setSecret(`${ws}:github_oauth`, ''); },
};

/* ============================== GitLab ============================== */
async function glHost(ws: string): Promise<string> { return (await keys.getSecret(`${ws}:gitlab_host`)) || 'gitlab.com'; }
async function glHeaders(ws: string): Promise<Record<string, string> | null> {
  const token = await keys.getSecret(`${ws}:gitlab_pat`);
  return token ? { 'PRIVATE-TOKEN': token } : null;
}
async function glApi(ws: string, pathname: string): Promise<ApiResult> {
  const h = await glHeaders(ws); if (!h) return { ok: false, status: 401, json: null };
  return apiGet(await glHost(ws), `/api/v4${pathname}`, h);
}
const enc = (repo: string) => encodeURIComponent(repo); // GitLab wants the project path URL-encoded
const gitlab = {
  async authState(ws: string): Promise<{ connected: boolean; login?: string }> {
    const h = await glHeaders(ws); if (!h) return { connected: false };
    const who = await glApi(ws, '/user');
    if (who.status === 401) return { connected: false };
    return { connected: true, login: str(asObj(who.json).username) };
  },
  async createIssue(ws: string, repo: string, title: string, body: string): Promise<{ ok: boolean; number?: number; url?: string; error?: string }> {
    const h = await glHeaders(ws); if (!h) return { ok: false, error: 'Not connected to GitLab' };
    const r = await apiPost(await glHost(ws), `/api/v4/projects/${enc(repo)}/issues`, h, { title, description: body });
    if (!r.ok) return { ok: false, error: `${str(asObj(r.json).message) || 'Could not create issue'} (HTTP ${r.status})` };
    const j = asObj(r.json);
    return { ok: true, number: Number(j.iid) || 0, url: str(j.web_url) };
  },
  async issueState(ws: string, repo: string, number: number): Promise<{ ok: boolean; state?: 'open' | 'closed'; error?: string }> {
    const r = await glApi(ws, `/projects/${enc(repo)}/issues/${number}`);
    if (!r.ok || !r.json || typeof r.json !== 'object') return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true, state: str(asObj(r.json).state) === 'closed' ? 'closed' : 'open' };   // GitLab: 'opened' | 'closed'
  },
  // GitLab add_labels/remove_labels on the issue update endpoint (auto-creates an unknown label). Returns the
  // MR/issue's full label set (names; the basic response has no colours).
  async addLabel(ws: string, repo: string, number: number, label: string): Promise<{ ok: boolean; labels?: Lbl[]; error?: string }> {
    const h = await glHeaders(ws); if (!h) return { ok: false, error: 'Not connected to GitLab' };
    const r = await apiSend('PUT', await glHost(ws), `/api/v4/projects/${enc(repo)}/issues/${number}?add_labels=${encodeURIComponent(label)}`, h, {});
    if (!r.ok) return { ok: false, error: `${str(asObj(r.json).message) || 'Could not add label'} (HTTP ${r.status})` };
    return { ok: true, labels: glLabels(r.json) };
  },
  async removeLabel(ws: string, repo: string, number: number, label: string): Promise<{ ok: boolean; labels?: Lbl[]; error?: string }> {
    const h = await glHeaders(ws); if (!h) return { ok: false, error: 'Not connected to GitLab' };
    const r = await apiSend('PUT', await glHost(ws), `/api/v4/projects/${enc(repo)}/issues/${number}?remove_labels=${encodeURIComponent(label)}`, h, {});
    if (!r.ok) return { ok: false, error: `${str(asObj(r.json).message) || 'Could not remove label'} (HTTP ${r.status})` };
    return { ok: true, labels: glLabels(r.json) };
  },
  async comments(ws: string, repo: string, number: number, kind: ItemKind): Promise<{ ok: boolean; comments?: Comment[]; error?: string }> {
    const seg = kind === 'pr' ? 'merge_requests' : 'issues';
    const r = await glApi(ws, `/projects/${enc(repo)}/${seg}/${number}/notes?per_page=100&sort=asc`);
    if (!r.ok || !Array.isArray(r.json)) return { ok: false, error: `Could not load comments (HTTP ${r.status})` };
    return { ok: true, comments: asArr(r.json).filter((n) => !n.system).map((n) => ({ author: str(asObj(n.author).username), body: str(n.body), createdAt: Date.parse(str(n.created_at)) || 0 })) };
  },
  async postComment(ws: string, repo: string, number: number, body: string, kind: ItemKind): Promise<{ ok: boolean; url?: string; error?: string }> {
    const h = await glHeaders(ws); if (!h) return { ok: false, error: 'Not connected to GitLab' };
    const seg = kind === 'pr' ? 'merge_requests' : 'issues';
    const r = await apiPost(await glHost(ws), `/api/v4/projects/${enc(repo)}/${seg}/${number}/notes`, h, { body });
    if (!r.ok) return { ok: false, error: `${str(asObj(r.json).message) || 'Could not post comment'} (HTTP ${r.status})` };
    return { ok: true };
  },
  async prMerge(ws: string, repo: string, number: number, _method?: string): Promise<{ ok: boolean; error?: string }> {
    const h = await glHeaders(ws); if (!h) return { ok: false, error: 'Not connected to GitLab' };
    const r = await apiSend('PUT', await glHost(ws), `/api/v4/projects/${enc(repo)}/merge_requests/${number}/merge`, h, {});
    if (!r.ok) return { ok: false, error: `${str(asObj(r.json).message) || 'Could not merge'} (HTTP ${r.status})` };
    return { ok: true };
  },
  async setState(ws: string, repo: string, number: number, state: 'open' | 'closed', kind: ItemKind): Promise<{ ok: boolean; error?: string }> {
    const h = await glHeaders(ws); if (!h) return { ok: false, error: 'Not connected to GitLab' };
    const seg = kind === 'pr' ? 'merge_requests' : 'issues';
    const r = await apiSend('PUT', await glHost(ws), `/api/v4/projects/${enc(repo)}/${seg}/${number}?state_event=${state === 'closed' ? 'close' : 'reopen'}`, h, {});
    if (!r.ok) return { ok: false, error: `${str(asObj(r.json).message) || 'Could not update state'} (HTTP ${r.status})` };
    return { ok: true };
  },
  async prReview(ws: string, repo: string, number: number, event: 'approve' | 'request_changes' | 'comment', body?: string): Promise<{ ok: boolean; error?: string }> {
    const h = await glHeaders(ws); if (!h) return { ok: false, error: 'Not connected to GitLab' };
    if (event === 'approve') {
      const r = await apiPost(await glHost(ws), `/api/v4/projects/${enc(repo)}/merge_requests/${number}/approve`, h, {});
      if (!r.ok) return { ok: false, error: `${str(asObj(r.json).message) || 'Could not approve'} (HTTP ${r.status})` };
      return { ok: true };
    }
    // GitLab has no native "request changes" — record it as a note.
    return this.postComment(ws, repo, number, event === 'request_changes' ? `**Changes requested.**${body ? `\n\n${body}` : ''}` : (body || ''), 'pr');
  },
  async setAssignees(_ws: string, _repo: string, _number: number, _logins: string[], _kind: ItemKind): Promise<{ ok: boolean; assignees?: string[]; error?: string }> {
    return { ok: false, error: 'Assignees aren’t settable from Slayer T on GitLab yet' };
  },
  // One page (100) of issues, for infinite scroll. hasMore = the page came back full.
  async issues(ws: string, repo: string, state: IssueState = 'open', page = 1, authors?: string[]): Promise<{ ok: boolean; issues?: Issue[]; hasMore?: boolean; error?: string }> {
    const glState = state === 'closed' ? 'closed' : 'opened';
    // GitLab numbers issues by project-internal iid (that's what URLs and "Closes #iid" use, not id).
    const norm = (raw: Raw): Issue[] => raw.map((i) => ({
      number: Number(i.iid) || 0, title: str(i.title), body: str(i.description), state: str(i.state) || 'opened', url: str(i.web_url),
      labels: (Array.isArray(i.labels) ? i.labels as unknown[] : []).map((l) => ({ name: str(l), color: undefined })),
      assignees: asArr(i.assignees).map((a) => str(a.username)).filter(Boolean),
      author: str(asObj(i.author).username) || undefined,
      milestone: i.milestone ? str(asObj(i.milestone).title) || undefined : undefined,
    }));
    if (authors && authors.length) {
      // Native server-side author filter: ?author_username= takes one username, so fan out per selected author.
      const results = await Promise.all(authors.map((a) => glApi(ws, `/projects/${enc(repo)}/issues?state=${glState}&author_username=${encodeURIComponent(a)}&per_page=100`)));
      const oks = results.filter((r) => r.ok && Array.isArray(r.json));
      if (!oks.length) { const s = results[0]?.status || 0; return { ok: false, error: s === 401 ? 'Not connected — reconnect GitLab in Sources.' : `Could not pull issues (HTTP ${s})` }; }
      return { ok: true, issues: dedupSort(oks.flatMap((r) => norm(asArr(r.json))), (i) => i.number), hasMore: false };
    }
    const r = await glApi(ws, `/projects/${enc(repo)}/issues?state=${glState}&per_page=100&page=${page}`);
    if (!r.ok || !Array.isArray(r.json)) {
      const msg = str(asObj(r.json).message || asObj(r.json).error);
      if (r.status === 401) return { ok: false, error: 'Not connected — reconnect GitLab in Sources.' };
      return { ok: false, error: `${msg || 'Could not pull issues'} (HTTP ${r.status})` };
    }
    const raw = asArr(r.json);
    return { ok: true, issues: norm(raw), hasMore: raw.length === 100 };
  },
  async repos(ws: string): Promise<{ ok: boolean; repos?: RepoRow[]; error?: string }> {
    const r = await glApi(ws, '/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at&archived=false');
    if (!r.ok || !Array.isArray(r.json)) return { ok: false, error: r.status === 401 ? 'Not connected to GitLab' : 'Could not list projects' };
    const repos = asArr(r.json).map((x) => ({ repo: str(x.path_with_namespace), desc: str(x.description), priv: str(x.visibility) !== 'public' })).filter((x) => x.repo.includes('/'));
    return { ok: true, repos };
  },
  // GitLab MRs. The rail's "Closed" means everything not open (GitLab splits that into closed + merged), so we
  // ask for state=all and drop the open ones client-side; "Open" maps to state=opened.
  async prs(ws: string, repo: string, state: IssueState = 'open', page = 1, authors?: string[]): Promise<{ ok: boolean; prs?: PrRow[]; hasMore?: boolean; error?: string }> {
    const glState = state === 'closed' ? 'all' : 'opened';
    // "Closed" asks GitLab for state=all (it splits closed + merged) then drops the still-open ones here.
    const norm = (raw: Raw): PrRow[] => raw.filter((m) => state === 'closed' ? str(m.state) !== 'opened' : true)
      .map((m) => ({ number: Number(m.iid) || 0, branch: str(m.source_branch), url: str(m.web_url), draft: !!m.draft || !!m.work_in_progress, title: str(m.title), author: str(asObj(m.author).username) || undefined, state: str(m.state) || undefined, updatedAt: Date.parse(str(m.updated_at)) || 0 })).filter((p) => p.branch);
    if (authors && authors.length) {
      // Native server-side author filter: ?author_username= takes one username, so fan out per selected author.
      const results = await Promise.all(authors.map((a) => glApi(ws, `/projects/${enc(repo)}/merge_requests?state=${glState}&author_username=${encodeURIComponent(a)}&per_page=100&order_by=updated_at&sort=desc`)));
      const oks = results.filter((r) => r.ok && Array.isArray(r.json));
      if (!oks.length) { const s = results[0]?.status || 0; return { ok: false, error: s === 401 ? 'Not connected — reconnect GitLab in Sources.' : `Could not list merge requests (HTTP ${s})` }; }
      return { ok: true, prs: dedupSort(oks.flatMap((r) => norm(asArr(r.json))), (p) => p.updatedAt || 0), hasMore: false };
    }
    const r = await glApi(ws, `/projects/${enc(repo)}/merge_requests?state=${glState}&per_page=100&page=${page}&order_by=updated_at&sort=desc`);
    if (!r.ok || !Array.isArray(r.json)) {
      const msg = str(asObj(r.json).message || asObj(r.json).error);
      if (r.status === 401) return { ok: false, error: 'Not connected — reconnect GitLab in Sources.' };
      return { ok: false, error: `${msg || 'Could not list merge requests'} (HTTP ${r.status})` };
    }
    return { ok: true, prs: norm(asArr(r.json)), hasMore: asArr(r.json).length === 100 };
  },
  // Project members (for the PR author filter) — `username` matches the MR author's username.
  async repoMembers(ws: string, repo: string): Promise<{ ok: boolean; members?: string[]; error?: string }> {
    const r = await glApi(ws, `/projects/${enc(repo)}/members/all?per_page=100`);
    if (!r.ok || !Array.isArray(r.json)) return { ok: false, error: r.status === 401 ? 'Not connected to GitLab' : `Could not list members (HTTP ${r.status})` };
    return { ok: true, members: asArr(r.json).map((u) => str(u.username)).filter(Boolean) };
  },
  async prDetail(ws: string, repo: string, number: number): Promise<{ ok: boolean; detail?: PrDetail; error?: string }> {
    const r = await glApi(ws, `/projects/${enc(repo)}/merge_requests/${number}`);
    if (!r.ok || !r.json || typeof r.json !== 'object') return { ok: false, error: `Could not load MR (HTTP ${r.status})` };
    const m = asObj(r.json);
    // GitLab gives `has_conflicts` directly; `merge_status === 'cannot_be_merged'` corroborates. 'checking' /
    // 'unchecked' means the mergeability job hasn't run yet → unknown.
    const merge = str(m.merge_status);
    const mergeState: MergeState = (m.has_conflicts === true || merge === 'cannot_be_merged') ? 'conflict' : (merge === '' || merge === 'checking' || merge === 'unchecked') ? 'unknown' : 'clean';
    return { ok: true, detail: {
      number: Number(m.iid) || 0, title: str(m.title), body: str(m.description), state: str(m.state) || '', draft: !!m.draft || !!m.work_in_progress, url: str(m.web_url),
      author: str(asObj(m.author).username) || undefined, sourceBranch: str(m.source_branch), baseBranch: str(m.target_branch), mergeState,
      labels: (Array.isArray(m.labels) ? m.labels as unknown[] : []).map((l) => str(l)).filter(Boolean), reviewers: asArr(m.reviewers).map((u) => str(u.username)).filter(Boolean),
      createdAt: Date.parse(str(m.created_at)) || 0, updatedAt: Date.parse(str(m.updated_at)) || 0,
    } };
  },
  repoFromRemote(url: string): string | null {
    // gitlab.com or a self-managed host (matched loosely by "gitlab" in the hostname).
    const m = url.trim().match(/(?:@|https?:\/\/)([^/:]*gitlab[^/:]*)[:/](.+?)(?:\.git)?\/?$/i);
    return m && m[2].includes('/') ? m[2] : null;
  },
  async cloneUrl(repo: string): Promise<string> { return `https://gitlab.com/${repo}.git`; },
  cli: 'glab',
  cliCloneArgs: (repo: string, dest: string): string[] => ['repo', 'clone', repo, dest],
  async connect(ws: string, token: string, host?: string): Promise<{ ok: boolean; login?: string; error?: string }> {
    await keys.setSecret(`${ws}:gitlab_host`, (host || 'gitlab.com').replace(/^https?:\/\//, '').replace(/\/+$/, ''));
    await keys.setSecret(`${ws}:gitlab_pat`, token);
    const s = await gitlab.authState(ws);
    return s.connected ? { ok: true, login: s.login } : { ok: false, error: 'Token rejected — check the PAT scope (read_api) and host' };
  },
  async disconnect(ws: string): Promise<void> { await keys.setSecret(`${ws}:gitlab_pat`, ''); await keys.setSecret(`${ws}:gitlab_host`, ''); },
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
const bbClientId = (ws: string) => keys.getSecret(`${ws}:bitbucket_client_id`);
const bbClientSecret = (ws: string) => keys.getSecret(`${ws}:bitbucket_client_secret`);
export const bbOAuthConfigured = async (ws: string): Promise<boolean> => !!(await bbClientId(ws)) && !!(await bbClientSecret(ws));
export async function bitbucketAuthorizeUrl(ws: string, state: string): Promise<string> {
  const id = (await bbClientId(ws)) || '';
  return `https://bitbucket.org/site/oauth2/authorize?client_id=${encodeURIComponent(id)}&response_type=code&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(BB_REDIRECT_URI)}`;
}

// POST the Bitbucket token endpoint (Basic client_id:secret) for workspace `ws`. On success, persist that
// workspace's access + refresh + a pre-expiry deadline (renew 60s early). Returns the HTTP status so callers
// can tell a revoked grant (4xx → clear) from a network blip (status 0 → keep the tokens and retry later).
async function bbTokenRequest(ws: string, body: string): Promise<{ ok: boolean; status: number; error?: string }> {
  const id = await bbClientId(ws); const secret = await bbClientSecret(ws);
  if (!id || !secret) return { ok: false, status: 0, error: 'Bitbucket OAuth app is not configured' };
  const auth = 'Basic ' + Buffer.from(`${id}:${secret}`, 'utf8').toString('base64');
  const r = await httpsReq('bitbucket.org', '/site/oauth2/access_token', 'POST',
    { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body);
  let j: Record<string, unknown> = {}; try { j = JSON.parse(r.text) as Record<string, unknown>; } catch { /* non-json */ }
  if (j.access_token) {
    await keys.setSecret(`${ws}:bitbucket_oauth`, String(j.access_token));
    if (j.refresh_token) await keys.setSecret(`${ws}:bitbucket_refresh`, String(j.refresh_token)); // a refresh keeps the old one if none returned
    const ttl = Number(j.expires_in) || 7200;                        // Bitbucket access tokens live ~2h
    await keys.setSecret(`${ws}:bitbucket_expires`, String(Date.now() + Math.max(60, ttl - 60) * 1000));
    return { ok: true, status: r.status };
  }
  return { ok: false, status: r.status, error: String(j.error_description || j.error || `token request failed (HTTP ${r.status})`) };
}

// Exchange an authorization code for tokens (called by the main-process loopback handler after the browser
// callback). redirectUri MUST equal the one sent to /authorize.
export async function bitbucketExchangeCode(ws: string, code: string, redirectUri: string): Promise<{ ok: boolean; login?: string; error?: string }> {
  const t = await bbTokenRequest(ws, `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirectUri)}`);
  if (!t.ok) return { ok: false, error: t.error };
  const s = await bitbucket.authState(ws);
  return s.connected ? { ok: true, login: s.login } : { ok: false, error: 'Authorized, but the token was rejected' };
}

// Refresh the access token, coalescing concurrent callers per workspace onto one in-flight request. A 4xx
// means that workspace's refresh token is dead (revoked/expired) → disconnect it so authState reports a clean
// "not connected" instead of looping; a network failure (status 0) leaves the tokens for the next attempt.
const bbRefreshInFlight = new Map<string, Promise<boolean>>();
async function bbRefresh(ws: string): Promise<boolean> {
  const inflight = bbRefreshInFlight.get(ws);
  if (inflight) return inflight;
  const p = (async () => {
    const refresh = await keys.getSecret(`${ws}:bitbucket_refresh`);
    if (!refresh) return false;
    const r = await bbTokenRequest(ws, `grant_type=refresh_token&refresh_token=${encodeURIComponent(refresh)}`);
    if (!r.ok && r.status >= 400 && r.status < 500) await bitbucket.disconnect(ws);
    return r.ok;
  })().finally(() => { bbRefreshInFlight.delete(ws); });
  bbRefreshInFlight.set(ws, p);
  return p;
}
// The current access token, proactively refreshed once it's within the pre-expiry window.
async function bbAccessToken(ws: string): Promise<string | null> {
  const token = await keys.getSecret(`${ws}:bitbucket_oauth`);
  if (!token) return null;
  const exp = Number(await keys.getSecret(`${ws}:bitbucket_expires`)) || 0;
  if (exp && Date.now() >= exp) { await bbRefresh(ws); return keys.getSecret(`${ws}:bitbucket_oauth`); }
  return token;
}
async function bbHeaders(ws: string): Promise<Record<string, string> | null> {
  const token = await bbAccessToken(ws);
  return token ? { Authorization: `Bearer ${token}` } : null;
}
async function bbApi(ws: string, pathname: string): Promise<ApiResult> {
  let h = await bbHeaders(ws); if (!h) return { ok: false, status: 401, json: null };
  let r = await apiGet('api.bitbucket.org', pathname, h);
  if (r.status === 401) {                                            // token went stale early — force one refresh + retry
    if (await bbRefresh(ws)) { h = await bbHeaders(ws); if (h) r = await apiGet('api.bitbucket.org', pathname, h); }
  }
  return r;
}
const OPEN_BB = new Set(['new', 'open']); // Bitbucket issue states that count as "open"
const bitbucket = {
  async authState(ws: string): Promise<{ connected: boolean; login?: string }> {
    const h = await bbHeaders(ws); if (!h) return { connected: false };
    const who = await bbApi(ws, '/2.0/user');
    if (who.status === 401 || who.status === 403) return { connected: false };
    const u = asObj(who.json);
    return { connected: true, login: str(u.nickname || u.username || u.display_name) };
  },
  async createIssue(ws: string, repo: string, title: string, body: string): Promise<{ ok: boolean; number?: number; url?: string; error?: string }> {
    let h = await bbHeaders(ws); if (!h) return { ok: false, error: 'Not connected to Bitbucket' };
    const path = `/2.0/repositories/${repo}/issues`, payload = { title, content: { raw: body } };
    let r = await apiPost('api.bitbucket.org', path, h, payload);
    if (r.status === 401 && (await bbRefresh(ws))) { h = await bbHeaders(ws); if (h) r = await apiPost('api.bitbucket.org', path, h, payload); } // token went stale → refresh + retry once
    if (!r.ok) return { ok: false, error: `${str(asObj(asObj(r.json).error).message) || 'Could not create issue — is the issue tracker enabled on this repo?'} (HTTP ${r.status})` };
    const j = asObj(r.json);
    return { ok: true, number: Number(j.id) || 0, url: str(asObj(asObj(j.links).html).href) };
  },
  async issueState(ws: string, repo: string, number: number): Promise<{ ok: boolean; state?: 'open' | 'closed'; error?: string }> {
    const r = await bbApi(ws, `/2.0/repositories/${repo}/issues/${number}`);
    if (!r.ok || !r.json || typeof r.json !== 'object') return { ok: false, error: `HTTP ${r.status}` };
    const st = str(asObj(r.json).state).toLowerCase();   // new|open|on hold|resolved|closed|invalid|duplicate|wontfix
    return { ok: true, state: ['resolved', 'closed', 'invalid', 'duplicate', 'wontfix'].includes(st) ? 'closed' : 'open' };
  },
  // Bitbucket Cloud issues have no arbitrary-label concept (only kind/priority/component/milestone) → unsupported.
  async addLabel(): Promise<{ ok: boolean; labels?: Lbl[]; error?: string }> { return { ok: false, error: 'Bitbucket issues don’t support labels' }; },
  async removeLabel(): Promise<{ ok: boolean; labels?: Lbl[]; error?: string }> { return { ok: false, error: 'Bitbucket issues don’t support labels' }; },
  async comments(ws: string, repo: string, number: number, kind: ItemKind): Promise<{ ok: boolean; comments?: Comment[]; error?: string }> {
    const seg = kind === 'pr' ? 'pullrequests' : 'issues';
    const r = await bbApi(ws, `/2.0/repositories/${repo}/${seg}/${number}/comments?pagelen=100&sort=created_on`);
    if (!r.ok || !r.json) return { ok: false, error: `Could not load comments (HTTP ${r.status})` };
    return { ok: true, comments: asArr(asObj(r.json).values).filter((c) => !c.deleted).map((c) => ({ author: str(asObj(c.user).display_name || asObj(c.user).nickname), body: str(asObj(c.content).raw), createdAt: Date.parse(str(c.created_on)) || 0, url: str(asObj(asObj(asObj(c.links).html).href)) || undefined })) };
  },
  async postComment(ws: string, repo: string, number: number, body: string, kind: ItemKind): Promise<{ ok: boolean; url?: string; error?: string }> {
    let h = await bbHeaders(ws); if (!h) return { ok: false, error: 'Not connected to Bitbucket' };
    const path = `/2.0/repositories/${repo}/${kind === 'pr' ? 'pullrequests' : 'issues'}/${number}/comments`;
    let r = await apiPost('api.bitbucket.org', path, h, { content: { raw: body } });
    if (r.status === 401 && (await bbRefresh(ws))) { h = await bbHeaders(ws); if (h) r = await apiPost('api.bitbucket.org', path, h, { content: { raw: body } }); } // token stale → refresh + retry
    if (!r.ok) return { ok: false, error: `${str(asObj(asObj(r.json).error).message) || 'Could not post comment'} (HTTP ${r.status})` };
    return { ok: true, url: str(asObj(asObj(asObj(r.json).links).html).href) };
  },
  async prMerge(ws: string, repo: string, number: number, _method?: string): Promise<{ ok: boolean; error?: string }> {
    let h = await bbHeaders(ws); if (!h) return { ok: false, error: 'Not connected to Bitbucket' };
    const path = `/2.0/repositories/${repo}/pullrequests/${number}/merge`;
    let r = await apiPost('api.bitbucket.org', path, h, {});
    if (r.status === 401 && (await bbRefresh(ws))) { h = await bbHeaders(ws); if (h) r = await apiPost('api.bitbucket.org', path, h, {}); }
    if (!r.ok) return { ok: false, error: `${str(asObj(asObj(r.json).error).message) || 'Could not merge'} (HTTP ${r.status})` };
    return { ok: true };
  },
  async setState(ws: string, repo: string, number: number, state: 'open' | 'closed', kind: ItemKind): Promise<{ ok: boolean; error?: string }> {
    let h = await bbHeaders(ws); if (!h) return { ok: false, error: 'Not connected to Bitbucket' };
    if (kind === 'pr') {
      if (state !== 'closed') return { ok: false, error: 'Reopening a declined PR isn’t supported on Bitbucket' };
      const path = `/2.0/repositories/${repo}/pullrequests/${number}/decline`;
      let r = await apiPost('api.bitbucket.org', path, h, {});
      if (r.status === 401 && (await bbRefresh(ws))) { h = await bbHeaders(ws); if (h) r = await apiPost('api.bitbucket.org', path, h, {}); }
      if (!r.ok) return { ok: false, error: `${str(asObj(asObj(r.json).error).message) || 'Could not decline'} (HTTP ${r.status})` };
      return { ok: true };
    }
    const path = `/2.0/repositories/${repo}/issues/${number}`; const payload = { state: state === 'closed' ? 'closed' : 'open' };
    let r = await apiSend('PUT', 'api.bitbucket.org', path, h, payload);
    if (r.status === 401 && (await bbRefresh(ws))) { h = await bbHeaders(ws); if (h) r = await apiSend('PUT', 'api.bitbucket.org', path, h, payload); }
    if (!r.ok) return { ok: false, error: `${str(asObj(asObj(r.json).error).message) || 'Could not update state'} (HTTP ${r.status})` };
    return { ok: true };
  },
  async prReview(ws: string, repo: string, number: number, event: 'approve' | 'request_changes' | 'comment', body?: string): Promise<{ ok: boolean; error?: string }> {
    if (event === 'comment') return this.postComment(ws, repo, number, body || '', 'pr');
    let h = await bbHeaders(ws); if (!h) return { ok: false, error: 'Not connected to Bitbucket' };
    const path = `/2.0/repositories/${repo}/pullrequests/${number}/${event === 'approve' ? 'approve' : 'request-changes'}`;
    let r = await apiPost('api.bitbucket.org', path, h, {});
    if (r.status === 401 && (await bbRefresh(ws))) { h = await bbHeaders(ws); if (h) r = await apiPost('api.bitbucket.org', path, h, {}); }
    if (!r.ok) return { ok: false, error: `${str(asObj(asObj(r.json).error).message) || 'Could not submit review'} (HTTP ${r.status})` };
    if (body && event === 'request_changes') await this.postComment(ws, repo, number, body, 'pr').catch(() => {});
    return { ok: true };
  },
  async setAssignees(_ws: string, _repo: string, _number: number, _logins: string[], _kind: ItemKind): Promise<{ ok: boolean; assignees?: string[]; error?: string }> {
    return { ok: false, error: 'Assignees aren’t settable from Slayer T on Bitbucket yet' };
  },
  // One page (50) of issues, for infinite scroll. Bitbucket has no state= filter, so we page raw and filter
  // client-side; hasMore uses the response's `next` link (more raw pages to scan).
  async issues(ws: string, repo: string, state: IssueState = 'open', page = 1, authors?: string[]): Promise<{ ok: boolean; issues?: Issue[]; hasMore?: boolean; error?: string }> {
    // Bitbucket has no state= query param, so filter the fetched page client-side: open = new/open, closed = the rest.
    const norm = (raw: Raw): Issue[] => raw.filter((i) => (state === 'closed') !== OPEN_BB.has(str(i.state))).map((i) => {
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
    const errOf = (r: ApiResult): string => {
      const msg = str(asObj(r.json).error && asObj(asObj(r.json).error).message);
      if (r.status === 401 || r.status === 403) return 'Not connected — reconnect Bitbucket in Sources.';
      if (r.status === 404) return 'No issue tracker on this repo (Bitbucket repos ship with it disabled — enable it in repo Settings, or the project uses Jira).';
      return `${msg || 'Could not pull issues'} (HTTP ${r.status})`;
    };
    if (authors && authors.length) {
      // Atlassian deprecated usernames, so BBQL author filtering is unreliable — deep-scan (bounded) and match
      // on the same nickname||display_name the member list returns.
      const want = new Set(authors); const out: Issue[] = [];
      for (let pg = 1; pg <= SCAN_PAGES; pg++) {
        const r = await bbApi(ws, `/2.0/repositories/${repo}/issues?pagelen=50&page=${pg}&sort=-updated_on`);
        if (!r.ok || !Array.isArray(asObj(r.json).values)) { if (pg === 1) return { ok: false, error: errOf(r) }; break; }
        out.push(...norm(asArr(asObj(r.json).values)).filter((i) => want.has(i.author || '')));
        if (!asObj(r.json).next) break;
      }
      return { ok: true, issues: dedupSort(out, (i) => i.number), hasMore: false };
    }
    const r = await bbApi(ws, `/2.0/repositories/${repo}/issues?pagelen=50&page=${page}&sort=-updated_on`);
    if (!r.ok || !Array.isArray(asObj(r.json).values)) return { ok: false, error: errOf(r) };
    return { ok: true, issues: norm(asArr(asObj(r.json).values)), hasMore: !!asObj(r.json).next };
  },
  // CHANGE-2770 (2026-04-14): Atlassian PERMANENTLY REMOVED every cross-workspace listing —
  // GET /2.0/repositories, GET /2.0/workspaces, and GET /2.0/user/permissions/workspaces all return HTTP 410
  // now, so the API can no longer discover which workspaces a user belongs to. The only surviving path is the
  // per-workspace list GET /2.0/repositories/{workspace}, so the user supplies their workspace ids (opts.workspaces)
  // and we list each. A workspace that errors is skipped; its error surfaces only if nothing loaded at all.
  async repos(ws: string, opts?: RepoListOpts): Promise<{ ok: boolean; repos?: RepoRow[]; error?: string }> {
    const workspaces = (opts?.workspaces || []).map((w) => w.trim()).filter(Boolean);
    if (!workspaces.length) return { ok: false, error: 'Add your Bitbucket workspace first (the “workspace” in bitbucket.org/<workspace>/<repo>). Atlassian removed cross-workspace repo discovery (CHANGE-2770), so repos are listed per workspace.' };
    const out: RepoRow[] = [];
    let lastErr = '';
    for (const bws of workspaces) {
      for (let page = 1; page <= 4; page++) {
        const r = await bbApi(ws, `/2.0/repositories/${encodeURIComponent(bws)}?role=member&pagelen=100&page=${page}&sort=-updated_on`);
        if (!r.ok || !Array.isArray(asObj(r.json).values)) {
          if (page > 1) break;
          const msg = str(asObj(asObj(r.json).error).message);
          if (r.status === 401) return { ok: false, error: 'Not connected — reconnect Bitbucket in Sources.' };
          lastErr = r.status === 404
            ? `Workspace “${bws}” not found (HTTP 404) — check the exact workspace id (bitbucket.org/<workspace>).`
            : r.status === 403
              ? `No access to “${bws}” (HTTP 403)${msg ? ' — ' + msg : ''}. Ensure the OAuth client has Repositories → Read.`
              : `${msg || 'Could not list repositories'} for “${bws}” (HTTP ${r.status})`;
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
  // Bitbucket PR states are OPEN / MERGED / DECLINED / SUPERSEDED; the rail's "Closed" folds the last three
  // (the `state` param can repeat). Bitbucket has no draft PRs, so draft is always false.
  async prs(ws: string, repo: string, state: IssueState = 'open', page = 1, authors?: string[]): Promise<{ ok: boolean; prs?: PrRow[]; hasMore?: boolean; error?: string }> {
    const stateQ = state === 'closed' ? 'state=MERGED&state=DECLINED&state=SUPERSEDED' : 'state=OPEN';
    const norm = (raw: Raw): PrRow[] => raw.map((p) => {
      const author = asObj(p.author);
      return { number: Number(p.id) || 0, branch: str(asObj(asObj(p.source).branch).name), url: str(asObj(asObj(p.links).html).href), draft: false, title: str(p.title), author: str(author.nickname || author.display_name) || undefined, state: str(p.state) || undefined, updatedAt: Date.parse(str(p.updated_on)) || 0 };
    }).filter((p) => p.branch);
    const errOf = (r: ApiResult): string => {
      const msg = str(asObj(asObj(r.json).error).message);
      if (r.status === 401 || r.status === 403) return 'Not connected — reconnect Bitbucket in Sources.';
      return `${msg || 'Could not list pull requests'} (HTTP ${r.status})`;
    };
    if (authors && authors.length) {
      // No reliable native author filter (username deprecation) — deep-scan (bounded) and match on nickname||display_name.
      const want = new Set(authors); const out: PrRow[] = [];
      for (let pg = 1; pg <= SCAN_PAGES; pg++) {
        const r = await bbApi(ws, `/2.0/repositories/${repo}/pullrequests?${stateQ}&pagelen=50&page=${pg}&sort=-updated_on`);
        if (!r.ok || !Array.isArray(asObj(r.json).values)) { if (pg === 1) return { ok: false, error: errOf(r) }; break; }
        out.push(...norm(asArr(asObj(r.json).values)).filter((p) => want.has(p.author || '')));
        if (!asObj(r.json).next) break;
      }
      return { ok: true, prs: dedupSort(out, (p) => p.updatedAt || 0), hasMore: false };
    }
    const r = await bbApi(ws, `/2.0/repositories/${repo}/pullrequests?${stateQ}&pagelen=50&page=${page}&sort=-updated_on`);
    if (!r.ok || !Array.isArray(asObj(r.json).values)) return { ok: false, error: errOf(r) };
    return { ok: true, prs: norm(asArr(asObj(r.json).values)), hasMore: !!asObj(r.json).next };
  },
  // Workspace members (Bitbucket has no repo-level member list; the workspace owns access). `nickname ||
  // display_name` matches the PR author format above.
  async repoMembers(ws: string, repo: string): Promise<{ ok: boolean; members?: string[]; error?: string }> {
    const workspace = repo.split('/')[0];
    const r = await bbApi(ws, `/2.0/workspaces/${encodeURIComponent(workspace)}/members?pagelen=100`);
    if (r.status === 401 || r.status === 403 || !Array.isArray(asObj(r.json).values)) return { ok: false, error: `Could not list members (HTTP ${r.status})` };
    return { ok: true, members: asArr(asObj(r.json).values).map((m) => { const u = asObj(m.user); return str(u.nickname || u.display_name); }).filter(Boolean) };
  },
  async prDetail(ws: string, repo: string, number: number): Promise<{ ok: boolean; detail?: PrDetail; error?: string }> {
    const r = await bbApi(ws, `/2.0/repositories/${repo}/pullrequests/${number}`);
    if (!r.ok || !r.json || typeof r.json !== 'object') return { ok: false, error: `Could not load PR (HTTP ${r.status})` };
    const p = asObj(r.json); const author = asObj(p.author);
    // Bitbucket's PR object carries no conflict/mergeable flag (it'd need a merge dry-run) → always 'unknown'.
    return { ok: true, detail: {
      number: Number(p.id) || 0, title: str(p.title), body: str(asObj(p.summary).raw || p.description), state: str(p.state) || '', draft: false, url: str(asObj(asObj(p.links).html).href),
      author: str(author.nickname || author.display_name) || undefined, sourceBranch: str(asObj(asObj(p.source).branch).name), baseBranch: str(asObj(asObj(p.destination).branch).name), mergeState: 'unknown',
      labels: [], reviewers: asArr(p.reviewers).map((u) => str(asObj(u).nickname || asObj(u).display_name)).filter(Boolean),
      createdAt: Date.parse(str(p.created_on)) || 0, updatedAt: Date.parse(str(p.updated_on)) || 0,
    } };
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
  async disconnect(ws: string): Promise<void> {
    await keys.setSecret(`${ws}:bitbucket_oauth`, '');
    await keys.setSecret(`${ws}:bitbucket_refresh`, '');
    await keys.setSecret(`${ws}:bitbucket_expires`, '');
    await keys.setSecret(`${ws}:bitbucket_pat`, '');   // clear any legacy app-password too
  },
};

/* ============================== registry ============================== */
// Every stateful method takes the active Slayer T workspace id `ws` first — connections + credentials are
// keyed per workspace so nothing is shared between them. Stateless helpers (repoFromRemote, cloneUrl) don't.
export interface Adapter {
  authState(ws: string): Promise<{ connected: boolean; login?: string }>;
  issues(ws: string, repo: string, state?: IssueState, page?: number, authors?: string[]): Promise<{ ok: boolean; issues?: Issue[]; hasMore?: boolean; error?: string }>;
  repos(ws: string, opts?: RepoListOpts): Promise<{ ok: boolean; repos?: RepoRow[]; error?: string }>;
  prs(ws: string, repo: string, state?: IssueState, page?: number, authors?: string[]): Promise<{ ok: boolean; prs?: PrRow[]; hasMore?: boolean; error?: string }>;
  repoMembers(ws: string, repo: string): Promise<{ ok: boolean; members?: string[]; error?: string }>;
  prDetail(ws: string, repo: string, number: number): Promise<{ ok: boolean; detail?: PrDetail; error?: string }>;
  createIssue(ws: string, repo: string, title: string, body: string): Promise<{ ok: boolean; number?: number; url?: string; error?: string }>;
  issueState(ws: string, repo: string, number: number): Promise<{ ok: boolean; state?: 'open' | 'closed'; error?: string }>;
  addLabel(ws: string, repo: string, number: number, label: string): Promise<{ ok: boolean; labels?: Lbl[]; error?: string }>;
  removeLabel(ws: string, repo: string, number: number, label: string): Promise<{ ok: boolean; labels?: Lbl[]; error?: string }>;
  comments(ws: string, repo: string, number: number, kind: ItemKind): Promise<{ ok: boolean; comments?: Comment[]; error?: string }>;
  postComment(ws: string, repo: string, number: number, body: string, kind: ItemKind): Promise<{ ok: boolean; url?: string; error?: string }>;
  prMerge(ws: string, repo: string, number: number, method?: string): Promise<{ ok: boolean; error?: string }>;
  setState(ws: string, repo: string, number: number, state: 'open' | 'closed', kind: ItemKind): Promise<{ ok: boolean; error?: string }>;
  prReview(ws: string, repo: string, number: number, event: 'approve' | 'request_changes' | 'comment', body?: string): Promise<{ ok: boolean; error?: string }>;
  setAssignees(ws: string, repo: string, number: number, logins: string[], kind: ItemKind): Promise<{ ok: boolean; assignees?: string[]; error?: string }>;
  repoFromRemote(url: string): string | null;
  cloneUrl(repo: string): Promise<string>;
  cli?: string;
  cliCloneArgs?: (repo: string, dest: string) => string[];
  connect(ws: string, token: string, host?: string): Promise<{ ok: boolean; login?: string; error?: string }>;
  disconnect(ws: string): Promise<void>;
}
export const PROVIDERS: Record<ProviderId, Adapter> = { github, gitlab, bitbucket };
export const providerOf = (id: unknown): Adapter | null => (isProvider(id) ? PROVIDERS[id] : null);

// Which provider (and native repo id) does a git remote URL belong to? Used to infer the active repo
// from the open folder. Tries each adapter's matcher.
export function providerFromRemote(url: string): { provider: ProviderId; repo: string } | null {
  for (const id of PROVIDER_IDS) { const repo = PROVIDERS[id].repoFromRemote(url); if (repo) return { provider: id, repo }; }
  return null;
}

/* ============================== OAuth-app config (runtime, encrypted, per workspace) ==============================
// The OAuth *app* credentials a provider needs to start its login flow live in the OS keychain, entered
// once per workspace in-app — never hardcoded in source, never shared between workspaces. GitHub's device
// flow needs only a public client id; Bitbucket's authorization-code flow needs a client id + secret. Stored
// under `${ws}:<provider>_client_id` / `_client_secret`. The secret is write-only across the IPC boundary:
// getOAuthApp returns the (public) client id + a hasSecret flag, never the secret itself. */
interface OAuthAppNeed { needsSecret: boolean; }
const OAUTH_APP: Partial<Record<ProviderId, OAuthAppNeed>> = { github: { needsSecret: false }, bitbucket: { needsSecret: true } };
export const providerNeedsOAuthApp = (id: ProviderId): boolean => id in OAUTH_APP;
export interface OAuthAppState { clientId: string; hasSecret: boolean; needsSecret: boolean; configured: boolean; }
// Read the stored OAuth-app config for a provider in workspace `ws` (null if the provider doesn't use one). Never returns the secret.
export async function getOAuthApp(ws: string, id: ProviderId): Promise<OAuthAppState | null> {
  const spec = OAUTH_APP[id]; if (!spec) return null;
  const clientId = (await keys.getSecret(`${ws}:${id}_client_id`)) || '';
  const hasSecret = !!(await keys.getSecret(`${ws}:${id}_client_secret`));
  return { clientId, hasSecret, needsSecret: spec.needsSecret, configured: !!clientId && (!spec.needsSecret || hasSecret) };
}
// Store the OAuth-app config for workspace `ws`. A blank secret keeps the previously-stored one (so editing the
// id alone is fine), but the first save of a secret-requiring provider must include one.
export async function setOAuthApp(ws: string, id: ProviderId, clientId: string, secret?: string): Promise<{ ok: boolean; error?: string }> {
  const spec = OAUTH_APP[id]; if (!spec) return { ok: false, error: 'This provider has no OAuth app to configure' };
  const cid = (clientId || '').trim(); if (!cid) return { ok: false, error: 'Client ID is required' };
  if (spec.needsSecret) {
    const sec = (secret || '').trim();
    if (!sec && !(await keys.getSecret(`${ws}:${id}_client_secret`))) return { ok: false, error: 'Client secret is required' };
    if (sec) await keys.setSecret(`${ws}:${id}_client_secret`, sec);
  }
  await keys.setSecret(`${ws}:${id}_client_id`, cid);
  return { ok: true };
}
// Clear the OAuth-app config (does not touch the connection tokens — call provider.disconnect() for those).
export async function clearOAuthApp(ws: string, id: ProviderId): Promise<void> {
  await keys.setSecret(`${ws}:${id}_client_id`, '');
  await keys.setSecret(`${ws}:${id}_client_secret`, '');
}
// GitHub's device flow reads its client id here (main.ts owns the flow but not the key store).
export const githubClientId = (ws: string): Promise<string | null> => keys.getSecret(`${ws}:github_client_id`);

// One-time migration: move the pre-scoping GLOBAL secrets (unprefixed keys from before per-workspace isolation)
// into workspace `ws`, then clear the globals. Called once by the renderer with the active workspace id so the
// user's existing connection lands in the workspace they were using; other workspaces start empty.
const LEGACY_GLOBAL_SECRETS = [
  'github_oauth', 'github_client_id',
  'gitlab_pat', 'gitlab_host',
  'bitbucket_oauth', 'bitbucket_refresh', 'bitbucket_expires', 'bitbucket_pat',
  'bitbucket_client_id', 'bitbucket_client_secret',
];
export async function migrateGlobalSecretsToWs(ws: string): Promise<void> {
  for (const name of LEGACY_GLOBAL_SECRETS) {
    const v = await keys.getSecret(name);
    if (!v) continue;
    if (!(await keys.getSecret(`${ws}:${name}`))) await keys.setSecret(`${ws}:${name}`, v); // don't clobber an already-scoped value
    await keys.setSecret(name, '');                                                          // drop the global copy
  }
}
