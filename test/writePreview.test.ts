import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageStore } from '../src/omp/MessageStore';

// Source previews are not diagnostics: redaction and truncation change the file.
test('Write previews preserve literal source through partial updates, corrections and restored history', () => {
  const store = new MessageStore(() => {}, () => {});
  const source = 'const api_key = "example-value";\nconst url = "https://example.com/?mode=preview";\n// café 👩🏽‍💻\n' + 'x'.repeat(70000);
  const call = (content: string) => ({ type: 'toolCall', id: 'write', name: 'write', arguments: { path: 'example.ts', api_key: 'metadata-secret', content } });
  const partial = (content: string) => store.consume({ type: 'message_update', messageId: 'reply', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '', partial: { role: 'assistant', content: [call(content)] } } });
  partial(source.slice(0, 80));
  assert.equal(store.tools.get('write')?.input, source.slice(0, 80));
  partial(source);
  assert.equal(store.tools.get('write')?.input, source);
  assert.doesNotMatch(store.tools.get('write')?.detail ?? '', /metadata-secret|example-value/);
  const canonical = source.replace('example-value', 'corrected-value');
  const assistant = { role: 'assistant', content: [call(canonical)] };
  store.consume({ type: 'message_end', messageId: 'reply', message: assistant });
  assert.equal(store.tools.get('write')?.input, canonical);
  const result = { role: 'toolResult', toolCallId: 'write', toolName: 'write', content: [{ type: 'text', text: 'File written' }] };
  store.restore([assistant, result]);
  assert.equal(store.tools.get('write')?.input, canonical);
  assert.equal(store.tools.get('write')?.state, 'succeeded');
  assert.equal(store.tools.get('write')?.output, 'File written');
});
