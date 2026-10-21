import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const outputs = await packager({
  dir: '.', out: 'release', name: 'Pico', platform: 'darwin', arch: process.arch,
  appBundleId: 'local.bg.PiDesktop', appVersion: '1.0.0', buildVersion: '1',
  icon: 'assets/Pico.icns', asar: true, overwrite: true,
  extraResource: ['node_modules/electron/dist/LICENSE', 'node_modules/electron/dist/LICENSES.chromium.html'],
  ignore: [/^\/src($|\/)/, /^\/test($|\/)/, /^\/scripts($|\/)/, /^\/Evidence($|\/)/, /^\/\.agents($|\/)/, /^\/build($|\/)/, /^\/release($|\/)/, /\.map$/],
});
for (const directory of outputs) {
  const bundle = resolve(directory, 'Pico.app');
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
  process.stdout.write(`Runnable application: ${bundle}\n`);
}
