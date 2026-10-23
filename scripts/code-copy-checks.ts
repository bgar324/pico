import { renderMarkdown } from '../src/renderer/markdown';

function verify(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

export function checkCodeCopyReconciliation(host: HTMLElement): string {
  const body = document.createElement('div'); body.className = 'markdown'; host.append(body);
  try {
    renderMarkdown(body, 'Prose.\n\n```ts\nconst number = 1;\n', true);
    const control = body.querySelector<HTMLButtonElement>('.code-copy');
    verify(control, 'An unfinished fenced code block did not expose a copy control.');
    control.focus({ preventScroll: true });
    renderMarkdown(body, 'Prose.\n\n```ts\nconst number = 1;\nconsole.log(number);\n```', true);
    verify(body.querySelector('.code-copy') === control && document.activeElement === control, 'Streaming code replaced its focused copy control.');
    verify(body.querySelector('pre')?.textContent === 'const number = 1;\nconsole.log(number);\n', 'Code copying was polluted by generated controls or lost streamed content.');
    renderMarkdown(body, 'Prose.\n\n```python\nnumber = 2\n```', true);
    verify(body.querySelector('.code-copy') === control && document.activeElement === control && body.querySelector('pre')?.textContent === 'number = 2\n', 'A corrected code block lost its control or retained stale code.');
    renderMarkdown(body, '`inline code`\n\n```text\nfirst block\n```\n\n```html\n<script>literal text</script>\n```');
    verify(body.querySelectorAll('.code-copy').length === 2 && !body.querySelector('p .code-copy'), 'Code copies were shared across blocks or appeared on inline code.');
    verify(!body.querySelector('script') && body.querySelectorAll('pre')[1]?.textContent === '<script>literal text</script>\n', 'Fenced markup stopped being inert literal code.');
    renderMarkdown(body, 'No code remains.');
    verify(!body.querySelector('.code-copy'), 'Removing a code block retained an orphan copy control.');
    return 'Each code block retains its own focused copy control through streamed appends and source corrections; inline code has none, fenced markup stays literal, and removal clears controls.';
  } finally { body.remove(); }
}
