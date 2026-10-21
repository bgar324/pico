import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist/renderer', { recursive: true });
await Promise.all([
  build({ entryPoints: ['src/main/index.ts'], outfile: 'dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: true }),
  build({ entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: true }),
  build({ entryPoints: ['src/renderer/index.ts'], outfile: 'dist/renderer/app.js', bundle: true, platform: 'browser', format: 'iife', target: 'chrome136', minify: true, sourcemap: true, loader: { '.svg': 'text' } }),
  copyFile('src/renderer/index.html', 'dist/renderer/index.html'),
  copyFile('src/renderer/style.css', 'dist/renderer/style.css'),
]);
