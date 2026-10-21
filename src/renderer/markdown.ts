import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { element, request } from './dom';
import { captureTextSelection, restoreTextSelection } from './selection';

type TextRun = { kind: 'text'; nodes: (Text | HTMLSpanElement)[]; text: string };
type Child = TextRun | { kind: 'node'; node: ChildNode };
const words = new Intl.Segmenter(undefined, { granularity: 'word' });
const renderedSources = new WeakMap<HTMLElement, string>();

function isWord(node: Node): node is HTMLSpanElement {
  return node instanceof HTMLSpanElement && node.className === 'stream-word';
}

/** Animation wrappers and neighboring Text nodes are one canonical text run. */
function children(parent: HTMLElement): Child[] {
  const result: Child[] = [];
  for (const node of parent.childNodes) {
    if (node instanceof Text || isWord(node)) {
      const previous = result[result.length - 1];
      if (previous?.kind === 'text') { previous.nodes.push(node); previous.text += node.textContent ?? ''; }
      else result.push({ kind: 'text', nodes: [node], text: node.textContent ?? '' });
    } else result.push({ kind: 'node', node });
  }
  return result;
}

function wordFragment(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const { segment } of words.segment(text)) {
    fragment.append(/\S/u.test(segment) ? element('span', 'stream-word', segment) : document.createTextNode(segment));
  }
  return fragment;
}

function revealNew(node: Node): void {
  if (!(node instanceof HTMLElement) || ['PRE', 'CODE', 'BUTTON'].includes(node.tagName)) return;
  for (const child of Array.from(node.childNodes)) {
    if (child instanceof Text) {
      if (/\S/u.test(child.data)) child.replaceWith(wordFragment(child.data));
    } else revealNew(child);
  }
}

function appendText(run: TextRun, value: string, animate: boolean): void {
  const last = run.nodes[run.nodes.length - 1];
  if (!last) return;
  const suffix = value.slice(run.text.length);
  if (!suffix) return;
  const tail = last instanceof Text ? last : last.firstChild;
  if (!(tail instanceof Text)) return;
  if (!animate) { tail.appendData(suffix); return; }
  // Segment across the append boundary so partial words, emoji and combining
  // marks keep their original span and never restart its animation.
  const combined = tail.data + suffix;
  let continuation = 0;
  for (const part of words.segment(combined)) {
    if (part.index >= tail.length) break;
    continuation = Math.max(0, part.index + part.segment.length - tail.length);
  }
  if (continuation) tail.appendData(suffix.slice(0, continuation));
  if (continuation < suffix.length) last.after(wordFragment(suffix.slice(continuation)));
}

function compatible(old: Child, incoming: Child): boolean {
  if (old.kind === 'text' && incoming.kind === 'text') return incoming.text.startsWith(old.text);
  return old.kind === 'node' && incoming.kind === 'node' &&
    old.node instanceof HTMLElement && incoming.node instanceof HTMLElement &&
    old.node.tagName === incoming.node.tagName && old.node.className === incoming.node.className;
}

/** Preserve unchanged nodes, disclosures and selections while a message streams. */
export function reconcileChildren(target: HTMLElement, source: HTMLElement, streaming = false): void {
  const current = children(target); const next = children(source);
  // Markdown can turn a literal marker into emphasis, links or a table. A
  // structural rewrite is readable immediately, never a replay of old words.
  const animate = streaming && !['PRE', 'CODE', 'BUTTON'].includes(target.tagName) &&
    current.every((old, index) => { const incoming = next[index]; return !!incoming && compatible(old, incoming); });
  for (let index = 0; index < next.length; index++) {
    const incoming = next[index]; const old = current[index];
    if (!incoming) continue;
    if (!old) {
      if (incoming.kind === 'text') {
        target.append(animate ? wordFragment(incoming.text) : document.createTextNode(incoming.text));
      } else {
        if (animate) revealNew(incoming.node);
        target.append(incoming.node);
      }
      continue;
    }
    if (old.kind === 'text' && incoming.kind === 'text') {
      if (incoming.text.startsWith(old.text)) appendText(old, incoming.text, animate);
      else {
        const first = old.nodes[0];
        if (first instanceof Text) first.data = incoming.text;
        else first?.replaceWith(document.createTextNode(incoming.text));
        for (const node of old.nodes.slice(1)) node.remove();
      }
    } else if (old.kind === 'node' && incoming.kind === 'node' && old.node.isEqualNode(incoming.node)) continue;
    else if (old.kind === 'node' && incoming.kind === 'node' &&
      old.node instanceof HTMLElement && incoming.node instanceof HTMLElement && compatible(old, incoming) && old.node.tagName !== 'BUTTON') {
      for (const attribute of Array.from(old.node.attributes)) if (!incoming.node.hasAttribute(attribute.name)) old.node.removeAttribute(attribute.name);
      for (const attribute of Array.from(incoming.node.attributes)) if (old.node.getAttribute(attribute.name) !== attribute.value) old.node.setAttribute(attribute.name, attribute.value);
      reconcileChildren(old.node, incoming.node, animate);
    } else {
      const first = old.kind === 'text' ? old.nodes[0] : old.node;
      const replacements = incoming.kind === 'text' ? incoming.nodes : [incoming.node];
      first?.replaceWith(...replacements);
      if (old.kind === 'text') for (const node of old.nodes.slice(1)) node.remove();
    }
  }
  for (const old of current.slice(next.length)) {
    if (old.kind === 'text') for (const node of old.nodes) node.remove();
    else old.node.remove();
  }
}

export function renderMarkdown(target: HTMLElement, text: string, streaming = false): void {
  const parsed = marked.parse(text, { async: false, gfm: true, breaks: false });
  const safe = DOMPurify.sanitize(parsed, {
    ALLOWED_TAGS: ['p', 'br', 'hr', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'title', 'class', 'start'],
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|file):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    RETURN_DOM_FRAGMENT: true,
  });
  const holder = element('div'); holder.append(safe);
  for (const link of holder.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? '';
    try {
      const url = new URL(href, 'file:///');
      if (!href || href.startsWith('//') || !['https:', 'http:', 'file:'].includes(url.protocol)) link.removeAttribute('href');
    } catch { link.removeAttribute('href'); }
    link.setAttribute('rel', 'noreferrer');
  }
  const selection = captureTextSelection(target);
  if (!streaming) {
    for (const word of target.querySelectorAll('span.stream-word')) word.replaceWith(...word.childNodes);
    target.normalize();
  }
  // Only new source suffixes animate; structural rewrites use the reconciler.
  const appendOnly = text.startsWith(renderedSources.get(target) ?? '');
  renderedSources.set(target, text);
  reconcileChildren(target, holder, streaming && appendOnly);
  restoreTextSelection(target, selection);
  // Event delegation survives reconciled nodes and never navigates the renderer.
  if (target.dataset.markdownBound !== 'true') {
    target.dataset.markdownBound = 'true';
    const activate = (event: MouseEvent): void => {
      if (event.type === 'auxclick' && event.button !== 1) return;
      if (!(event.target instanceof Element)) return;
      const link = event.target.closest('a');
      if (!(link instanceof HTMLAnchorElement) || !target.contains(link)) return;
      event.preventDefault(); event.stopPropagation();
      const url = link.getAttribute('href'); if (!url) return;
      if (url.startsWith('#')) {
        let slug: string;
        try { slug = decodeURIComponent(url.slice(1)); } catch { link.title = 'Invalid section link'; return; }
        const heading = Array.from(target.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).find(node =>
          node.id === slug || (node.textContent ?? '').trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s+/g, '-') === slug);
        heading?.scrollIntoView({ block: 'start' });
        return;
      }
      const id = target.closest<HTMLElement>('.conversation[data-thread-id]')?.dataset.threadId;
      const operation = /^https?:/i.test(url) ? request({ kind: 'open-url', url }) :
        id ? request({ kind: 'open-local-link', id, url }) : Promise.reject(new Error('Open a conversation before opening project files.'));
      void operation.catch(error => { link.title = error instanceof Error ? error.message : 'Could not open link'; });
    };
    target.addEventListener('click', activate);
    target.addEventListener('auxclick', activate);
  }
}
