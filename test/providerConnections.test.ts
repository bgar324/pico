import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectionsSnapshot } from '../src/shared/connections.js';
import { ProviderConnections } from '../src/services/ProviderConnections.js';

void test('a browser flow reserves its identity before asynchronous executable discovery and cancellation cannot be lost', { timeout: 5000 }, async t => {
  const lookupStarted = Promise.withResolvers<void>();
  const executable = Promise.withResolvers<string | null>();
  const snapshots: ConnectionsSnapshot[] = [];
  const connections = new ProviderConnections(async () => {
    lookupStarted.resolve();
    return executable.promise;
  }, snapshot => snapshots.push(snapshot), async () => {});
  t.after(() => { executable.resolve(null); return connections.shutdown(); });

  const started = await connections.login('anthropic', 'first-flow');
  assert.equal(started.auth.kind, 'pending');
  await lookupStarted.promise;
  await assert.rejects(connections.login('openai-codex', 'overlapping-flow'), /Finish or cancel/);
  const cancellation = connections.cancel('first-flow');
  assert.equal(snapshots.at(-1)?.auth.kind, 'idle');
  executable.resolve(null);
  // Cancellation must still report failure to refresh status when OMP is
  // unavailable, without retaining the old flow or restarting its login.
  await assert.rejects(cancellation, /OMP was not found/);
  assert.equal(snapshots.at(-1)?.auth.kind, 'idle');
  assert.equal(snapshots.filter(snapshot => snapshot.auth.kind === 'pending').length, 1);
  let previousRevision = -1;
  for (const snapshot of snapshots) {
    assert.ok(snapshot.revision > previousRevision);
    previousRevision = snapshot.revision;
  }

  const next = await connections.login('openai-codex', 'next-flow');
  assert.equal(next.auth.kind, 'pending');
  const nextCancellation = connections.cancel('next-flow');
  await assert.rejects(nextCancellation, /OMP was not found/);
  assert.equal(snapshots.at(-1)?.auth.kind, 'idle');
});

void test('unsupported login methods and malformed secret input are rejected before an OMP process can start', { timeout: 5000 }, async t => {
  let lookups = 0;
  const connections = new ProviderConnections(async () => { lookups++; return null; }, () => {}, async () => {});
  t.after(() => connections.shutdown());
  await assert.rejects(connections.login('github-copilot', 'unsupported'), /available browser sign-in/);
  await assert.rejects(connections.login('__proto__', 'unsupported'), /available browser sign-in/);
  await assert.rejects(connections.setApiKey('openai', '  '), /nonempty API key/);
  await assert.rejects(connections.setApiKey('openai', 'first\nsecond'), /line breaks/);
  await assert.rejects(connections.disconnect('openai', 1.5), /stored account/);
  assert.equal(lookups, 0);
});

void test('stale prompts and cancellation identities cannot affect a different pending login', { timeout: 5000 }, async t => {
  const snapshots: ConnectionsSnapshot[] = [];
  const executable = Promise.withResolvers<string | null>();
  const connections = new ProviderConnections(async () => executable.promise, snapshot => snapshots.push(snapshot), async () => {});
  t.after(() => { executable.resolve(null); return connections.shutdown(); });
  await connections.login('anthropic', 'current');
  const current = snapshots.at(-1);
  assert.equal((await connections.cancel('stale')).revision, current?.revision);
  await assert.rejects(connections.submit('stale', 'prompt', 'callback-code-must-not-be-retained'), /expired/);
  assert.equal(JSON.stringify(snapshots).includes('callback-code-must-not-be-retained'), false);
  const cancellation = connections.cancel('current');
  executable.resolve(null);
  await assert.rejects(cancellation, /OMP was not found/);
  assert.equal(snapshots.at(-1)?.auth.kind, 'idle');
});
