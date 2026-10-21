import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { GitService, GitServiceError } from '../src/services/GitService.js';

const execute = promisify(execFile);
async function repository(t: { after(fn: () => Promise<void>): void }): Promise<{ root: string; base: string; git(args: string[]): Promise<void>; write(path: string, content: string | Buffer): Promise<void> }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pi-git-')));
  const root = join(base, 'Repo with spaces 雪\nfolder');
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(root);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const git = async (args: string[]): Promise<void> => {
    await execute('/usr/bin/git', ['--literal-pathspecs', '-c', 'user.name=Pico Tests', '-c', 'user.email=pi-tests@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, env });
  };
  const write = async (path: string, content: string | Buffer): Promise<void> => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await git(['init', '-b', 'main']);
  return { root, base, git, write };
}

void test('staged plus unstaged Unicode counts and diffs leave index byte-identical', async t => {
  const repo = await repository(t);
  const name = 'Sources/file with spaces 雪.ts';
  await repo.write(name, 'one\ntwo\n');
  await repo.git(['add', '--', name]);
  await repo.git(['commit', '-m', 'Initial']);
  await repo.write(name, 'one\ntwo\nstaged\n');
  await repo.git(['add', '--', name]);
  await repo.write(name, 'one\ntwo\nstaged\nunstaged\n');
  await repo.write('new folder/新 file.txt', 'untracked content\n');
  const before = await readFile(join(repo.root, '.git/index'));
  const service = new GitService();
  const snapshot = await service.snapshot(repo.root);
  assert.equal(snapshot.branch, 'main');
  const file = snapshot.files.find(file => file.path === name);
  assert.ok(file);
  assert.equal(file.status, 'MM');
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 0);
  const diff = await service.diff(repo.root, file);
  assert.match(diff.staged, /\+staged/);
  assert.doesNotMatch(diff.staged, /\+unstaged/);
  assert.match(diff.unstaged, /\+unstaged/);
  assert.equal(diff.truncated, false);
  const untracked = snapshot.files.find(file => file.path === 'new folder/新 file.txt');
  assert.ok(untracked);
  assert.equal(untracked.status, '??');
  assert.equal(untracked.additions, null);
  assert.deepEqual(await service.diff(repo.root, untracked), { staged: '', unstaged: '', truncated: false });
  assert.deepEqual(await readFile(join(repo.root, '.git/index')), before);
});

void test('rename tabs/newlines and pathspec magic remain literal across status, numstat and diff', async t => {
  const repo = await repository(t);
  const source = 'old 雪\tname\n.txt';
  const destination = ':(glob)* renamed\t雪\n.txt';
  await repo.write(source, 'first\nsecond\nthird\nfourth\nfifth\n');
  await repo.git(['add', '--', source]);
  await repo.git(['commit', '-m', 'Initial']);
  await repo.git(['mv', '--', source, destination]);
  await repo.write(destination, 'first\nsecond\nthird\nfourth\nfifth\nextra\n');
  const service = new GitService();
  const file = (await service.snapshot(repo.root)).files.find(file => file.path === destination);
  assert.ok(file);
  assert.equal(file.originalPath, source);
  assert.equal(file.status, 'RM');
  assert.equal(file.additions, 1);
  const diff = await service.diff(repo.root, file);
  assert.match(diff.staged, /rename from/);
  assert.match(diff.unstaged, /\+extra/);
  assert.doesNotMatch(diff.unstaged, /\+first/);
  assert.equal(await service.filePath(repo.root, file), join(repo.root, destination));
});

void test('nested symlink project uses repository-root-relative paths, including newline in root', async t => {
  const repo = await repository(t);
  await repo.write('nested/tracked.txt', 'before\n');
  await repo.git(['add', '.']);
  await repo.git(['commit', '-m', 'Initial']);
  await repo.write('nested/tracked.txt', 'after\n');
  const alias = join(repo.base, 'Alias');
  await symlink(join(repo.root, 'nested'), alias);
  const service = new GitService();
  const file = (await service.snapshot(alias)).files[0];
  assert.ok(file);
  assert.equal(file.path, 'nested/tracked.txt');
  assert.match((await service.diff(alias, file)).unstaged, /\+after/);
  assert.equal(await readFile(await service.filePath(alias, file), 'utf8'), 'after\n');
});

void test('useful non-repository/missing folder errors, unborn repository and detached branch', async t => {
  const repo = await repository(t);
  const service = new GitService();
  await assert.rejects(service.snapshot(repo.base), error => error instanceof GitServiceError && error.code === 'not-repository');
  await assert.rejects(service.snapshot(join(repo.base, 'Missing')), error => error instanceof GitServiceError && error.code === 'missing-project');
  assert.deepEqual(await service.snapshot(repo.root), { branch: 'main', files: [] });
  await repo.write('new.txt', 'new\n');
  await repo.git(['add', '.']);
  const file = (await service.snapshot(repo.root)).files[0];
  assert.ok(file);
  assert.equal(file.status, 'A ');
  assert.match((await service.diff(repo.root, file)).staged, /\+new/);
  await repo.git(['commit', '-m', 'Initial']);
  assert.deepEqual((await service.snapshot(repo.root)).files, []);
  await repo.git(['checkout', '--detach']);
  assert.match((await service.snapshot(repo.root)).branch, /^Detached at /);
});

void test('binary counts remain null and capped diff drains before subsequent inspection', async t => {
  const repo = await repository(t);
  await repo.write('large.txt', 'base\n');
  await repo.write('binary.dat', Buffer.from([0, 1, 2]));
  await repo.git(['add', '.']);
  await repo.git(['commit', '-m', 'Initial']);
  await repo.write('large.txt', 'base\n' + 'a fairly long changed 雪 line for the capped display\n'.repeat(20_000));
  await repo.write('binary.dat', Buffer.from([0, 4, 5, 6]));
  const service = new GitService();
  const snapshot = await service.snapshot(repo.root);
  const binary = snapshot.files.find(file => file.path === 'binary.dat');
  const large = snapshot.files.find(file => file.path === 'large.txt');
  assert.ok(binary && large);
  assert.equal(binary.additions, null);
  assert.equal(binary.deletions, null);
  assert.match((await service.diff(repo.root, binary)).unstaged, /Binary files/);
  const diff = await service.diff(repo.root, large);
  assert.equal(diff.truncated, true);
  assert.ok(Buffer.byteLength(diff.unstaged) <= GitService.diffLimit);
  assert.equal((await service.snapshot(repo.root)).files.length, 2);
});

void test('repository-configured extdiff, textconv and fsmonitor commands are never invoked', async t => {
  const repo = await repository(t);
  const marker = join(repo.base, 'unexpected-command');
  const script = join(repo.base, 'unsafe-hook.sh');
  await writeFile(script, `#!/bin/sh\nprintf invoked >> '${marker}'\nexit 0\n`, { mode: 0o700 });
  await repo.write('tracked.txt', 'before\n');
  await repo.write('.gitattributes', '*.txt diff=unsafe\n');
  await repo.git(['add', '.']);
  await repo.git(['commit', '-m', 'Initial']);
  await repo.git(['config', 'diff.external', script]);
  await repo.git(['config', 'diff.unsafe.textconv', script]);
  await repo.git(['config', 'core.fsmonitor', script]);
  await repo.write('tracked.txt', 'after\n');
  const before = await readFile(join(repo.root, '.git/index'));
  const service = new GitService();
  const file = (await service.snapshot(repo.root)).files.find(file => file.path === 'tracked.txt');
  assert.ok(file);
  assert.match((await service.diff(repo.root, file)).unstaged, /\+after/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(repo.root, '.git/index')), before);
});

void test('type changes retain status, and malformed NUL records/UTF-8/path traversal fail closed', async t => {
  const repo = await repository(t);
  await repo.write('tracked.txt', 'base\n');
  await repo.git(['add', '.']);
  await repo.git(['commit', '-m', 'Initial']);
  await rm(join(repo.root, 'tracked.txt'));
  await symlink('other.txt', join(repo.root, 'tracked.txt'));
  assert.equal((await new GitService().snapshot(repo.root)).files[0]!.status, ' T');
  const status = GitService.parseStatus(Buffer.from('R  new 雪 name\0old\tname\n\0?? :literal*\0'));
  assert.equal(status[0]!.originalPath, 'old\tname\n');
  assert.equal(status[1]!.path, ':literal*');
  const counts = GitService.parseNumstat(Buffer.from('3\t2\t\0old\tname\0new 雪 name\0-\t-\tbinary\0'));
  assert.deepEqual(counts.get('new 雪 name'), { additions: 3, deletions: 2 });
  assert.deepEqual(counts.get('binary'), { additions: null, deletions: null });
  for (const data of [Buffer.from('R  destination\0'), Buffer.from(' M unterminated'), Buffer.from(' M ../outside\0'), Buffer.from([32, 77, 32, 0xff, 0])]) assert.throws(() => GitService.parseStatus(data), GitServiceError);
  for (const value of ['1\t2\t\0only source\0', 'invalid\t2\tname\0', '9007199254740992\t0\tname\0']) assert.throws(() => GitService.parseNumstat(Buffer.from(value)), GitServiceError);
  await assert.rejects(new GitService().filePath(repo.root, { path: '../outside', status: ' M', originalPath: null, additions: null, deletions: null }), error => error instanceof GitServiceError && error.code === 'invalid-path');
});
