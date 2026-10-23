import { packager } from '@electron/packager';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const outputDirectory = process.env.PICO_PACKAGE_OUT ?? 'release';
const targetBundle = resolve(outputDirectory, `Pico-darwin-${process.arch}`, 'Pico.app');
// BSD pgrep excludes ancestors unless -a is supplied. Pico can be the parent
// of the agent running this script; helpers also keep its bundle in use.
const running = spawnSync('/usr/bin/pgrep', ['-a', '-f', targetBundle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')], { encoding: 'utf8' });
if (running.error) throw running.error;
if (running.status === 0) throw new Error(`Refusing to replace a running Pico bundle. Quit that build or set PICO_PACKAGE_OUT to a different directory: ${targetBundle}`);
if (running.status !== 1) throw new Error('Could not check whether the target Pico bundle is running. No files were replaced.');

const outputs = await packager({
  dir: '.', out: outputDirectory, name: 'Pico', platform: 'darwin', arch: process.arch,
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
