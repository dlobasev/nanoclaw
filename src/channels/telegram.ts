/**
 * Telegram channel adapter (v2) — uses Chat SDK bridge, with a pairing
 * interceptor wrapped around onInbound to verify chat ownership before
 * registration. See telegram-pairing.ts for the why.
 */
import { createTelegramAdapter } from '@chat-adapter/telegram';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { createMessagingGroup, getMessagingGroupByPlatform, updateMessagingGroup } from '../db/messaging-groups.js';
import { grantRole, hasAnyOwner } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';
import { registerChannelAdapter } from './channel-registry.js';
import {
  TELEGRAM_RICH_LIMIT,
  sendTelegramRichMessage,
  wrapPostMessageWithRich,
  type PostMessageFn,
  type TelegramSenders,
} from './telegram-rich.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';
import { tryConsume } from './telegram-pairing.js';

/**
 * Retry a one-shot operation that can fail on transient network errors at
 * cold-start (DNS hiccups, brief upstream outages). Exponential backoff capped
 * at 5 attempts — if the network is truly down we surface it instead of
 * hanging the service indefinitely.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = Math.min(16000, 1000 * 2 ** (attempt - 1));
      log.warn('Telegram setup failed, retrying', { label, attempt, delayMs: delay, err });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.reply_to_message) return null;
  const reply = raw.reply_to_message;
  // The chat-sdk normalizes Telegram message ids to "<chatId>:<message_id>"
  // for delivery + outbound_message_index. The raw Telegram update gives us
  // only the bare numeric `reply.message_id`, so we have to rebuild the
  // prefixed form here from the parent message's `raw.chat.id` (the chat is
  // the same for the reply and the message being replied to — Telegram has
  // no cross-chat replies). Without the prefix, owning-agent lookup in
  // router.ts misses every reply and falls back to pattern routing.
  const chatId = raw.chat?.id;
  const rawMsgId = reply.message_id;
  const messageId = rawMsgId != null ? (chatId != null ? `${chatId}:${rawMsgId}` : String(rawMsgId)) : undefined;
  return {
    text: reply.text || reply.caption || '',
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
    messageId,
  };
}

/** Look up the bot username via Telegram getMe. Cached after first call. */
async function fetchBotUsername(token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = (await res.json()) as { ok: boolean; result?: { username?: string } };
    return json.ok ? (json.result?.username ?? null) : null;
  } catch (err) {
    log.warn('Telegram getMe failed', { err });
    return null;
  }
}

function isGroupPlatformId(platformId: string): boolean {
  // platformId is "telegram:<chatId>". Negative chat IDs are groups/channels.
  const id = platformId.split(':').pop() ?? '';
  return id.startsWith('-');
}

interface InboundFields {
  text: string;
  authorUserId: string | null;
}

function readInboundFields(message: InboundMessage): InboundFields {
  if (message.kind !== 'chat-sdk' || !message.content || typeof message.content !== 'object') {
    return { text: '', authorUserId: null };
  }
  const c = message.content as { text?: string; author?: { userId?: string } };
  return { text: c.text ?? '', authorUserId: c.author?.userId ?? null };
}

/**
 * Build an onInbound interceptor that consumes pairing codes before they
 * reach the router. On match: records the chat + its paired user, promotes
 * the user to owner if the instance has no owner yet, and short-circuits.
 * On miss: forwards to the host.
 */
/**
 * Send a one-shot confirmation back to the paired chat. Best-effort — failures
 * are logged but never propagated, so a Telegram outage can't undo a successful
 * pairing or trigger the interceptor's fail-open path.
 */
async function sendPairingConfirmation(token: string, platformId: string): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: 'Pairing success! Head back to the NanoClaw installer to finish setup.',
      }),
    });
    if (!res.ok) {
      log.warn('Telegram pairing confirmation non-OK', { status: res.status });
    }
  } catch (err) {
    log.warn('Telegram pairing confirmation failed', { err });
  }
}

function createPairingInterceptor(
  botUsernamePromise: Promise<string | null>,
  hostOnInbound: ChannelSetup['onInbound'],
  token: string,
): ChannelSetup['onInbound'] {
  return async (platformId, threadId, message) => {
    try {
      const botUsername = await botUsernamePromise;
      if (!botUsername) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const { text, authorUserId } = readInboundFields(message);
      if (!text) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const consumed = await tryConsume({
        text,
        botUsername,
        platformId,
        isGroup: isGroupPlatformId(platformId),
        adminUserId: authorUserId,
      });
      if (!consumed) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      // Pairing matched — record the chat and short-circuit so the
      // code-bearing message never reaches an agent. Privilege is now a
      // property of the paired user, not the chat: upsert the user, and if
      // this instance has no owner yet, promote them to owner.
      const existing = getMessagingGroupByPlatform('telegram', platformId);
      if (existing) {
        updateMessagingGroup(existing.id, {
          is_group: consumed.consumed!.isGroup ? 1 : 0,
        });
      } else {
        createMessagingGroup({
          id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          channel_type: 'telegram',
          platform_id: platformId,
          name: consumed.consumed!.name,
          is_group: consumed.consumed!.isGroup ? 1 : 0,
          unknown_sender_policy: 'strict',
          created_at: new Date().toISOString(),
        });
      }

      const pairedUserId = `telegram:${consumed.consumed!.adminUserId}`;
      upsertUser({
        id: pairedUserId,
        kind: 'telegram',
        display_name: null,
        created_at: new Date().toISOString(),
      });

      let promotedToOwner = false;
      if (!hasAnyOwner()) {
        grantRole({
          user_id: pairedUserId,
          role: 'owner',
          agent_group_id: null,
          granted_by: null,
          granted_at: new Date().toISOString(),
        });
        promotedToOwner = true;
      }

      log.info('Telegram pairing accepted — chat registered', {
        platformId,
        pairedUser: pairedUserId,
        promotedToOwner,
        intent: consumed.intent,
      });

      await sendPairingConfirmation(token, platformId);
    } catch (err) {
      log.error('Telegram pairing interceptor error', { err });
      // Fail open: pass through so a pairing bug doesn't break normal traffic.
      hostOnInbound(platformId, threadId, message);
    }
  };
}

// Vercel Chat SDK's @chat-adapter/telegram@4.30.0 outbound predates Bot API
// 10.1 — no sendPhoto, no sendRichMessage. We monkey-patch the adapter's
// postMessage with two layers:
//   1. Single-image attachments go through sendPhoto for inline previews
//      instead of sendDocument's file-attachment rendering.
//   2. Long markdown (text-only > 4000 chars, or image+text > 1024 chars)
//      goes through sendRichMessage for up to 32 KiB with native rich
//      markdown parsing. See telegram-rich.ts.
// Both layers fall back to the original SDK path on failure so we never
// silently lose a message.
async function sendTelegramPhoto(
  token: string,
  threadId: string,
  file: { data: Buffer; filename: string },
  caption: string,
): Promise<{ id: string; threadId: string }> {
  // threadId format from adapter is "<chatId>" or "<chatId>:<messageThreadId>"
  // (supportsThreads:false in our config means the second case never appears for
  // current channels, but we handle it defensively for future-compat).
  const [chatId, messageThreadId] = threadId.split(':');
  const formData = new FormData();
  formData.append('chat_id', chatId);
  if (messageThreadId) formData.append('message_thread_id', messageThreadId);
  formData.append('photo', new Blob([new Uint8Array(file.data)]), file.filename);
  if (caption) {
    formData.append('caption', caption);
    formData.append('parse_mode', 'Markdown');
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'POST',
    body: formData,
  });
  const json = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
  if (!json.ok) throw new Error(`Telegram sendPhoto failed: ${json.description ?? 'unknown'}`);
  return { id: String(json.result!.message_id), threadId };
}

registerChannelAdapter('telegram', {
  factory: () => {
    const env = readEnvFile(['TELEGRAM_BOT_TOKEN']);
    if (!env.TELEGRAM_BOT_TOKEN) return null;
    const token = env.TELEGRAM_BOT_TOKEN;
    const telegramAdapter = createTelegramAdapter({
      botToken: token,
      mode: 'polling',
      // Default getUpdates excludes message_reaction. Opt in so the bridge
      // can deliver user reactions as inbound events.
      longPolling: {
        allowedUpdates: ['message', 'edited_message', 'callback_query', 'message_reaction'],
      },
    });
    // Compose the postMessage patch: rich-message routing wraps the
    // sendPhoto-and-original-fallback pair. The bridge's transformOutboundText
    // is intentionally NOT set here — rich markdown is a different dialect
    // than legacy V1, so sanitization happens inside the wrapper only on the
    // plain-message branches (see telegram-rich.ts).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapterAny = telegramAdapter as any;
    const originalPostMessage: PostMessageFn = adapterAny.postMessage.bind(telegramAdapter);
    const senders: TelegramSenders = {
      sendPhoto: (threadId, file, caption) => sendTelegramPhoto(token, threadId, file, caption),
      sendRichMessage: (threadId, markdown) => sendTelegramRichMessage(token, threadId, markdown),
    };
    adapterAny.postMessage = wrapPostMessageWithRich(senders, originalPostMessage, sanitizeTelegramLegacyMarkdown);

    const bridge = createChatSdkBridge({
      adapter: telegramAdapter,
      concurrency: 'concurrent',
      extractReplyContext,
      supportsThreads: false,
      // maxTextLength matches the rich-message ceiling so single replies up to
      // 32 KiB reach the wrapper as one chunk; the wrapper picks plain vs rich
      // per call. Larger payloads still chunk at the bridge layer and each
      // chunk gets the same per-call routing decision.
      maxTextLength: TELEGRAM_RICH_LIMIT,
    });

    const botUsernamePromise = fetchBotUsername(token);

    const wrapped: ChannelAdapter = {
      ...bridge,
      resolveChannelName: async (platformId: string) => {
        const chatId = platformId.split(':').slice(1).join(':');
        if (!chatId) return null;
        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId }),
          });
          const data = (await res.json()) as { ok?: boolean; result?: { title?: string } };
          return data.ok ? (data.result?.title ?? null) : null;
        } catch {
          return null;
        }
      },
      async setup(hostConfig: ChannelSetup) {
        const intercepted: ChannelSetup = {
          ...hostConfig,
          onInbound: createPairingInterceptor(botUsernamePromise, hostConfig.onInbound, token),
        };
        return withRetry(() => bridge.setup(intercepted), 'bridge.setup');
      },
    };
    return wrapped;
  },
});
