import electron from 'electron';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'pi-electron-smoke-'));
await mkdir(join(root, 'Support'), { recursive: true });
await mkdir(join(root, 'Evidence'), { recursive: true });
process.stdout.write(`Isolated Electron smoke: ${root}\n`);
for (const mode of ['--integration-smoke', '--resume-smoke']) {
  const completion = Promise.withResolvers();
  const child = spawn(electron, ['--headless=new', '--disable-gpu', resolve('.'), mode], {
    env: { ...process.env, PI_DESKTOP_SUPPORT: join(root, 'Support'), PI_DESKTOP_EVIDENCE: join(root, 'Evidence') },
    stdio: 'inherit',
  });
  child.once('error', completion.reject);
  child.once('exit', (code, signal) => completion.resolve(code ?? (signal ? 1 : 0)));
  const code = await completion.promise;
  if (code !== 0) { process.exitCode = code; break; }
}
process.stdout.write(`Evidence: ${join(root, 'Evidence')}\n`);
