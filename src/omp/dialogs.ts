import type { DialogRequest, JsonRecord } from '../shared/types';
import { isRecord, RpcError } from './frames';

export function parseDialog(frame: JsonRecord): DialogRequest | null {
  if (typeof frame.id !== 'string' || !frame.id || frame.id.length > 256) return null;
  if (frame.timeout !== undefined && (typeof frame.timeout !== 'number' || !Number.isFinite(frame.timeout) || frame.timeout < 0 || frame.timeout > 2147483647)) return null;
  const method = frame.method;
  switch (method) {
    case 'confirm': if (typeof frame.title !== 'string' || typeof frame.message !== 'string') return null; break;
    case 'input': if (typeof frame.title !== 'string' || (frame.placeholder !== undefined && typeof frame.placeholder !== 'string') || frame.secret === true) return null; break;
    case 'editor': if (typeof frame.title !== 'string' || (frame.prefill !== undefined && typeof frame.prefill !== 'string')) return null; break;
    case 'select': {
      if (typeof frame.title !== 'string' || !Array.isArray(frame.options) || !frame.options.length || !frame.options.every(option => typeof option === 'string') || new Set(frame.options).size !== frame.options.length) return null;
      if (frame.optionDetails !== undefined && (!Array.isArray(frame.optionDetails) || frame.optionDetails.length !== frame.options.length || !frame.optionDetails.every(detail => isRecord(detail) && (detail.description === undefined || typeof detail.description === 'string')))) return null;
      break;
    }
    case 'ask': {
      if (!Array.isArray(frame.questions) || !frame.questions.length) return null;
      const ids = new Set<string>();
      for (const question of frame.questions) {
        if (!isRecord(question) || typeof question.id !== 'string' || !question.id || ids.has(question.id) || typeof question.question !== 'string' || !Array.isArray(question.options) || !question.options.every(option => isRecord(option) && typeof option.label === 'string')) return null;
        const labels = question.options.flatMap(option => isRecord(option) && typeof option.label === 'string' ? [option.label] : []);
        if (new Set(labels).size !== labels.length || (question.multi !== undefined && typeof question.multi !== 'boolean') || (question.recommended !== undefined && (typeof question.recommended !== 'number' || !Number.isSafeInteger(question.recommended) || question.recommended < 0 || question.recommended >= labels.length))) return null;
        ids.add(question.id);
      }
      break;
    }
    default: return null;
  }
  return { id: frame.id, method, title: typeof frame.title === 'string' ? frame.title : 'Agent questions', message: typeof frame.message === 'string' ? frame.message : typeof frame.placeholder === 'string' ? frame.placeholder : '', frame: structuredClone(frame), deadline: typeof frame.timeout === 'number' && method !== 'editor' ? Date.now() + frame.timeout : null, error: null };
}

export function dialogResponse(dialog: DialogRequest, fields: JsonRecord): JsonRecord {
  const response: JsonRecord = { type: 'extension_ui_response', id: dialog.id };
  if (fields.cancelled === true) return { ...response, cancelled: true };
  switch (dialog.method) {
    case 'confirm':
      if (typeof fields.confirmed !== 'boolean') throw new RpcError('invalid', 'Choose Confirm or Cancel.');
      response.confirmed = fields.confirmed; break;
    case 'select':
      if (typeof fields.value !== 'string' || !Array.isArray(dialog.frame.options) || !dialog.frame.options.includes(fields.value)) throw new RpcError('invalid', 'Choose one of the offered options.');
      response.value = fields.value; break;
    case 'input': case 'editor':
      if (typeof fields.value !== 'string') throw new RpcError('invalid', 'Enter a text response or cancel.');
      response.value = fields.value; break;
    case 'ask': {
      if (!Array.isArray(fields.answers) || !Array.isArray(dialog.frame.questions) || fields.answers.length !== dialog.frame.questions.length) throw new RpcError('invalid', 'Answer every question or cancel.');
      const questions = dialog.frame.questions;
      response.answers = fields.answers.map((answer, index) => {
        const question = questions[index];
        if (!isRecord(answer) || !isRecord(question) || answer.id !== question.id || typeof question.id !== 'string' || !Array.isArray(answer.selectedOptions) || !answer.selectedOptions.every(option => typeof option === 'string') || !Array.isArray(question.options)) throw new RpcError('invalid', 'Question responses do not match their request IDs.');
        const offered = new Set(question.options.flatMap(option => isRecord(option) && typeof option.label === 'string' ? [option.label] : []));
        if (new Set(answer.selectedOptions).size !== answer.selectedOptions.length || !answer.selectedOptions.every(option => typeof option === 'string' && offered.has(option)) || (answer.customInput !== undefined && typeof answer.customInput !== 'string')) throw new RpcError('invalid', 'Choose only offered options, without duplicates.');
        const custom = typeof answer.customInput === 'string' ? answer.customInput.trim() : '';
        if (question.multi !== true && (answer.selectedOptions.length > 1 || (answer.selectedOptions.length > 0 && custom))) throw new RpcError('invalid', 'A single-choice question accepts one option or free text, not both.');
        const item: JsonRecord = { id: question.id, selectedOptions: answer.selectedOptions };
        if (custom) item.customInput = custom;
        return item;
      });
      break;
    }
  }
  return response;
}
