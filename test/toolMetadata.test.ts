import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageStore } from '../src/omp/MessageStore';
import type { JsonRecord } from '../src/shared/types';

const patch = '*** Begin Patch\n[src/first.ts#A1B2]\nPUT 1.=1:\n+first\n[src/second.ts#C3D4]\nPUT 1.=1:\n+second\n*** End Patch\n';
const call = (id: string, name: string, args: JsonRecord): JsonRecord => ({ type: 'toolCall', id, name, arguments: args });
const store = () => new MessageStore(() => {}, () => {});

test('Edit extracts all file headers from the installed OMP input object shape', () => {
  const messages = store();
  messages.consume({ type: 'tool_execution_start', toolCallId: 'edit', toolName: 'edit', args: { input: patch } });
  assert.equal(messages.tools.get('edit')?.target, 'src/first.ts, src/second.ts');
  assert.equal(messages.tools.get('edit')?.input, undefined);
});

test('Edit partial snapshots wait for complete headers, grow and accept canonical corrections', () => {
  const messages = store();
  const partial = (input: string) => messages.consume({ type: 'message_update', messageId: 'reply', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '', partial: { role: 'assistant', content: [call('edit', 'edit', { input })] } } });
  partial('*** Begin Patch\n[src/first.ts#A1');
  assert.equal(messages.tools.get('edit')?.target, '');
  partial('*** Begin Patch\n[src/first.ts#A1B2]\nPUT 1.=1:\n+first\n[src/sec');
  assert.equal(messages.tools.get('edit')?.target, 'src/first.ts');
  partial(patch);
  assert.equal(messages.tools.get('edit')?.target, 'src/first.ts, src/second.ts');
  messages.consume({ type: 'message_end', messageId: 'reply', message: { role: 'assistant', content: [call('edit', 'edit', { input: '*** Begin Patch\n[src/corrected.ts#E5F6]\nREM\n*** End Patch\n' })] } });
  assert.equal(messages.tools.get('edit')?.target, 'src/corrected.ts');
});

test('Edit restored history retains all targets and completed state', () => {
  const messages = store();
  messages.restore([{ role: 'assistant', content: [call('edit', 'edit', { input: patch })] }, { role: 'toolResult', toolCallId: 'edit', toolName: 'edit', content: [{ type: 'text', text: 'Applied patch' }] }]);
  assert.equal(messages.tools.get('edit')?.target, 'src/first.ts, src/second.ts');
  assert.equal(messages.tools.get('edit')?.state, 'succeeded');
  assert.deepEqual(messages.messages.get('history-0')?.toolIDs, ['edit']);
});

test('Edit includes rename destinations once and ignores source text and incomplete controls', () => {
  const messages = store();
  const input = '*** Begin Patch\r\n[src/first.ts#A1B2]\r\nPUT 1.=1:\r\n+[src/not-a-target.ts#AAAA]\r\n+MV src/not-a-destination.ts\r\nMV "src/renamed file.ts"\r\n[src/first.ts#A1B2]\r\nMV src/final.ts\r\n[src/incomplete.ts#A1\r\n*** End Patch\r\n[src/outside.ts#AAAA]\r\n';
  messages.consume({ type: 'tool_execution_start', toolCallId: 'edit', toolName: 'edit', args: { input } });
  assert.equal(messages.tools.get('edit')?.target, 'src/first.ts, src/renamed file.ts, src/final.ts');
  messages.consume({ type: 'tool_execution_start', toolCallId: 'not-patch', toolName: 'edit', args: { input: '[src/not-a-patch.ts#AAAA]\nMV src/not-a-patch-either.ts' } });
  assert.equal(messages.tools.get('not-patch')?.target, '');
});

test('Edit preserves the full multi-file target list and redacts sensitive diagnostic metadata', () => {
  const messages = store();
  const paths = Array.from({ length: 140 }, (_, index) => `src/${'long-name-'.repeat(8)}${index}.ts`);
  const input = `*** Begin Patch\n${paths.map(path => `[${path}#A1B2]\nPUT 1.=1:\n+const api_key = "literal-source-value";`).join('\n')}\n*** End Patch\n`;
  messages.consume({ type: 'tool_execution_start', toolCallId: 'edit', toolName: 'edit', args: { input, i: 'Updating files token=metadata-secret', api_key: 'private-metadata' } });
  assert.equal(messages.tools.get('edit')?.target, paths.join(', '));
  assert.doesNotMatch(messages.tools.get('edit')?.detail ?? '', /metadata-secret|private-metadata/);
});

test('Eval uses authoritative title or i through live snapshots, execution and restoration', () => {
  const messages = store();
  const args = { language: 'py', code: 'open("not-an-authoritative-target.txt")', title: 'Inspecting tool metadata', timeout: 30, reset: false };
  const assistant = { role: 'assistant', content: [call('eval', 'eval', args)] };
  messages.consume({ type: 'message_update', messageId: 'reply', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, partial: assistant } });
  assert.equal(messages.tools.get('eval')?.target, args.title);
  messages.consume({ type: 'tool_execution_start', toolCallId: 'eval', toolName: 'eval', args });
  assert.equal(messages.tools.get('eval')?.target, args.title);
  messages.restore([assistant]);
  assert.equal(messages.tools.get('eval')?.target, args.title);
  messages.consume({ type: 'tool_execution_start', toolCallId: 'intent', toolName: 'eval', args: { ...args, i: 'Checking current metadata' } });
  assert.equal(messages.tools.get('intent')?.target, 'Checking current metadata');
  messages.consume({ type: 'tool_execution_start', toolCallId: 'empty-intent', toolName: 'eval', args: { ...args, i: ' ' } });
  assert.equal(messages.tools.get('empty-intent')?.target, args.title);
  messages.consume({ type: 'tool_execution_start', toolCallId: 'no-purpose', toolName: 'eval', args: { language: 'js', code: 'read("secret-file.txt")', path: 'not-authoritative.txt' } });
  assert.equal(messages.tools.get('no-purpose')?.target, '');
});

test('Read, Write and legacy Edit preserve ordinary path arguments without altering literal previews', () => {
  const messages = store();
  const cases: [string, JsonRecord, string][] = [
    ['read', { path: 'src/read.ts:10-20' }, 'src/read.ts:10-20'],
    ['read', { file_path: 'src/alternate.ts' }, 'src/alternate.ts'],
    ['write', { path: 'src/write.ts', content: 'const token = "literal-value";' }, 'src/write.ts'],
    ['edit', { path: 'src/legacy.ts', oldText: 'before', newText: 'after' }, 'src/legacy.ts'],
  ];
  for (const [name, args, target] of cases) {
    messages.consume({ type: 'tool_execution_start', toolCallId: target, toolName: name, args });
    assert.equal(messages.tools.get(target)?.target, target);
  }
  assert.equal(messages.tools.get('src/write.ts')?.input, 'const token = "literal-value";');
});
