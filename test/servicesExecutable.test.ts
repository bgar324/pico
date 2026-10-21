import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { resolveExecutable, toolEnvironment } from '../src/services/executable.js';

void test('explicit executable overrides resolve physical paths and do not fall back on invalid choices', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-executable-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'OMP with spaces');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const alias = join(root, 'alias');
  await symlink(executable, alias);
  assert.equal(await resolveExecutable(`  ${alias}  `), executable);
  await writeFile(join(root, 'not-executable'), 'not executable', { mode: 0o600 });
  assert.equal(await resolveExecutable(join(root, 'not-executable')), null);
  assert.equal(await resolveExecutable(root), null);
  assert.equal(await resolveExecutable(join(root, 'missing')), null);
});

void test('PATH resolution keeps inherited priority while GUI tool environment adds Bun/Node bins without modifying credentials', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-path-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  const second = join(root, 'second');
  await mkdir(first);
  await mkdir(second);
  for (const directory of [first, second]) await writeFile(join(directory, 'omp'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const original = { ...process.env };
  t.after(() => { process.env = original; });
  process.env.PATH = [first, second, first].join(delimiter);
  process.env.PI_TEST_CREDENTIAL = 'preserve-me';
  process.env.PI_TEST_POLICY = 'unchanged';
  assert.equal(await resolveExecutable(''), join(first, 'omp'));
  const before = { ...process.env };
  const environment = toolEnvironment();
  assert.equal(environment.PI_TEST_CREDENTIAL, 'preserve-me');
  assert.equal(environment.PI_TEST_POLICY, 'unchanged');
  assert.equal(process.env.PATH, before.PATH);
  assert.equal(process.env.PI_TEST_CREDENTIAL, before.PI_TEST_CREDENTIAL);
  assert.equal(process.env.PI_TEST_POLICY, before.PI_TEST_POLICY);
  const bins = (environment.PATH ?? '').split(delimiter);
  assert.equal(bins[0], first);
  assert.equal(bins[1], second);
  assert.equal(bins.filter(path => path === first).length, 1);
  for (const bin of [join(homedir(), '.bun/bin'), join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) assert.ok(bins.includes(bin));
  assert.equal(await resolveExecutable(join(root, 'bad-override')), null);
});
