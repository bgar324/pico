import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { GitDiff, GitFileChange, GitSnapshot } from '../shared/types.js';
import { toolEnvironment } from './executable.js';

export class GitServiceError extends Error {
  constructor(readonly code: 'unavailable' | 'not-repository' | 'missing-project' | 'command' | 'malformed-output' | 'output-too-large' | 'invalid-path', message: string) {
    super(message);
    this.name = 'GitServiceError';
  }
}
interface Counts { additions: number | null; deletions: number | null }
interface CommandResult { stdout: Buffer; stderr: string; status: number; truncated: boolean }
const LIST_LIMIT = 4 * 1024 * 1024;
const DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv', '--no-color', '--find-renames'];

/** Git filenames are literal root-relative paths, never option strings or pathspec programs. */
function validatePath(path: string): void {
  if (!path || isAbsolute(path) || path.includes('\0') || path.split('/').some(component => component === '..' || component === '.' || component === '')) {
    throw new GitServiceError('invalid-path', 'The file path is not a repository-relative path.');
  }
}

/** A single owner drains both streams to completion even after either retention cap. */
function run(arguments_: string[], directory: string, limit = LIST_LIMIT, allowedStatuses: readonly number[] = [0]): Promise<CommandResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
  const environment = toolEnvironment();
  for (const key of Object.keys(environment)) if (key.startsWith('GIT_')) delete environment[key];
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.LC_ALL = 'C';
  const process = spawn('/usr/bin/git', ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'color.ui=false', ...arguments_],
    { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const outputs: Buffer[] = [];
  const errors: Buffer[] = [];
  let outputLength = 0;
  let errorLength = 0;
  let truncated = false;
  let streamError: Error | null = null;
  process.stdout.on('data', (chunk: Buffer) => {
    const remaining = limit - outputLength;
    if (chunk.length > remaining) truncated = true;
    if (remaining > 0) { const kept = chunk.subarray(0, remaining); outputs.push(kept); outputLength += kept.length; }
  });
  process.stderr.on('data', (chunk: Buffer) => {
    const remaining = 16 * 1024 - errorLength;
    if (remaining > 0) { const kept = chunk.subarray(0, remaining); errors.push(kept); errorLength += kept.length; }
  });
  for (const stream of [process.stdout, process.stderr]) stream.on('error', (error: Error) => { streamError = error; });
  process.once('error', (error: Error) => reject(new GitServiceError('unavailable', `Git could not start: ${error.message}. Install the Xcode command line tools and retry.`)));
  process.once('close', (status, signal) => {
    if (streamError !== null) { reject(new GitServiceError('command', `Could not read Git output: ${streamError.message}`)); return; }
    const stderr = Buffer.concat(errors, errorLength).toString('utf8').trim();
    if (status === null || !allowedStatuses.includes(status)) {
      reject(new GitServiceError('command', `Could not read Git changes: ${stderr || (signal ? `Git terminated by ${signal}.` : `Git exited with status ${status}.`)}`));
      return;
    }
    resolve({ stdout: Buffer.concat(outputs, outputLength), stderr, status, truncated });
  });
  return promise;
}

class NULCursor {
  private offset = 0;
  constructor(private readonly data: Buffer) {}
  next(): string | null {
    if (this.offset === this.data.length) return null;
    const end = this.data.indexOf(0, this.offset);
    if (end < 0) throw new GitServiceError('malformed-output', 'Git returned an incomplete NUL-delimited record.');
    let value: string;
    try { value = new TextDecoder('utf-8', { fatal: true }).decode(this.data.subarray(this.offset, end)); }
    catch { throw new GitServiceError('malformed-output', 'Git returned a filename that is not valid UTF-8.'); }
    this.offset = end + 1;
    return value;
  }
}

export class GitService {
  static readonly diffLimit = 512 * 1024;

  private async repositoryRoot(projectPath: string): Promise<string> {
    let physical: string;
    try {
      physical = await realpath(projectPath);
      if (!(await stat(physical)).isDirectory()) throw new Error('Not a directory.');
    } catch (error) {
      throw new GitServiceError('missing-project', `Project folder is missing or inaccessible: ${projectPath}. ${error instanceof Error ? error.message : String(error)}`);
    }
    const root = await run(['rev-parse', '--show-toplevel'], physical, LIST_LIMIT, [0, 128]);
    if (root.status !== 0) {
      if (root.stderr.includes('not a git repository') || root.stderr.includes('must be run in a work tree')) throw new GitServiceError('not-repository', 'Not a Git repository.');
      throw new GitServiceError('command', `Could not locate the Git work tree: ${root.stderr}`);
    }
    let path: string;
    try { path = new TextDecoder('utf-8', { fatal: true }).decode(root.stdout); }
    catch { throw new GitServiceError('malformed-output', 'Git returned a work tree path that is not valid UTF-8.'); }
    if (path.endsWith('\n')) path = path.slice(0, -1);
    if (root.truncated || !isAbsolute(path) || !path) throw new GitServiceError('malformed-output', 'Git returned an invalid work tree path.');
    return realpath(path);
  }

  async snapshot(projectPath: string): Promise<GitSnapshot> {
    const root = await this.repositoryRoot(projectPath);
    const [status, staged, unstaged, symbolic] = await Promise.all([
      run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root),
      run(['diff', '--cached', '--numstat', '-z', ...DIFF_OPTIONS], root),
      run(['diff', '--numstat', '-z', ...DIFF_OPTIONS], root),
      run(['symbolic-ref', '--quiet', '--short', 'HEAD'], root, LIST_LIMIT, [0, 1]),
    ]);
    if (status.truncated || staged.truncated || unstaged.truncated || symbolic.truncated) throw new GitServiceError('output-too-large', 'The change list is too large to display. Open the repository in your source-control tool.');
    const files = GitService.parseStatus(status.stdout);
    const stagedCounts = GitService.parseNumstat(staged.stdout);
    const unstagedCounts = GitService.parseNumstat(unstaged.stdout);
    for (const file of files) {
      if (file.status === '??') continue;
      const counts = [stagedCounts.get(file.path), unstagedCounts.get(file.path)].filter((value): value is Counts => value !== undefined);
      if (counts.length > 0) {
        file.additions = counts.some(count => count.additions === null) ? null : counts.reduce((sum, count) => sum + (count.additions ?? 0), 0);
        file.deletions = counts.some(count => count.deletions === null) ? null : counts.reduce((sum, count) => sum + (count.deletions ?? 0), 0);
      }
    }
    let branch = symbolic.stdout.toString('utf8').replace(/\n$/, '');
    if (symbolic.status !== 0) {
      const head = await run(['rev-parse', '--short', 'HEAD'], root);
      branch = `Detached at ${head.stdout.toString('utf8').replace(/\n$/, '')}`;
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    return { branch, files };
  }

  async diff(projectPath: string, file: GitFileChange): Promise<GitDiff> {
    validatePath(file.path);
    const root = await this.repositoryRoot(projectPath);
    if (file.status === '??') return { staged: '', unstaged: '', truncated: false };
    const paths = [file.path];
    if (file.originalPath !== null && file.originalPath !== file.path) { validatePath(file.originalPath); paths.push(file.originalPath); }
    const options = [...DIFF_OPTIONS, '--unified=3', '--', ...paths];
    const [staged, unstaged] = await Promise.all([
      run(['diff', '--cached', ...options], root, GitService.diffLimit),
      run(['diff', ...options], root, GitService.diffLimit),
    ]);
    // Exclude a partial final UTF-8 code point and cap replacement-decoded output too.
    const text = (data: Buffer): string => {
      const decoded = new StringDecoder('utf8').write(data);
      return new StringDecoder('utf8').write(Buffer.from(decoded, 'utf8').subarray(0, GitService.diffLimit));
    };
    return { staged: text(staged.stdout), unstaged: text(unstaged.stdout), truncated: staged.truncated || unstaged.truncated };
  }

  async filePath(projectPath: string, file: GitFileChange): Promise<string> {
    validatePath(file.path);
    return join(await this.repositoryRoot(projectPath), file.path);
  }

  /** Porcelain v1 -z reverses rename paths: destination first, source second. */
  static parseStatus(data: Buffer): GitFileChange[] {
    const cursor = new NULCursor(data);
    const files: GitFileChange[] = [];
    let record: string | null;
    while ((record = cursor.next()) !== null) {
      if (record.length < 4 || record[2] !== ' ' || !/^[ MADRCTU?!]{2}$/.test(record.slice(0, 2))) throw new GitServiceError('malformed-output', 'Git returned malformed porcelain status.');
      const status = record.slice(0, 2);
      const path = record.slice(3);
      validatePath(path);
      let originalPath: string | null = null;
      if (status.includes('R') || status.includes('C')) {
        originalPath = cursor.next();
        if (originalPath === null) throw new GitServiceError('malformed-output', 'Git returned an incomplete rename record.');
        validatePath(originalPath);
      }
      files.push({ path, status, additions: null, deletions: null, originalPath });
    }
    return files;
  }

  /** Only the first two tabs delimit counts. Filename tabs and newlines are data. */
  static parseNumstat(data: Buffer): Map<string, Counts> {
    const cursor = new NULCursor(data);
    const counts = new Map<string, Counts>();
    let record: string | null;
    while ((record = cursor.next()) !== null) {
      const first = record.indexOf('\t');
      const second = record.indexOf('\t', first + 1);
      if (first < 1 || second < 0) throw new GitServiceError('malformed-output', 'Git returned malformed numstat.');
      const added = record.slice(0, first);
      const deleted = record.slice(first + 1, second);
      if (!/^(?:-|\d+)$/.test(added) || !/^(?:-|\d+)$/.test(deleted) ||
        (added !== '-' && !Number.isSafeInteger(Number(added))) || (deleted !== '-' && !Number.isSafeInteger(Number(deleted)))) throw new GitServiceError('malformed-output', 'Git returned invalid line counts.');
      let path = record.slice(second + 1);
      if (!path) {
        const source = cursor.next();
        const destination = cursor.next();
        if (source === null || destination === null) throw new GitServiceError('malformed-output', 'Git returned an incomplete numstat rename.');
        validatePath(source);
        path = destination;
      }
      validatePath(path);
      counts.set(path, { additions: added === '-' ? null : Number(added), deletions: deleted === '-' ? null : Number(deleted) });
    }
    return counts;
  }
}
