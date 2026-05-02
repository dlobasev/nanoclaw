import { deleteSession } from './db.js';
import { logger } from './logger.js';

const OVERFLOW_PATTERN =
  /Extra usage is required for 1M context|context_length_exceeded|prompt is too long|input length and .{0,40}max_tokens.{0,40}exceed|tokens exceed.{0,60}context window|enable extra usage/i;

export function isContextOverflowError(
  text: string | null | undefined,
): boolean {
  if (!text) return false;
  return OVERFLOW_PATTERN.test(text);
}

interface BlockedState {
  reason: string;
  since: number;
}

const blocked = new Map<string, BlockedState>();

export function markGroupBlocked(folder: string, reason: string): void {
  if (!blocked.has(folder)) {
    blocked.set(folder, { reason, since: Date.now() });
  }
}

export function isGroupBlocked(folder: string): boolean {
  return blocked.has(folder);
}

export function clearGroupBlocked(folder: string): void {
  blocked.delete(folder);
}

const RESET_PATTERN = /(^|\s)\/reset(\s|$)/i;

export function isResetCommand(text: string): boolean {
  return RESET_PATTERN.test(text);
}

export function resetGroupSession(folder: string): void {
  deleteSession(folder);
  logger.info({ folder }, 'Group session reset (context-overflow recovery)');
}

export const CONTEXT_OVERFLOW_USER_MESSAGE =
  'Контекст переполнен — большая история или вложение не помещается в окно модели. Я приостановила работу, чтобы не зацикливаться.\n\nОтветь /reset, чтобы начать новую сессию. Память группы (CLAUDE.md) сохранится.';

export const RESET_DONE_MESSAGE =
  'Сессия сброшена. Память группы сохранена. Можно писать дальше.';

export const RESET_REMINDER_MESSAGE =
  'Контекст всё ещё переполнен. Ответь /reset чтобы начать новую сессию.';
