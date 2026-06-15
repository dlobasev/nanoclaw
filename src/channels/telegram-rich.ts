/**
 * Bot API 10.1 rich-message routing for the Telegram adapter.
 *
 * The Chat SDK adapter (4.30.0) predates Bot API 10.1 and exposes only
 * sendMessage / sendPhoto / sendDocument. We intercept its `postMessage` and
 * route four cases:
 *
 *   1. Image + caption > 1024 chars → sendPhoto (empty caption) + sendRichMessage.
 *      sendRichMessage has no multipart upload path in 10.1, so single-bubble
 *      image+long-text is not achievable; photo first, body second is the
 *      closest equivalent. Reactions/replies anchor to the photo id.
 *
 *   2. Image + short caption → existing sendPhoto path (unchanged behavior).
 *
 *   3. No files + text > sendMessage limit → sendRichMessage. 32 KiB cap.
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
  return { id: String(json.result!.message_id), threadId };
}

export function isImageFile(file: OutboundFile): boolean {
  return IMAGE_EXT_RE.test(file.filename);
}

function truncateRich(text: string): string {
  return text.length <= TELEGRAM_RICH_LIMIT ? text : text.slice(0, TELEGRAM_RICH_LIMIT);
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

    if (oneImage && markdown.length > TELEGRAM_CAPTION_LIMIT) {
      let head: PostResult;
      try {
        head = await senders.sendPhoto(threadId, files![0], '');
      } catch (photoErr) {
        log.warn('Telegram sendPhoto failed in rich+photo path, falling back to original', {
          err: String(photoErr),
        });
        return originalPostMessage(threadId, { markdown: sanitize(markdown), files });
      }
      try {
        await senders.sendRichMessage(threadId, truncateRich(markdown));
      } catch (richErr) {
        log.warn('Telegram sendRichMessage failed after photo, falling back to chunked text', {
          err: String(richErr),
        });
        await deliverChunked(originalPostMessage, threadId, sanitize(markdown));
      }
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

    if ((!files || files.length === 0) && markdown.length > TELEGRAM_PLAIN_LIMIT) {
      try {
        return await senders.sendRichMessage(threadId, truncateRich(markdown));
      } catch (err) {
        log.warn('Telegram sendRichMessage failed, falling back to chunked sendMessage', {
          err: String(err),
        });
        return deliverChunked(originalPostMessage, threadId, sanitize(markdown));
      }
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
