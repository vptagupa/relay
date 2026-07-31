// Terminal ANSI/escape-sequence text processing — pure string transforms, no DOM or state.
//
// The Blocks (Warp-style) view renders captured command output as HTML rather than through xterm,
// so it needs to (a) strip control sequences for plain-text uses (search, copy, export) and
// (b) translate SGR color/bold into styled <span>s for display. The color palette here is fixed
// (independent of the active theme) so block output reads consistently.

/** Remove CSI/OSC/charset escape sequences, leaving plain text. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[=>()][0-9A-Za-z]?/g, '');
}

// Collapse carriage-return overwrites (progress bars: "10%\r20%\r30%") to the last write per line,
// so they don't concatenate into one giant line. Normalize CRLF first so real line endings survive.
export function collapseCR(s: string): string {
  return s.replace(/\r\n/g, '\n').split('\n').map((line) => { const i = line.lastIndexOf('\r'); return i >= 0 ? line.slice(i + 1) : line; }).join('\n');
}

// Map an xterm 256-color index to a hex/rgb string (16 base + 6×6×6 cube + 24 greys). Internal.
function xterm256(n: number): string {
  if (n < 16) return ['#0b0e13', '#ff7b72', '#7ee787', '#f0b429', '#6cb6ff', '#d2a8ff', '#56d4dd', '#d8dee7', '#66717f', '#ff7b72', '#7ee787', '#f0b429', '#6cb6ff', '#d2a8ff', '#56d4dd', '#ffffff'][n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const c = n - 16, r = Math.floor(c / 36), g = Math.floor((c % 36) / 6), b = c % 6;
  const q = (x: number) => (x ? x * 40 + 55 : 0);
  return `rgb(${q(r)},${q(g)},${q(b)})`;
}

// Render command output (raw, with ANSI) to safe HTML — SGR color/bold become styled spans;
// cursor/erase/OSC control sequences are stripped. Used by the Blocks (Warp-style) main view.
export function ansiToHtml(raw: string): string {
  const FG: Record<number, string> = { 30: '#66717f', 31: '#ff7b72', 32: '#7ee787', 33: '#f0b429', 34: '#6cb6ff', 35: '#d2a8ff', 36: '#56d4dd', 37: '#d8dee7', 90: '#8b98a6', 91: '#ff7b72', 92: '#7ee787', 93: '#f0b429', 94: '#6cb6ff', 95: '#d2a8ff', 96: '#56d4dd', 97: '#ffffff' };
  const s = raw.replace(/\r(?!\n)/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')       // OSC
    .replace(/\x1b\[[0-9;?]*[@-ln-~]/g, '')                   // CSI except SGR ('m')
    .replace(/\x1b[=>()#][0-9A-Za-z]?/g, '');                 // charset/mode escapes
  const escd = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = ''; const cur: { c?: string; b?: boolean } = {};
  const re = /\x1b\[([0-9;]*)m|([^\x1b]+)/g; let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[2] !== undefined) {
      if (cur.c || cur.b) html += `<span style="${cur.c ? `color:${cur.c};` : ''}${cur.b ? 'font-weight:600;' : ''}">${escd(m[2])}</span>`;
      else html += escd(m[2]);
    } else {
      const codes = (m[1] || '0').split(';').map((x) => parseInt(x || '0', 10));
      for (let i = 0; i < codes.length; i++) { const c = codes[i];
        if (c === 0) { cur.c = undefined; cur.b = false; }
        else if (c === 1) cur.b = true;
        else if (c === 22) cur.b = false;
        else if (c === 39) cur.c = undefined;
        else if (FG[c]) cur.c = FG[c];
        else if (c === 38) { if (codes[i + 1] === 5) { cur.c = xterm256(codes[i + 2] || 0); i += 2; } else if (codes[i + 1] === 2) { cur.c = `rgb(${codes[i + 2] || 0},${codes[i + 3] || 0},${codes[i + 4] || 0})`; i += 4; } }
      }
    }
  }
  return html;
}
