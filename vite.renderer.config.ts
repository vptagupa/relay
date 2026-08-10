import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Bake build-time facts into the renderer for the About dialog: the app version + the 3 most recent commit
// subjects. Captured here (build machine, in the repo) because the DISTRIBUTED app has no git repo to query.
function recentCommits(): string[] {
  try { return execSync('git log -3 --pretty=format:%s', { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean); }
  catch { return []; }
}
function appVersion(): string {
  try { return String(JSON.parse(readFileSync('./package.json', 'utf8')).version || ''); } catch { return ''; }
}

export default defineConfig({
  // Keep sourcemaps so the renderer crash-logger (see main.ts / renderer error handlers)
  // produces mappable stacks; flip `minify: false` here if a logged stack is unreadable.
  build: { sourcemap: true },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
    __RECENT_COMMITS__: JSON.stringify(recentCommits()),
  },
});
