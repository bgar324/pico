import type { ChatMessage, JsonRecord } from '../shared/types';
import { element } from './dom';
import { disclosureCaret, icon } from './icons';
import { renderMarkdown } from './markdown';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fieldLabel(key: string): string {
  const label = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
  return label.charAt(0).toLocaleUpperCase() + label.slice(1);
}

function renderValue(value: unknown, paths = false): HTMLElement {
  if (Array.isArray(value)) {
    if (!value.length) return element('span', 'result-empty', '[]');
    const list = element('ul', 'result-list');
    for (const item of value) { const row = element('li'); row.append(renderValue(item, paths)); list.append(row); }
    return list;
  }
  if (record(value)) {
    const fields = element('dl', 'result-fields');
    const entries = Object.entries(value);
    if (!entries.length) return element('span', 'result-empty', '{}');
    for (const [key, item] of entries) {
      const label = element('dt', /^(error|errors)$/i.test(key) ? 'error-text' : '', fieldLabel(key));
      label.title = key;
      const body = element('dd'); body.append(renderValue(item, paths || /(?:paths?|files?)$/i.test(key)));
      fields.append(label, body);
    }
    return fields;
  }
  if (typeof value === 'string') {
    if (paths) return element('code', 'result-path', value || '""');
    if (!value) return element('span', 'result-empty', '""');
    const text = element('div', 'markdown'); renderMarkdown(text, value); return text;
  }
  return element('span', 'result-value', String(value));
}

// Only format standalone JSON blocks in a known completion notice. Ordinary
// assistant Markdown, including examples and inline braces, stays untouched.
function appendResult(target: HTMLElement, text: string): void {
  let cursor = 0;
  const starts = /^(?:[ \t]*```(?:json)?[ \t]*\n)?[ \t]*[\[{]/gm;
  for (let match = starts.exec(text); match; match = starts.exec(text)) {
    const start = match.index + match[0].length - 1;
    let depth = 0; let quoted = false; let escaped = false; let end = start;
    for (; end < text.length; end++) {
      const char = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') { if (--depth === 0) { end++; break; } }
    }
    if (depth !== 0 || quoted) continue;
    let value: unknown;
    try { value = JSON.parse(text.slice(start, end)); } catch { continue; }
    if (!record(value) && !Array.isArray(value)) continue;
    let blockEnd = end;
    if (match[0].includes('```')) {
      const closing = /^[ \t]*\n[ \t]*```[ \t]*(?:\n|$)/.exec(text.slice(end));
      if (!closing) continue;
      blockEnd += closing[0].length;
    } else if (!/^[ \t]*(?:\n|$)/.test(text.slice(end))) continue;
    appendProse(target, text.slice(cursor, match.index));
    target.append(renderValue(value));
    cursor = blockEnd; starts.lastIndex = blockEnd;
  }
  appendProse(target, text.slice(cursor));
}

function appendProse(target: HTMLElement, text: string): void {
  if (!text.trim()) return;
  const prose = element('div', 'markdown result-prose'); renderMarkdown(prose, text); target.append(prose);
}

function source(target: HTMLElement, message: ChatMessage, open: boolean): void {
  const raw = element('details', 'result-source'); raw.open = open;
  const summary = element('summary');
  summary.append(icon('code')); summary.title = 'Source message'; summary.setAttribute('aria-label', 'Source message');
  raw.append(summary, element('pre', 'result-raw', message.text));
  if (message.details) raw.append(element('pre', 'result-metadata', JSON.stringify(message.details, null, 2)));
  target.append(raw);
}

function heading(title: string, state: string): HTMLElement {
  const header = element('div', 'result-heading');
  header.append(element('span', 'result-title', title));
  if (state) {
    const marker = element('span', 'result-state'); marker.setAttribute('role', 'img'); marker.setAttribute('aria-label', state); marker.title = state;
    marker.append(icon(state === 'Completed' ? 'circle-check' : state === 'Blocker' || state === 'Interrupted' ? 'circle-x' : state === 'Concern' || state === 'Review required' ? 'warning' : 'info'));
    header.append(marker);
  }
  return header;
}

function jobTitle(job: JsonRecord): string {
  const kind = job.type === 'eval' ? 'Eval job' : 'Background job';
  const id = typeof job.jobId === 'string' ? job.jobId : '';
  return `${kind}${id ? ` · ${id}` : ''}`;
}

interface NoticeEnvelope { attributes: string; body: string; before: string }

// Only called after checking the engine's custom role/type, never to infer
// system provenance from user or assistant prose that happens to contain XML.
function noticeEnvelopes(text: string, tag: string): { notices: NoticeEnvelope[]; after: string } {
  const notices: NoticeEnvelope[] = [];
  const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'g');
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    notices.push({ attributes: match[1] ?? '', body: match[2] ?? '', before: text.slice(cursor, start) });
    cursor = start + match[0].length;
  }
  return { notices, after: text.slice(cursor) };
}

function xmlText(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, entity => {
    switch (entity) {
      case '&amp;': return '&';
      case '&lt;': return '<';
      case '&gt;': return '>';
      case '&quot;': return '"';
      case '&apos;': return "'";
      default: {
        const point = Number.parseInt(entity.slice(entity[2]?.toLowerCase() === 'x' ? 3 : 2, -1), entity[2]?.toLowerCase() === 'x' ? 16 : 10);
        return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
      }
    }
  });
}

function attribute(attributes: string, key: string): string | undefined {
  const value = new RegExp(`(?:^|\\s)${key}="([^"]*)"`).exec(attributes)?.[1];
  return value === undefined ? undefined : xmlText(value);
}

function advisorNote(target: HTMLElement, note: string, severity: unknown, advisor: unknown): void {
  // OMP's advise schema defines omitted severity as nit, not concern.
  const level = severity === undefined ? 'nit' : severity;
  const known = level === 'nit' || level === 'concern' || level === 'blocker';
  const section = element('section', `transcript-notice advisor-notice notice-${known ? level : 'neutral'}`);
  section.append(heading(typeof advisor === 'string' && advisor ? `Advisor · ${advisor}` : 'Advisor',
    known ? fieldLabel(level) : typeof level === 'string' ? fieldLabel(level) : 'Note'));
  appendProse(section, note);
  target.append(section);
}

function appendConsole(target: HTMLElement, text: string): void {
  const output = element('pre', 'result-console');
  output.append(element('code', '', text));
  target.append(output);
}

function appendAdvisorNotes(content: HTMLElement, message: ChatMessage): void {
  const notes = message.details?.notes;
  const envelopes = noticeEnvelopes(message.text, 'advisory');
  if (Array.isArray(notes) && notes.length && notes.every(note => record(note) && typeof note.note === 'string')) {
    // Only notes and advisory bodies are display content; the model-facing
    // wrapper is not part of the Advisor interface.
    for (const entry of envelopes.notices) {
      const body = xmlText(entry.body);
      if (!notes.some(note => record(note) && typeof note.note === 'string' && note.note.trim() === body.trim())) {
        advisorNote(content, body, attribute(entry.attributes, 'severity'), attribute(entry.attributes, 'advisor'));
      }
    }
    for (const note of notes) {
      if (record(note) && typeof note.note === 'string') advisorNote(content, note.note, note.severity, note.advisor);
    }
  } else if (envelopes.notices.length) {
    for (const entry of envelopes.notices) {
      advisorNote(content, xmlText(entry.body), attribute(entry.attributes, 'severity'), attribute(entry.attributes, 'advisor'));
    }
  } else {
    advisorNote(content, message.text, null, undefined);
  }
}

function renderAdvisor(target: HTMLElement, messages: readonly ChatMessage[]): void {
  const content = element('div', 'advisor-notes');
  for (const message of messages) appendAdvisorNotes(content, message);
  const group = target.querySelector<HTMLDetailsElement>(':scope > .advisor-group') ?? element('details', 'advisor-group');
  const summary = group.querySelector<HTMLElement>(':scope > summary') ?? element('summary', 'advisor-summary');
  const count = content.childElementCount;
  const label = count === 1 ? 'Advisor' : `Advisor · ${count} notes`;
  let severity: 'neutral' | 'nit' | 'concern' | 'blocker' = 'neutral';
  for (const note of content.children) {
    if (note.classList.contains('notice-blocker')) { severity = 'blocker'; break; }
    if (note.classList.contains('notice-concern')) severity = 'concern';
    else if (severity === 'neutral' && note.classList.contains('notice-nit')) severity = 'nit';
  }
  if (summary.dataset.label !== label || summary.dataset.severity !== severity) {
    if (summary.dataset.severity !== severity) {
      const glyph = icon(severity === 'blocker' ? 'circle-x' : severity === 'concern' ? 'warning' : 'info');
      glyph.classList.add('advisor-severity');
      const previous = summary.querySelector(':scope > .advisor-severity');
      if (previous) previous.replaceWith(glyph); else summary.prepend(glyph);
      group.dataset.severity = severity; summary.dataset.severity = severity;
    }
    const text = summary.querySelector<HTMLElement>(':scope > .advisor-label') ?? element('span', 'advisor-label');
    if (text.textContent !== label) text.textContent = label;
    if (text.parentElement !== summary) summary.append(text);
    if (!summary.querySelector(':scope > .disclosure-caret')) summary.append(disclosureCaret());
    summary.dataset.label = label;
    const severityLabel = severity === 'neutral' ? 'Note' : fieldLabel(severity);
    summary.setAttribute('aria-label', `${label} · ${severityLabel}`);
    summary.title = severityLabel;
  }
  if (summary.parentElement !== group) group.prepend(summary);
  const previous = group.querySelector(':scope > .advisor-notes');
  if (previous) {
    const oldNotes = Array.from(previous.children), nextNotes = Array.from(content.children);
    for (const [index, note] of nextNotes.entries()) {
      const old = oldNotes[index];
      if (old?.classList.contains('find-match')) note.classList.add('find-match');
      if (old?.isEqualNode(note)) continue;
      if (old) old.replaceWith(note); else previous.append(note);
    }
    for (const old of oldNotes.slice(nextNotes.length)) old.remove();
  } else group.append(content);
  if (group.parentElement !== target) target.replaceChildren(group);
}

function renderRuleNotices(target: HTMLElement, message: ChatMessage, expanded: ReadonlySet<string>): void {
  // Rules can arrive as custom notices or trusted developer/system messages,
  // for both judged warnings and interrupted output.
  const pattern = /<(system-reminder|system-interrupt)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let cursor = 0;
  for (const match of message.text.matchAll(pattern)) {
    if (attribute(match[2] ?? '', 'reason') !== 'rule_violation') continue;
    appendProse(target, message.text.slice(cursor, match.index));
    const interrupted = match[1] === 'system-interrupt';
    const section = element('section', `transcript-notice rule-notice notice-${interrupted ? 'blocker' : 'concern'}`);
    section.append(heading('Project rule', interrupted ? 'Interrupted' : 'Review required'));
    const name = attribute(match[2] ?? '', 'rule');
    const path = attribute(match[2] ?? '', 'path');
    if (name) section.append(element('div', 'notice-rule-name', name));
    if (path) section.append(element('code', 'notice-rule-path', path));
    section.append(element('p', 'notice-explanation muted', interrupted ? 'OMP interrupted the agent because a project rule matched.' : 'A project rule matched. The agent must review its instructions.'));
    const instructions = element('details', 'notice-rule-details');
    const key = JSON.stringify([name, path, match.index]);
    instructions.dataset.ruleKey = key; instructions.open = expanded.has(key);
    const summary = element('summary');
    summary.append(element('span', '', 'View rule instructions'), disclosureCaret()); instructions.append(summary);
    appendProse(instructions, match[3] ?? '');
    section.append(instructions);
    target.append(section);
    cursor = (match.index ?? 0) + match[0].length;
  }
  appendProse(target, message.text.slice(cursor));
}

export function isRuleNotice(message: ChatMessage): boolean {
  if (message.role === 'custom') return message.customType === 'ttsr-injection';
  if (message.role !== 'developer' && message.role !== 'system') return false;
  return ['system-reminder', 'system-interrupt'].some(tag => noticeEnvelopes(message.text, tag).notices.some(entry => attribute(entry.attributes, 'reason') === 'rule_violation'));
}

/** Return false for ordinary messages so the normal streaming renderer owns them. */
export function renderBackgroundMessage(target: HTMLElement, message: ChatMessage, advisorMessages?: readonly ChatMessage[]): boolean {
  if (message.role === 'user' || message.isStreaming) return false;
  const execution = message.role === 'bashExecution' || message.role === 'pythonExecution';
  const advisor = message.role === 'custom' && message.customType === 'advisor';
  const rule = isRuleNotice(message);
  const asyncResult = message.role === 'custom' && message.customType === 'async-result';
  if (!execution && !advisor && !rule && !asyncResult) return false;
  if (advisor) { renderAdvisor(target, advisorMessages ?? [message]); return true; }
  const text = message.text.replace(/^<system-notice>\r?\n?/, '').replace(/\r?\n?<\/system-notice>\s*$/, '');
  const single = /^Background job ([^\s]+) has completed\. Resume your work using the result below\.(?:\r?\n)?/.exec(text);
  const multiple = /^\d+ background jobs have completed\. Resume your work using the results below\.(?:\r?\n)?/.exec(text);
  const open = target.querySelector<HTMLDetailsElement>('.result-source')?.open ?? false;
  const expandedRules = new Set(Array.from(target.querySelectorAll<HTMLDetailsElement>('.notice-rule-details[open]')).map(node => node.dataset.ruleKey ?? ''));
  target.replaceChildren();
  if (execution) {
    target.append(heading(message.role === 'bashExecution' ? 'Shell execution' : 'Python execution', ''));
    appendConsole(target, message.text);
  } else if (rule) {
    renderRuleNotices(target, message, expandedRules);
  } else {
    const jobs = message.details?.jobs;
    const metadata = Array.isArray(jobs) ? jobs.filter((job): job is JsonRecord => record(job)) : [];
    const result = text.slice(single?.[0].length ?? multiple?.[0].length ?? 0);
    const markers = multiple ? [...result.matchAll(/^── Job ([^\s]+)(?: \((.*?)\))? ──\r?$/gm)]
      .filter(marker => !metadata.length || metadata.some(job => job.jobId === marker[1])) : [];
    const sections = markers.length
      ? markers.map((marker, index) => ({ id: marker[1] ?? '', label: marker[2] ?? '', text: result.slice((marker.index ?? 0) + marker[0].length, markers[index + 1]?.index ?? result.length) }))
      : [{ id: single?.[1] ?? '', label: '', text: result }];
    if (markers.length) appendProse(target, result.slice(0, markers[0]?.index ?? 0));
    for (const entry of sections) {
      const job = metadata.find(job => job.jobId === entry.id) ?? (metadata.length === 1 ? metadata[0] : undefined);
      if (job?.type === 'task' || job?.type === 'bash') continue;
      const section = element('section', 'background-result');
      section.append(heading(job ? jobTitle(job) : entry.id ? `Background job · ${entry.id}` : 'Background result', single || multiple ? 'Completed' : ''));
      const label = typeof job?.label === 'string' ? job.label : entry.label;
      if (label) section.append(element('div', 'result-job-label', label));
      if (typeof job?.durationMs === 'number') section.append(element('span', 'result-duration', `${(job.durationMs / 1000).toFixed(1)}s`));
      if (record(job?.schema)) {
        const schema = element('div', 'result-schema'); schema.append(renderValue(job.schema)); section.append(schema);
      }
      appendResult(section, entry.text);
      target.append(section);
    }
  }
  if (!rule) source(target, message, open);
  return true;
}
