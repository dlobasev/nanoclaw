/**
 * Bot API 10.1 rich-message routing for the Telegram adapter.
 *
 * The Chat SDK adapter (4.30.0) predates Bot API 10.1 and exposes only
 * sendMessage / sendPhoto / sendDocument. We intercept its `postMessage` and
 * route these cases:
 *
 *   1. Image + caption > 1024 chars → sendPhoto with as much caption as fits
 *      (cut on a paragraph/sentence boundary) + plain continuation bubble(s)
 *      for the remainder. Never rich: a photo post must read as photo + text,
 *      and Bot API 10.1 has no single-bubble image+long-text anyway.
 *      Reactions/replies anchor to the photo id.
 *
 *   2. Image + short caption → existing sendPhoto path (unchanged behavior).
 *
 *   3. No files + text > sendMessage limit → sendRichMessage, but ONLY into a
 *      private DM (positive Telegram chat id). Channels/groups (negative id)
 *      get plain chunked bubbles — a public post must never render in the rich
 *      font. In this install that keeps rich to the owner/assistant DM; channel
 *      writers publish to negative-id channels and so never go rich. 32 KiB cap.
 *
 *   4. Otherwise → original SDK postMessage (legacy sendMessage / sendDocument).
 *
 * Any sendRichMessage failure (older Bot API server, transient error) falls
 * back to chunked legacy sendMessage via splitForLimit. sendPhoto failures
 * fall through to the existing sendDocument path that the adapter handles.
 *
 * Drop this module when @chat-adapter/telegram ships native rich support
 * (vercel/chat PR #616 / >= 4.31.x).
 */
import { splitForLimit } from './chat-sdk-bridge.js';
import { log } from '../log.js';

export const TELEGRAM_PLAIN_LIMIT = 4000;
export const TELEGRAM_CAPTION_LIMIT = 1024;
export const TELEGRAM_RICH_LIMIT = 32_000;

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;

export interface OutboundFile {
  data: Buffer;
  filename: string;
}

export interface PostResult {
  id: string;
  threadId: string;
}

export interface PostMessageContent {
  markdown?: string;
  files?: OutboundFile[];
  card?: unknown;
  fallbackText?: string;
}

export type PostMessageFn = (threadId: string, content: PostMessageContent) => Promise<PostResult | undefined>;

export interface TelegramSenders {
  sendPhoto(threadId: string, file: OutboundFile, caption: string): Promise<PostResult>;
  sendRichMessage(threadId: string, markdown: string): Promise<PostResult>;
}

interface TelegramApiResponse {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
}

/**
 * Decode the chat id (and optional message-thread id) from the thread id the
 * bridge hands to postMessage. That value is the platform-encoded form
 * `telegram:<chatId>` (or `telegram:<chatId>:<messageThreadId>` once threads are
 * enabled), e.g. `telegram:6037840640` or `telegram:-1001234567890`. The SDK's
 * own postMessage decodes this internally, but our custom senders call the Bot
 * API directly, so they must strip the `telegram:` channel prefix themselves —
 * otherwise `chat_id` becomes the literal string "telegram" and Telegram replies
 * "chat not found". (Bare `<chatId>` without the prefix is handled too, for
 * forward-compat.)
 */
export function parseTelegramTarget(threadId: string): { chatId: string; messageThreadId?: string } {
  const parts = threadId.split(':');
  if (parts[0] === 'telegram') parts.shift();
  const [chatId, messageThreadId] = parts;
  return { chatId, messageThreadId };
}

export async function sendTelegramRichMessage(token: string, threadId: string, markdown: string): Promise<PostResult> {
  const { chatId, messageThreadId } = parseTelegramTarget(threadId);
  const body: Record<string, unknown> = {
    chat_id: chatId,
    rich_message: { markdown },
  };
  if (messageThreadId) body.message_thread_id = Number(messageThreadId);
  const res = await fetch(`https://api.telegram.org/bot${token}/sendRichMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as TelegramApiResponse;
  if (!json.ok) {
    throw new Error(`Telegram sendRichMessage failed: ${json.description ?? 'unknown'}`);
  }
  // Return the composite "<chatId>:<message_id>" id, not the bare numeric one.
  // The SDK's own postMessage uses this form, outbound_message_index stores it,
  // and extractReplyContext (telegram.ts) rebuilds inbound replies into the same
  // shape. A bare id here makes owning-agent reply/reaction lookup miss for every
  // rich-delivered message, so the reply falls back to engage_pattern routing and
  // lands on the wrong agent.
  return { id: `${chatId}:${json.result!.message_id}`, threadId };
}

export function isImageFile(file: OutboundFile): boolean {
  return IMAGE_EXT_RE.test(file.filename);
}

function truncateRich(text: string): string {
  return text.length <= TELEGRAM_RICH_LIMIT ? text : text.slice(0, TELEGRAM_RICH_LIMIT);
}

/**
 * Split text for a single photo caption: take the largest prefix that fits in
 * `limit`, cutting on a paragraph break, then a sentence end, then a line
 * break, then a space, so the caption reads as a clean unit. The remainder
 * (trimmed) continues in a follow-up bubble. Replaces the old photo+rich path
 * so image posts never render in the rich font.
 */
export function splitCaption(text: string, limit: number): { caption: string; rest: string } {
  if (text.length <= limit) return { caption: text, rest: '' };
  const window = text.slice(0, limit);
  const sentenceEnd = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('.\n'),
    window.lastIndexOf('! '),
    window.lastIndexOf('!\n'),
    window.lastIndexOf('? '),
    window.lastIndexOf('?\n'),
  );
  // Prefer the strongest boundary that exists, taking the last occurrence that
  // fits so the caption fills as much as possible: paragraph break, then
  // sentence end, then line break, then a space; hard-cut only if none exist.
  const paragraph = window.lastIndexOf('\n\n');
  const line = window.lastIndexOf('\n');
  const space = window.lastIndexOf(' ');
  let cut = -1;
  if (paragraph > 0) cut = paragraph;
  else if (sentenceEnd >= 0) cut = sentenceEnd + 1;
  else if (line > 0) cut = line;
  else if (space > 0) cut = space;
  if (cut <= 0) cut = limit;
  return { caption: text.slice(0, cut).trimEnd(), rest: text.slice(cut).trimStart() };
}

export function wrapPostMessageWithRich(
  senders: TelegramSenders,
  originalPostMessage: PostMessageFn,
  sanitize: (text: string) => string,
): PostMessageFn {
  return async (threadId, content) => {
    if (content.card) return originalPostMessage(threadId, content);

    const markdown = content.markdown ?? '';
    const files = content.files;
    const oneImage = Array.isArray(files) && files.length === 1 && isImageFile(files[0]);
    // Rich renders only into a private DM (positive Telegram chat id). Channels
    // and groups (negative id) always get plain text — a public post must never
    // render in the rich font. In this install that keeps rich to the owner's
    // DM (where the assistant sends long formatted documents); channel writers
    // publish to negative-id channels and so never go rich.
    const { chatId } = parseTelegramTarget(threadId);
    const richOk = !chatId.startsWith('-');

    // Image + caption over the 1024 photo-caption limit. Never rich (even in a
    // DM): Bot API 10.1 has no single-bubble image+long-text. Send the photo
    // with as much caption as fits, cut on a paragraph/sentence boundary, and
    // continue the remainder in plain bubbles.
    if (oneImage && markdown.length > TELEGRAM_CAPTION_LIMIT) {
      const { caption, rest } = splitCaption(sanitize(markdown), TELEGRAM_CAPTION_LIMIT);
      let head: PostResult;
      try {
        head = await senders.sendPhoto(threadId, files![0], caption);
      } catch (photoErr) {
        log.warn('Telegram sendPhoto failed in photo+caption path, falling back to original', {
          err: String(photoErr),
        });
        return originalPostMessage(threadId, { markdown: sanitize(markdown), files });
      }
      if (rest) await deliverChunked(originalPostMessage, threadId, rest);
      return head;
    }

    if (oneImage) {
      try {
        return await senders.sendPhoto(threadId, files![0], sanitize(markdown));
      } catch (photoErr) {
        log.warn('Telegram sendPhoto failed, falling back to sendDocument', {
          err: String(photoErr),
        });
        return originalPostMessage(threadId, { markdown: sanitize(markdown), files });
      }
    }

    // Text-only over the plain single-message limit. Rich only into a DM;
    // channels/groups get plain chunked bubbles.
    if ((!files || files.length === 0) && markdown.length > TELEGRAM_PLAIN_LIMIT) {
      if (richOk) {
        try {
          return await senders.sendRichMessage(threadId, truncateRich(markdown));
        } catch (err) {
          log.warn('Telegram sendRichMessage failed, falling back to chunked sendMessage', {
            err: String(err),
          });
          return deliverChunked(originalPostMessage, threadId, sanitize(markdown));
        }
      }
      return deliverChunked(originalPostMessage, threadId, sanitize(markdown));
    }

    if (markdown) {
      return originalPostMessage(threadId, { markdown: sanitize(markdown), files });
    }
    return originalPostMessage(threadId, content);
  };
}

async function deliverChunked(
  originalPostMessage: PostMessageFn,
  threadId: string,
  text: string,
): Promise<PostResult | undefined> {
  const chunks = splitForLimit(text, TELEGRAM_PLAIN_LIMIT);
  let head: PostResult | undefined;
  for (const chunk of chunks) {
    const r = await originalPostMessage(threadId, { markdown: chunk });
    if (!head && r) head = r;
  }
  return head;
}
