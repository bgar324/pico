import { constants, readdirSync } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/** Preserve inherited policies and credentials; only extend GUI launcher's PATH. */
export function toolEnvironment(): NodeJS.ProcessEnv {
  const home = homedir();
  const common = [join(home, '.bun/bin'), join(home, '.local/bin'), join(home, '.npm-global/bin'),
    join(home, '.volta/bin'), join(home, '.asdf/shims'), join(home, '.local/share/mise/shims'),
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin',
    '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  // Version managers often hold the only Node executable on GUI-launched machines.
  const versionRoots: readonly (readonly [string, string])[] = [[join(home, '.nvm/versions/node'), 'bin'],
    [join(home, '.fnm/node-versions'), 'installation/bin'], [join(home, '.local/share/fnm/node-versions'), 'installation/bin']];
  for (const [root, suffix] of versionRoots) {
    try {
      const versions = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() || entry.isSymbolicLink());
      versions.sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }));
      for (const version of versions) common.push(join(root, version.name, suffix));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'EACCES'].includes(String(error.code)))) throw error;
    }
  }
  const paths = (process.env.PATH ?? '').split(delimiter).filter(path => path.length > 0);
  return { ...process.env, PATH: [...new Set([...paths, ...common])].join(delimiter) };
}

/** An explicit override fails closed rather than silently selecting another OMP. */
export async function resolveExecutable(override: string): Promise<string | null> {
  const explicit = override.trim();
  const homeExpanded = explicit === '~' ? homedir() : explicit.startsWith('~/') ? join(homedir(), explicit.slice(2)) : explicit;
  const candidates = explicit ? [resolve(homeExpanded)] : (toolEnvironment().PATH ?? '').split(delimiter)
    .filter(isAbsolute).map(directory => join(directory, 'omp'));
  for (const candidate of new Set(candidates)) {
    try {
      const physical = await realpath(candidate);
      if (!(await stat(physical)).isFile()) continue;
      await access(physical, constants.X_OK);
      return physical;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].includes(String(error.code)))) throw error;
    }
  }
  return null;
}
