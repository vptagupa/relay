import { defineConfig } from 'vite';

export default defineConfig({
  // Keep sourcemaps so the renderer crash-logger (see main.ts / renderer error handlers)
  // produces mappable stacks; flip `minify: false` here if a logged stack is unreadable.
  build: { sourcemap: true },
});
