// Git provider adapters (MAIN-PROCESS ONLY) — GitHub / GitLab / Bitbucket behind one small registry.
// Each adapter speaks its own REST API using an app-owned token encrypted in the OS keychain (keys.ts);
// the renderer never sees a token, only { connected, login } + normalized issues / repos / PRs. Adding a
// provider is one entry in PROVIDERS (Open/Closed) — the generic IPC handlers in main.ts don't change.
//
// Auth model per provider:
//  • GitHub    — OAuth device-flow token ('github_oauth'), Bearer.        (connect handled in main.ts)
//  • GitLab    — Personal Access Token ('gitlab_pat'), PRIVATE-TOKEN header; custom host in 'gitlab_host'.
//  • Bitbucket — App Password as "user:app_password" ('bitbucket_pat'), HTTP Basic.
import * as https from 'node:https';
import * as keys from './keys';
import type { Issue } from './shared/types';

export type ProviderId = 'github' | 'gitlab' | 'bitbucket';
export type IssueState = 'open' | 'closed'; // which issues to pull; default 'open'
export const PROVIDER_IDS: ProviderId[] = ['github', 'gitlab', 'bitbucket'];
const isProvider = (s: unknown): s is ProviderId => typeof s === 'string' && (PROVIDER_IDS as string[]).includes(s);

export interface RepoRow { repo: string; desc: string; priv: boolean; }
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
async function bbHeaders(): Promise<Record<string, string> | null> {
  const token = await keys.getSecret('bitbucket_pat'); // stored as "username:app_password"
  return token ? { Authorization: 'Basic ' + Buffer.from(token, 'utf8').toString('base64') } : null;
}
async function bbApi(pathname: string): Promise<ApiResult> {
  const h = await bbHeaders(); if (!h) return { ok: false, status: 401, json: null };
  return apiGet('api.bitbucket.org', pathname, h);
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
  async repos(): Promise<{ ok: boolean; repos?: RepoRow[]; error?: string }> {
    const out: RepoRow[] = [];
    for (let page = 1; page <= 4; page++) {
      const r = await bbApi(`/2.0/repositories?role=member&pagelen=100&page=${page}&sort=-updated_on`);
      if (!r.ok || !Array.isArray(asObj(r.json).values)) {
        if (page > 1) break;
        return { ok: false, error: r.status === 401 ? 'Not connected to Bitbucket' : 'Could not list repositories' };
      }
      const arr = asArr(asObj(r.json).values);
      for (const x of arr) out.push({ repo: str(x.full_name), desc: str(x.description), priv: !!x.is_private });
      if (arr.length < 100) break;
    }
    return { ok: true, repos: out.filter((x) => x.repo.includes('/')) };
  },
  async prs(repo: string): Promise<{ ok: boolean; prs?: PrRow[]; error?: string }> {
    const r = await bbApi(`/2.0/repositories/${repo}/pullrequests?state=OPEN&pagelen=50`);
    if (!r.ok || !Array.isArray(asObj(r.json).values)) return { ok: false, error: 'Could not list pull requests' };
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
  async connect(token: string): Promise<{ ok: boolean; login?: string; error?: string }> {
    if (!/.:./.test(token)) return { ok: false, error: 'Use "username:app_password"' };
    await keys.setSecret('bitbucket_pat', token);
    const s = await bitbucket.authState();
    return s.connected ? { ok: true, login: s.login } : { ok: false, error: 'Rejected — check the username and app-password scopes (Account read, Issues read, PRs read)' };
  },
  async disconnect(): Promise<void> { await keys.setSecret('bitbucket_pat', ''); },
};

/* ============================== registry ============================== */
export interface Adapter {
  authState(): Promise<{ connected: boolean; login?: string }>;
  issues(repo: string, state?: IssueState): Promise<{ ok: boolean; issues?: Issue[]; error?: string }>;
  repos(): Promise<{ ok: boolean; repos?: RepoRow[]; error?: string }>;
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
