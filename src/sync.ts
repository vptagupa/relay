// Cloud Sync — the Settings "Sync" tab. Wires the Google-Drive + end-to-end-encrypted backup flow that lives in
// the main process (gdrive.ts / cloudsync.ts). The renderer only ever handles STATUS + the OAuth client id and
// one-time passphrase/secret ENTRY — it never sees a token, the client secret, or the stored passphrase.
// DI-seam module: initSync(deps). The destructive "Restore" is gated behind the app's confirm dialog.

import { $, esc } from './dom';
import { toast } from './ui';

const relay = (window as any).relay;

export interface SyncDeps {
  confirm: (title: string, detail: string, okLabel: string) => Promise<boolean>; // app confirm dialog (for the destructive restore)
  flushWorkspace: () => Promise<void>;                                           // persist the live tab snapshot to disk before a push
}
let deps: SyncDeps;
let busy = false;

const fmt = (ms: number): string => (ms ? new Date(ms).toLocaleString() : 'never');

// Pull the live status from main and reflect it into the panel (connection, passphrase, buttons, timestamps).
async function refresh(): Promise<void> {
  const statusEl = $('#syncStatus'); if (!statusEl) return; // panel not mounted yet
  const st = await relay.syncStatus().catch(() => null);
  const cfg = await relay.gdriveConfigGet().catch(() => ({ clientId: '', hasSecret: false, configured: false }));
  const cid = $('#gdClientId') as HTMLInputElement | null;
  if (cid && !cid.value && cfg.clientId) cid.value = cfg.clientId;
  const sec = $('#gdClientSecret') as HTMLInputElement | null;
  if (sec) sec.placeholder = cfg.hasSecret ? '•••••••• (unchanged)' : 'Client secret';

  if (!st) { statusEl.innerHTML = '<span class="sync-dot off"></span> status unavailable'; return; }
  statusEl.innerHTML = (st.connected
    ? `<span class="sync-dot on"></span> Connected as <b>${esc(st.email || 'Google account')}</b>`
    : `<span class="sync-dot off"></span> Not connected`)
    + (st.hasPassphrase ? ' · passphrase set' : ' · <span class="mut">passphrase not set</span>')
    + (st.remoteExists ? ' · <span class="mut">cloud backup present</span>' : '');

  const show = (id: string, on: boolean) => { const el = $(id) as HTMLElement | null; if (el) el.style.display = on ? '' : 'none'; };
  const disable = (id: string, off: boolean) => { const el = $(id) as HTMLButtonElement | null; if (el) el.disabled = off; };
  show('#gdConnect', !st.connected); show('#gdDisconnect', st.connected);
  const ready = st.connected && st.hasPassphrase;
  disable('#syncPush', !ready || busy);
  disable('#syncPull', !ready || !st.remoteExists || busy);
  const pass = $('#syncPass') as HTMLInputElement | null;
  if (pass) pass.placeholder = st.hasPassphrase ? '•••••••• (set — type to change)' : "a strong passphrase you'll remember";
  const times = $('#syncTimes');
  if (times) times.innerHTML = `Last backup: <b>${esc(fmt(st.lastPush))}</b> · last restore: <b>${esc(fmt(st.lastPull))}</b>`;
}
export function refreshSync(): void { void refresh(); }

export function initSync(d: SyncDeps): void {
  deps = d;

  $('#gdConfigSave')?.addEventListener('click', async () => {
    const cid = ($('#gdClientId') as HTMLInputElement).value.trim();
    const sec = ($('#gdClientSecret') as HTMLInputElement).value;
    const r = await relay.gdriveConfigSet(cid, sec || undefined).catch(() => ({ ok: false, error: 'Save failed' }));
    if (r.ok) { ($('#gdClientSecret') as HTMLInputElement).value = ''; toast('OAuth client saved', true); void refresh(); }
    else toast(r.error || 'Could not save the OAuth client');
  });

  $('#gdConnect')?.addEventListener('click', async () => {
    const b = $('#gdConnect') as HTMLButtonElement;
    // While a sign-in is in flight the button doubles as a Cancel — so backing out of the Google tab can't leave
    // it stuck "Waiting for Google…" until the timeout.
    if (busy) { void relay.gdriveOAuthCancel(); return; }
    busy = true; const label = b.textContent; b.textContent = 'Waiting for Google… (click to cancel)';
    const r = await relay.gdriveOAuth().catch(() => ({ ok: false, error: 'Connection failed' }));
    busy = false; b.textContent = label || 'Connect Google Drive';
    if (r.cancelled) toast('Sign-in cancelled');
    else if (r.ok) toast(`Connected as ${r.email || 'Google'}`, true);
    else toast(r.error || 'Could not connect');
    void refresh();
  });

  $('#gdDisconnect')?.addEventListener('click', async () => {
    if (!(await deps.confirm('Disconnect Google Drive?', 'The app forgets your Google token on this PC. Your encrypted backup stays in Drive; your local data is untouched.', 'Disconnect'))) return;
    await relay.gdriveDisconnect().catch(() => {}); toast('Disconnected from Google Drive'); void refresh();
  });

  $('#syncPassSave')?.addEventListener('click', async () => {
    const p = ($('#syncPass') as HTMLInputElement).value;
    const r = await relay.syncSetPassphrase(p).catch(() => ({ ok: false, error: 'Failed' }));
    if (r.ok) { ($('#syncPass') as HTMLInputElement).value = ''; toast('Passphrase set', true); void refresh(); }
    else toast(r.error || 'Could not set the passphrase');
  });

  $('#syncPush')?.addEventListener('click', async () => {
    if (busy) return; busy = true;
    const b = $('#syncPush') as HTMLButtonElement; const label = b.textContent; b.disabled = true; b.textContent = 'Backing up…';
    await deps.flushWorkspace().catch(() => {}); // capture the live tabs before the backup reads the files
    const r = await relay.syncPush().catch(() => ({ ok: false, error: 'Backup failed' }));
    busy = false; b.textContent = label || '⬆ Back up to Drive';
    if (r.ok) toast('Backed up to Google Drive ✓', true); else toast(r.error || 'Backup failed');
    void refresh();
  });

  $('#syncPull')?.addEventListener('click', async () => {
    if (busy) return;
    const go = await deps.confirm('Restore from Drive?',
      "This replaces THIS PC's settings, Library, workspaces, and all credentials with the encrypted cloud backup, then restarts Slayer T. Unsynced local changes are lost.", 'Restore & restart');
    if (!go) return;
    busy = true;
    const b = $('#syncPull') as HTMLButtonElement; const label = b.textContent; b.disabled = true; b.textContent = 'Restoring…';
    const r = await relay.syncPull().catch(() => ({ ok: false, error: 'Restore failed' }));
    if (r.ok && r.applied) { toast('Restored — restarting…', true); setTimeout(() => { void relay.syncRelaunch(); }, 900); return; } // stays busy through relaunch
    busy = false; b.textContent = label || '⬇ Restore from Drive';
    toast(r.missing ? 'No cloud backup found in Drive yet' : (r.error || 'Restore failed'));
    void refresh();
  });

  $('#gdHelp')?.addEventListener('click', (e) => { e.preventDefault(); void relay.openExternal('https://console.cloud.google.com/apis/credentials'); });
  // No status fetch at boot — refreshSync() runs when the Sync tab is opened (avoids a Drive call every launch).
}
