// Shell-integration command-block parsing for a real PTY (Relay v2).
//
// A shell (PowerShell/bash/zsh) is made to emit OSC marker sequences around each command
// via the injection snippets below; this parser turns the raw PTY stream into structured
// command blocks while stripping the markers so they never render in xterm.js.
//
// Protocol (OSC 133 "FinalTerm" + OSC 633 "VS Code"), ESC=\x1b, BEL=\x07, ST=ESC\:
//   ESC ] 133 ; A BEL              prompt start
//   ESC ] 133 ; B BEL              command input begins (prompt end)
//   ESC ] 133 ; C BEL              command executed — OUTPUT begins
//   ESC ] 133 ; D ; <exit> BEL     previous command finished with <exit>
//   ESC ] 633 ; E ; <cmdline> BEL  the clean command line the user ran
//   ESC ] 633 ; P ; Cwd=<path> BEL working directory
//
// A block is created on 633;E (the clean command) — NOT from the echoed keystrokes, which
// carry PSReadLine's colour/cursor redraw noise. Output is only what falls between 133;C and
// the next 133;D. Prompt/typing regions accumulate nothing, so prompt re-renders don't create
// junk blocks.

export interface TermBlock {
  id: string;
  command: string;
  output: string;
  cwd: string;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  running: boolean;
  interactive?: boolean;   // entered a full-screen (alt-screen) app like vim/top
}

export type BlockEvent =
  | { type: 'start'; block: TermBlock }
  | { type: 'update'; block: TermBlock }
  | { type: 'end'; block: TermBlock };

const ESC = '\x1b';
const BEL = '\x07';

export function createShellParser(emit: (e: BlockEvent) => void): { feed(chunk: string): string; close(): void } {
  let pending = '';                 // incomplete trailing escape sequence, carried to next feed()
  let n = 0;
  let lastCwd = '';
  let cur: TermBlock | null = null; // the block currently being built
  let mode: 'idle' | 'output' = 'idle';
  const OUTPUT_CAP = 256 * 1024;    // bound a single block's captured output (memory + IPC volume)
  let updateTimer: ReturnType<typeof setTimeout> | null = null;

  function startBlock(command: string): void {
    cur = { id: `b${++n}`, command, output: '', cwd: lastCwd, exitCode: null, startedAt: Date.now(), endedAt: null, running: true };
    emit({ type: 'start', block: cur });
  }
  // Append to the current block's output — only while capturing a non-alt-screen command — capped
  // to a rolling tail. Returns whether anything was captured.
  function appendOut(text: string): boolean {
    if (mode !== 'output' || !cur || cur.interactive) return false;
    cur.output += text;
    if (cur.output.length > OUTPUT_CAP) cur.output = cur.output.slice(cur.output.length - OUTPUT_CAP);
    return true;
  }
  // Coalesce 'update' emits to ~12/s. Emitting the whole (growing) block per PTY chunk is O(n^2)
  // over IPC and pins the main + renderer on large output like `npm install`.
  function scheduleUpdate(): void {
    if (updateTimer || !cur) return;
    updateTimer = setTimeout(() => { updateTimer = null; if (cur) emit({ type: 'update', block: cur }); }, 80);
  }
  function endBlock(code: number | null): void {
    if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
    if (cur) { cur.exitCode = code; cur.running = false; cur.endedAt = Date.now(); emit({ type: 'end', block: cur }); cur = null; }
  }

  // Handle a recognized marker body (the text between "ESC]" and the terminator).
  function handleMarker(body: string): void {
    if (body.startsWith('133;')) {
      const rest = body.slice(4);
      if (rest === 'A' || rest === 'B') { mode = 'idle'; }
      else if (rest === 'C') { if (!cur) startBlock(''); mode = 'output'; }
      else if (rest[0] === 'D') {
        const code = parseInt(rest.slice(2), 10);
        endBlock(Number.isNaN(code) ? null : code);
        mode = 'idle';
      }
    } else if (body.startsWith('633;P;Cwd=')) {
      lastCwd = body.slice('633;P;Cwd='.length);
      if (cur) cur.cwd = lastCwd;
    } else if (body.startsWith('633;E;')) {
      startBlock(body.slice('633;E;'.length)); // the clean command line
      mode = 'idle'; // output starts at the following 133;C
    }
  }

  function isOurs(body: string): boolean {
    return body.startsWith('133;') || body.startsWith('633;P;Cwd=') || body.startsWith('633;E;');
  }

  function feed(chunk: string): string {
    const s = pending + chunk;
    pending = '';
    let out = '';
    let i = 0;
    let dirty = false;
    while (i < s.length) {
      const ch = s[i];
      if (ch === ESC) {
        if (i + 1 >= s.length) { pending = s.slice(i); break; } // lone trailing ESC — wait for more
        // Alt-screen switch (CSI ?1049h) => a full-screen app (vim/top). Flag the block and
        // stop capturing its output (the alt-screen bytes are noise), but pass them to xterm.
        if (s[i + 1] === '[' && cur && !cur.interactive && s.startsWith(ESC + '[?1049h', i)) { cur.interactive = true; dirty = true; }
        if (s[i + 1] === ']') {
          // OSC — scan for terminator BEL or ST (ESC\)
          let j = i + 2; let term = -1; let termLen = 0;
          while (j < s.length) {
            if (s[j] === BEL) { term = j; termLen = 1; break; }
            if (s[j] === ESC && s[j + 1] === '\\') { term = j; termLen = 2; break; }
            if (s[j] === ESC) break; // a new ESC before terminator — malformed; stop scanning
            j++;
          }
          if (term === -1) {
            const tail = s.slice(i);
            if (tail.length > 8192) { // too long to be one of our markers — flush as text (handles big pasted commands)
              if (appendOut(tail)) dirty = true;
              out += tail; i = s.length;
            } else { pending = tail; i = s.length; }
            break;
          }
          const body = s.slice(i + 2, term);
          if (isOurs(body)) {
            handleMarker(body); // strip (don't append to out)
          } else {
            const seq = s.slice(i, term + termLen); // pass unrecognized OSC through untouched
            if (appendOut(seq)) dirty = true;
            out += seq;
          }
          i = term + termLen;
          continue;
        }
      }
      // ordinary byte (incl. CSI sequences, which we never treat as markers)
      if (appendOut(ch)) dirty = true;
      out += ch;
      i++;
    }
    if (dirty && cur) scheduleUpdate();
    return out;
  }

  // Finalize any still-open block (e.g. the shell exited mid-command) so it isn't left running forever.
  function close(): void { endBlock(null); }

  return { feed, close };
}

// One-line snippet to send to the PTY once the shell is ready, enabling the markers above.
// '' for unsupported shells. `shell` is a lowercased basename ('powershell.exe','pwsh',
// 'bash','zsh',…). Keep it quiet beyond the normal prompt.
export function shellIntegrationInit(shell: string): string {
  const name = shell.replace(/\.exe$/, '');
  if (name === 'powershell' || name === 'pwsh') {
    // prompt fn: D(prev exit) + A + Cwd + visible prompt + B.  Enter handler: emit the clean
    // command line (633;E) + C(output start), respecting multi-line input.
    return [
      `Import-Module PSReadLine -ErrorAction SilentlyContinue`,
      `function global:prompt { $c=$global:LASTEXITCODE; if($null -eq $c){$c=0}; $e=[char]27; $b=[char]7; $p=$executionContext.SessionState.Path.CurrentLocation.Path; "$e]133;D;$c$b$e]133;A$b$e]633;P;Cwd=$p$b" + "PS $p> " + "$e]133;B$b" }`,
      `if (Get-Module PSReadLine) { Set-PSReadLineKeyHandler -Key Enter -ScriptBlock { $l=''; $k=0; [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$l,[ref]$k); $er=$null; [void][System.Management.Automation.Language.Parser]::ParseInput($l,[ref]$null,[ref]$er); if ($er | Where-Object { $_.IncompleteInput }) { [Microsoft.PowerShell.PSConsoleReadLine]::InsertLineBreak() } else { [Console]::Write("$([char]27)]633;E;$l$([char]7)$([char]27)]133;C$([char]7)"); [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine() } } }`,
    ].join('; ');
  }
  if (name === 'bash') {
    // PROMPT_COMMAND: D + Cwd, arm a flag.  DEBUG trap fires once per command: E + C.
    return `__relay_pc(){ local ec=$?; printf '\\033]133;D;%s\\007\\033]633;P;Cwd=%s\\007' "$ec" "$PWD"; __relay_arm=1; }; __relay_dbg(){ if [ -n "$__relay_arm" ]; then __relay_arm=; printf '\\033]633;E;%s\\007\\033]133;C\\007' "$BASH_COMMAND"; fi; }; PROMPT_COMMAND=__relay_pc; trap __relay_dbg DEBUG; PS1='\\[\\e]133;A\\a\\]'"$PS1"'\\[\\e]133;B\\a\\]'`;
  }
  if (name === 'zsh') {
    return `__relay_precmd(){ print -rn -- $'\\e]133;D;'$?$'\\a\\e]633;P;Cwd='$PWD$'\\a'; }; __relay_preexec(){ print -rn -- $'\\e]633;E;'$1$'\\a\\e]133;C\\a'; }; precmd_functions+=(__relay_precmd); preexec_functions+=(__relay_preexec); PS1=$'%{\\e]133;A\\a%}'$PS1$'%{\\e]133;B\\a%}'`;
  }
  return '';
}
