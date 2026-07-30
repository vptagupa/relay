import { defineConfig } from 'vite';

// Main process bundle. Only the native addon (node-pty) is external — it can't be
// bundled and is copied into the packaged app (see forge.config.ts). The provider
// SDKs are pure JS and get bundled into main.js so they ship without node_modules.
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['node-pty'],
    },
  },
});
