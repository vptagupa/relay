// Webhook receiver (MAIN PROCESS) — a small local HTTP server that ingests GitHub / GitLab / Bitbucket
// webhooks and normalizes issue/PR opened+closed events, for near-real-time notifications (the 1-min poller
// stays as a fallback + catch-up). A desktop app on localhost isn't reachable by the providers directly, so
// the user exposes this port via a tunnel (cloudflared/ngrok) or a self-hosted/LAN host and registers the URL.
// Verification: GitHub HMAC-SHA256 (X-Hub-Signature-256), GitLab token (X-Gitlab-Token), Bitbucket `?token=`
// (Bitbucket doesn't sign by default). An unverified request gets 401; anything else always 200 (no retries).

import * as http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WebhookEvent {
  kind: 'new-issue' | 'closed-issue' | 'new-pr' | 'closed-pr';
  provider: 'github' | 'gitlab' | 'bitbucket';
  repo: string;            // owner/name
  number: number;
  title: string;
  url: string;
  actor?: string;          // who performed it (sender / merged_by / closer) — shown in the notification
}

const asObj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? x as Record<string, unknown> : {});
const str = (x: unknown): string => (x == null ? '' : String(x));
const OPEN_BB = new Set(['new', 'open']);   // Bitbucket issue states that count as open

let server: http.Server | null = null;
let running = false;

export function webhookRunning(): boolean { return running; }
export function stopWebhookServer(): void {
  if (server) { try { server.close(); } catch { /* already closed */ } server = null; }
  running = false;
}

// (Re)start the server on `port`, verifying with `secret`. Resolves { ok } — never throws.
export function startWebhookServer(port: number, secret: string, onEvent: (e: WebhookEvent) => void): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    stopWebhookServer();
    const s = http.createServer((req, res) => handle(req, res, secret, onEvent));
    s.on('error', (e: NodeJS.ErrnoException) => { server = null; running = false; resolve({ ok: false, error: e?.code === 'EADDRINUSE' ? `Port ${port} is in use` : 'Could not start the webhook server' }); });
    s.listen(port, '127.0.0.1', () => { server = s; running = true; resolve({ ok: true }); });
  });
}

function handle(req: http.IncomingMessage, res: http.ServerResponse, secret: string, onEvent: (e: WebhookEvent) => void): void {
  if (req.method !== 'POST') { res.writeHead(405); res.end('method'); return; }
  const chunks: Buffer[] = []; let size = 0;
  req.on('data', (c: Buffer) => { size += c.length; if (size > 5_000_000) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => {
    let auth = false, event: WebhookEvent | null = null;
    try { ({ auth, event } = parse(req, Buffer.concat(chunks), secret)); } catch { auth = true; event = null; } // malformed body → 200, ignore
    if (!auth) { res.writeHead(401); res.end('unauthorized'); return; }
    if (event) onEvent(event);
    res.writeHead(200); res.end('ok');
  });
  req.on('error', () => { try { res.writeHead(400); res.end(); } catch { /* */ } });
}

function verifyGithub(raw: Buffer, sig: string, secret: string): boolean {
  if (!sig || !secret) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  try { return timingSafeEqual(Buffer.from(expected), Buffer.from(sig)); } catch { return false; }
}

// Returns { auth } (did the shared secret check out?) and the normalized event (or null if it's one we ignore).
function parse(req: http.IncomingMessage, raw: Buffer, secret: string): { auth: boolean; event: WebhookEvent | null } {
  const h = req.headers;
  const gh = str(h['x-github-event']);
  if (gh) {
    if (!verifyGithub(raw, str(h['x-hub-signature-256']), secret)) return { auth: false, event: null };
    const j = asObj(JSON.parse(raw.toString('utf8')));
    const repo = str(asObj(j.repository).full_name);
    const actor = str(asObj(j.sender).login);            // who triggered the event
    if (gh === 'issues') {
      const i = asObj(j.issue), a = str(j.action);
      if (a === 'opened') return { auth: true, event: { kind: 'new-issue', provider: 'github', repo, number: Number(i.number) || 0, title: str(i.title), url: str(i.html_url), actor } };
      if (a === 'closed') return { auth: true, event: { kind: 'closed-issue', provider: 'github', repo, number: Number(i.number) || 0, title: str(i.title), url: str(i.html_url), actor } };
    } else if (gh === 'pull_request') {
      const p = asObj(j.pull_request), a = str(j.action);
      if (a === 'opened') return { auth: true, event: { kind: 'new-pr', provider: 'github', repo, number: Number(p.number) || 0, title: str(p.title), url: str(p.html_url), actor } };
      // A merged PR arrives as closed with merged_by set — prefer that (who merged/approved) over the raw sender.
      if (a === 'closed') return { auth: true, event: { kind: 'closed-pr', provider: 'github', repo, number: Number(p.number) || 0, title: str(p.title), url: str(p.html_url), actor: str(asObj(p.merged_by).login) || actor } };
    }
    return { auth: true, event: null };
  }

  const gl = str(h['x-gitlab-event']);
  if (gl) {
    if (str(h['x-gitlab-token']) !== secret) return { auth: false, event: null };
    const j = asObj(JSON.parse(raw.toString('utf8')));
    const repo = str(asObj(j.project).path_with_namespace);
    const actor = str(asObj(j.user).username) || str(asObj(j.user).name);   // the GitLab user who triggered the hook
    const oa = asObj(j.object_attributes), a = str(oa.action);
    if (gl === 'Issue Hook') {
      if (a === 'open' || a === 'reopen') return { auth: true, event: { kind: 'new-issue', provider: 'gitlab', repo, number: Number(oa.iid) || 0, title: str(oa.title), url: str(oa.url), actor } };
      if (a === 'close') return { auth: true, event: { kind: 'closed-issue', provider: 'gitlab', repo, number: Number(oa.iid) || 0, title: str(oa.title), url: str(oa.url), actor } };
    } else if (gl === 'Merge Request Hook') {
      if (a === 'open' || a === 'reopen') return { auth: true, event: { kind: 'new-pr', provider: 'gitlab', repo, number: Number(oa.iid) || 0, title: str(oa.title), url: str(oa.url), actor } };
      if (a === 'close' || a === 'merge') return { auth: true, event: { kind: 'closed-pr', provider: 'gitlab', repo, number: Number(oa.iid) || 0, title: str(oa.title), url: str(oa.url), actor } };
    }
    return { auth: true, event: null };
  }

  const bb = str(h['x-event-key']);
  if (bb) {
    let tok = '';
    try { tok = new URL(req.url || '/', 'http://localhost').searchParams.get('token') || ''; } catch { tok = ''; }
    if (tok !== secret) return { auth: false, event: null };
    const j = asObj(JSON.parse(raw.toString('utf8')));
    const repo = str(asObj(j.repository).full_name);
    const actor = str(asObj(j.actor).nickname) || str(asObj(j.actor).display_name);   // the Bitbucket user who acted
    if (bb === 'issue:created') { const i = asObj(j.issue); return { auth: true, event: { kind: 'new-issue', provider: 'bitbucket', repo, number: Number(i.id) || 0, title: str(i.title), url: str(asObj(asObj(i.links).html).href), actor } }; }
    if (bb === 'issue:updated') { const i = asObj(j.issue), ch = asObj(asObj(j.changes).state); if (ch.new && !OPEN_BB.has(str(ch.new))) return { auth: true, event: { kind: 'closed-issue', provider: 'bitbucket', repo, number: Number(i.id) || 0, title: str(i.title), url: str(asObj(asObj(i.links).html).href), actor } }; }
    if (bb === 'pullrequest:created') { const p = asObj(j.pullrequest); return { auth: true, event: { kind: 'new-pr', provider: 'bitbucket', repo, number: Number(p.id) || 0, title: str(p.title), url: str(asObj(asObj(p.links).html).href), actor } }; }
    if (bb === 'pullrequest:fulfilled' || bb === 'pullrequest:rejected') { const p = asObj(j.pullrequest); return { auth: true, event: { kind: 'closed-pr', provider: 'bitbucket', repo, number: Number(p.id) || 0, title: str(p.title), url: str(asObj(asObj(p.links).html).href), actor } }; }
    return { auth: true, event: null };
  }

  return { auth: true, event: null };   // unknown source — 200, ignore
}
