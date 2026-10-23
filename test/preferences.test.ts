import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppController, type DesktopHost } from '../src/main/AppController';
import { Persistence } from '../src/services/Persistence';

test('appearance follows the system, persists explicit choices, and never publishes a failed save', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pico-preferences-'));
  let dark = false;
  const host: DesktopHost = {
    chooseDirectory: async () => null, chooseExecutable: async () => null, chooseImages: async () => [],
    confirmDelete: async () => false, confirmTerminal: async () => false,
    reveal: async () => {}, terminal: async () => {}, darkMode: () => dark,
  };
  const persistence = new Persistence(root);
  await persistence.savePreferences({ executableOverride: join(root, 'missing-omp'), appearance: 'system', defaultProjectPath: '', sidebarWidth: 340 });
  const app = new AppController(persistence, host, () => {});
  t.after(async () => {
    try { await app.shutdown(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  await app.bootstrap();
  assert.equal(app.info().theme, 'light');
  dark = true;
  assert.equal(app.info().theme, 'dark');
  await app.updatePreferences({ ...app.preferences, appearance: 'light' });
  assert.equal(app.info().theme, 'light');
  assert.equal((await persistence.loadPreferences()).appearance, 'light');
  await writeFile(join(root, 'prefs.json'), '{ damaged preferences');
  await assert.rejects(app.updatePreferences({ ...app.preferences, appearance: 'dark' }));
  assert.equal(app.info().theme, 'light');
  assert.equal(app.info().preferences.appearance, 'light');
  assert.equal(await readFile(join(root, 'prefs.json'), 'utf8'), '{ damaged preferences');
});
