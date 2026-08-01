import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { cp } from 'node:fs/promises';
import path from 'node:path';

const config: ForgeConfig = {
  packagerConfig: {
    // node-pty is a native module — keep its files on disk (unpacked from the asar)
    // so the compiled binaries can be loaded at runtime.
    asar: { unpack: '**/node_modules/node-pty/**' },
    name: 'Slayer T',          // product / display name (Task Manager, Add/Remove, userData folder)
    executableName: 'SlayerT', // space-free exe → SlayerT.exe
    icon: './assets/icon', // packager appends .ico (Win) / .icns (macOS) automatically
  },
  // node-pty ships ABI-stable N-API prebuilds, so no from-source rebuild is needed
  // (which also avoids node-gyp failing on toolchains it can't auto-detect).
  rebuildConfig: { onlyModules: [] },
  makers: [
    { name: '@electron-forge/maker-squirrel', config: { name: 'SlayerT', title: 'Slayer T', authors: 'Slayer T', exe: 'SlayerT.exe', setupExe: 'Slayer T Setup.exe', setupIcon: './assets/icon.ico' } }, // Windows .exe installer → installs to %LOCALAPPDATA%\SlayerT
    { name: '@electron-forge/maker-zip', config: {}, platforms: ['darwin'] },                // macOS
    { name: '@electron-forge/maker-deb', config: { options: { icon: './assets/icon.png' } } }, // Linux
    { name: '@electron-forge/maker-rpm', config: { options: { icon: './assets/icon.png' } } }, // Linux
  ],
  hooks: {
    // The Vite plugin bundles JS deps into the app but does NOT ship node_modules.
    // Native modules can't be bundled, so copy node-pty into the packaged app so
    // require('node-pty') resolves. (Pure-JS SDKs are bundled into main.js instead.)
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      await cp(
        path.join(process.cwd(), 'node_modules', 'node-pty'),
        path.join(buildPath, 'node_modules', 'node-pty'),
        { recursive: true },
      );
    },
  },
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
  ],
};

export default config;
