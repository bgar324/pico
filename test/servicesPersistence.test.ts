import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Persistence, PersistenceError } from '../src/services/Persistence.js';
import type { Manifest } from '../src/shared/types.js';

async function temporary(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'pi-services-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function legacyManifest(root: string): Manifest {
  const id = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
  return { projects: [{ id: '11111111-2222-3333-4444-555555555555', path: '/missing/project 雪', expanded: false }],
    threads: [{ id, projectPath: '/missing/project 雪', displayTitle: 'Saved title', ompSessionDirectory: join(root, 'Threads', id, 'OMP'),
      createdAt: '2025-12-01T01:02:03Z', updatedAt: '2026-10-12T02:03:04.123456Z', draft: 'Unsent\n雪 draft', lastModel: 'provider/model', wasRunning: true }],
    selectedThreadID: id, sidebarVisible: false };
}

void test('first launch and legacy Swift metadata round-trip preserve IDs, ISO dates, drafts and session paths', async t => {
  const base = await temporary(t);
  const root = join(base, 'App Support');
  const service = new Persistence(root);
  assert.deepEqual(await service.load(), { projects: [], threads: [], selectedThreadID: null, sidebarVisible: true });
  const manifest = legacyManifest(root);
  await mkdir(root);
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  const loaded = await service.load();
  assert.deepEqual(loaded, manifest);
  assert.equal(service.sessionDirectory(manifest.threads[0]!.id), manifest.threads[0]!.ompSessionDirectory);
  await service.save(loaded);
  assert.deepEqual(await new Persistence(root).load(), manifest);
  assert.deepEqual(await readdir(root), ['manifest.json']);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')), manifest);
  const prefs = await service.loadPreferences();
  assert.equal(prefs.appearance, 'system');
  assert.equal(prefs.defaultProjectPath, manifest.threads[0]!.projectPath);
  await service.savePreferences({ ...prefs, appearance: 'dark', executableOverride: '/custom/omp', sidebarWidth: 260 });
  assert.deepEqual(await service.loadPreferences(), { ...prefs, appearance: 'dark', executableOverride: '/custom/omp', sidebarWidth: 260 });
});

void test('saved sidebar widths outside the current resize range are clamped without rewriting preferences on read', async t => {
  const root = await temporary(t);
  const service = new Persistence(root);
  for (const [sidebarWidth, expected] of [[180, 240], [600, 520]]) {
    const saved = { appearance: 'dark', executableOverride: '', defaultProjectPath: '', sidebarWidth };
    await writeFile(join(root, 'prefs.json'), JSON.stringify(saved));
    assert.equal((await service.loadPreferences()).sidebarWidth, expected);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'prefs.json'), 'utf8')), saved);
  }
});

void test('missing optional Swift keys receive defaults, selected UUID casing follows stored ID', async t => {
  const root = await temporary(t);
  const fixture = legacyManifest(root);
  const thread = fixture.threads[0]!;
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ projects: [{ id: fixture.projects[0]!.id, path: '/project' }],
    threads: [{ id: thread.id, projectPath: thread.projectPath, ompSessionDirectory: thread.ompSessionDirectory, createdAt: thread.createdAt, updatedAt: thread.updatedAt }] }));
  const service = new Persistence(root);
  const loaded = await service.load();
  assert.equal(loaded.selectedThreadID, null);
  assert.equal(loaded.sidebarVisible, true);
  assert.equal(loaded.projects[0]!.expanded, true);
  assert.equal(loaded.threads[0]!.draft, '');
  assert.equal(loaded.threads[0]!.displayTitle, 'New thread');
  assert.equal(loaded.threads[0]!.wasRunning, false);
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...fixture, selectedThreadID: thread.id.toLowerCase() }));
  assert.equal((await service.load()).selectedThreadID, thread.id);
});

void test('corrupt, malformed, invalid UTF-8 and symlink metadata fail closed without resetting or overwriting', async t => {
  const root = await temporary(t);
  const service = new Persistence(root);
  const manifest = join(root, 'manifest.json');
  for (const bytes of [Buffer.from('{broken'), Buffer.from('{"projects":[],"threads":[],"sidebarVisible":"wrong"}'), Buffer.from([0xff])]) {
    await writeFile(manifest, bytes);
    await assert.rejects(service.load(), error => error instanceof PersistenceError && error.code === 'unreadable-metadata');
    await assert.rejects(service.save(legacyManifest(root)), error => error instanceof PersistenceError && error.code === 'unreadable-metadata');
    assert.deepEqual(await readFile(manifest), bytes);
  }
  await rm(manifest);
  await mkdir(manifest);
  await assert.rejects(service.load(), PersistenceError);
  await rm(manifest, { recursive: true });
  const outside = join(root, 'outside.json');
  await writeFile(outside, JSON.stringify(legacyManifest(root)));
  await symlink(outside, manifest);
  await assert.rejects(service.load(), PersistenceError);
  await assert.rejects(service.save(legacyManifest(root)), PersistenceError);
  assert.deepEqual(JSON.parse(await readFile(outside, 'utf8')), legacyManifest(root));
});

void test('invalid prefs remain intact and queued writes use complete atomic files', async t => {
  const root = await temporary(t);
  const service = new Persistence(root);
  await writeFile(join(root, 'prefs.json'), '{broken');
  await assert.rejects(service.loadPreferences(), PersistenceError);
  await assert.rejects(service.savePreferences({ appearance: 'system', executableOverride: '', defaultProjectPath: '', sidebarWidth: 244 }), PersistenceError);
  assert.equal(await readFile(join(root, 'prefs.json'), 'utf8'), '{broken');
  await rm(join(root, 'prefs.json'));
  const manifest = legacyManifest(root);
  await Promise.all(Array.from({ length: 12 }, (_, index) => service.save({ ...manifest, threads: manifest.threads.map(thread => ({ ...thread, draft: `draft-${index}` })) })));
  assert.equal((await service.load()).threads[0]!.draft, 'draft-11');
  assert.deepEqual(await readdir(root), ['manifest.json']);
});

void test('deletion is idempotent, scoped to chosen UUID, and unlinks nested outside symlinks without traversal', async t => {
  const base = await temporary(t);
  const service = new Persistence(join(base, 'Support'));
  const chosen = randomUUID().toUpperCase();
  const other = randomUUID();
  const outside = join(base, 'Repository');
  await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), 'keep');
  await mkdir(service.sessionDirectory(chosen), { recursive: true });
  await mkdir(service.sessionDirectory(other), { recursive: true });
  await writeFile(join(service.sessionDirectory(chosen), 'session.jsonl'), 'saved');
  await symlink(outside, join(service.sessionDirectory(chosen), 'linked-project'));
  await symlink('/missing/path', join(service.sessionDirectory(chosen), 'broken-link'));
  await service.deleteThreadStorage(chosen);
  await assert.rejects(readdir(join(service.root, 'Threads', chosen)), { code: 'ENOENT' });
  assert.deepEqual(await readdir(service.sessionDirectory(other)), []);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep');
  await service.deleteThreadStorage(chosen);
  assert.throws(() => service.sessionDirectory('../Repository'));
  assert.throws(() => service.deleteThreadStorage('../Repository'));
});

void test('deletion rejects symlinked thread, Threads and replaced app root', async t => {
  const base = await temporary(t);
  const root = join(base, 'Support');
  const outside = join(base, 'Outside');
  const id = randomUUID();
  await mkdir(join(root, 'Threads'), { recursive: true });
  await mkdir(join(outside, 'Threads', id), { recursive: true });
  await writeFile(join(outside, 'Threads', id, 'keep.txt'), 'keep');
  const service = new Persistence(root);
  const unsafe = (error: unknown): boolean => error instanceof PersistenceError && error.code === 'unsafe-storage';
  await symlink(outside, join(root, 'Threads', id));
  await assert.rejects(service.deleteThreadStorage(id), unsafe);
  await rm(join(root, 'Threads', id));
  await rmdir(join(root, 'Threads'));
  await symlink(outside, join(root, 'Threads'));
  await assert.rejects(service.deleteThreadStorage(id), unsafe);
  await rm(join(root, 'Threads'));
  await rmdir(root);
  await symlink(outside, root);
  await assert.rejects(service.deleteThreadStorage(id), unsafe);
  assert.equal(await readFile(join(outside, 'Threads', id, 'keep.txt'), 'utf8'), 'keep');
  assert.throws(() => new Persistence(root), unsafe);
});

void test('physical ancestor canonicalization supports legacy macOS /var and /tmp aliases', async t => {
  const base = await temporary(t);
  const alias = join(base, 'Alias');
  await symlink(base, alias);
  const service = new Persistence(join(alias, 'not-yet-created', 'Support'));
  assert.equal(service.root, join(base, 'not-yet-created', 'Support'));
  const id = randomUUID();
  await mkdir(service.sessionDirectory(id), { recursive: true });
  await service.deleteThreadStorage(id);
  assert.deepEqual(await readdir(join(service.root, 'Threads')), []);
});
