import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveProjectLink } from '../src/services/links';

test('project file links resolve encoded paths and line fragments without opening outside the project', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pi-links-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'Project with spaces');
  const sibling = `${root}-other`;
  await mkdir(root); await mkdir(sibling);
  const name = 'notes 雪#1%.md';
  const target = join(root, name);
  const outside = join(sibling, 'private.md');
  await writeFile(target, 'Project documentation'); await writeFile(outside, 'Outside project');
  await symlink(target, join(root, 'inside.md')); await symlink(outside, join(root, 'outside.md'));
  assert.equal(await resolveProjectLink(root, `${encodeURIComponent(name)}#L42`), target);
  assert.equal(await resolveProjectLink(root, pathToFileURL(target).href), target);
  assert.equal(await resolveProjectLink(root, 'inside.md'), target);
  await assert.rejects(resolveProjectLink(root, 'outside.md'), /inside this conversation's project/);
  await assert.rejects(resolveProjectLink(root, '../Project%20with%20spaces-other/private.md'), /inside this conversation's project/);
  await assert.rejects(resolveProjectLink(root, pathToFileURL(outside).href), /inside this conversation's project/);
  for (const url of ['https://example.com/', 'file://remote-host/share/file', 'javascript:alert(1)', 'data:text/html,hi']) await assert.rejects(resolveProjectLink(root, url), /Only local project files/);
});
