import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_PLAIN_LIMIT,
  TELEGRAM_RICH_LIMIT,
  sendTelegramRichMessage,
  wrapPostMessageWithRich,
  type OutboundFile,
  type PostMessageContent,
  type PostMessageFn,
  type PostResult,
  type TelegramSenders,
} from './telegram-rich.js';

function makeImage(name = 'hero.png'): OutboundFile {
  return { data: Buffer.from('png'), filename: name };
}

function makeSenders(): {
  senders: TelegramSenders;
  sendPhoto: ReturnType<typeof vi.fn>;
  sendRichMessage: ReturnType<typeof vi.fn>;
} {
  const sendPhoto = vi.fn(
    async (_t: string, _f: OutboundFile, _c: string) => ({ id: 'p1', threadId: 'tid' }) as PostResult,
  );
  const sendRichMessage = vi.fn(async (_t: string, _m: string) => ({ id: 'r1', threadId: 'tid' }) as PostResult);
  return { senders: { sendPhoto, sendRichMessage }, sendPhoto, sendRichMessage };
}

function makeOriginal(): { original: PostMessageFn; calls: PostMessageContent[] } {
  const calls: PostMessageContent[] = [];
  const original: PostMessageFn = async (_tid, content) => {
    calls.push(content);
    return { id: `o${calls.length}`, threadId: 'tid' };
  };
  return { original, calls };
}

const identity = (s: string) => s;
const visible = (s: string) => `<${s}>`;

describe('wrapPostMessageWithRich', () => {
  it('routes text-only short markdown through the original SDK path with sanitization', async () => {
    const { senders, sendPhoto, sendRichMessage } = makeSenders();
    const { original, calls } = makeOriginal();
    const post = wrapPostMessageWithRich(senders, original, visible);

    const r = await post('tid', { markdown: 'hi' });

    expect(sendPhoto).not.toHaveBeenCalled();
    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(calls).toEqual([{ markdown: '<hi>', files: undefined }]);
    expect(r).toEqual({ id: 'o1', threadId: 'tid' });
  });

  it('routes text-only markdown above the plain limit through sendRichMessage (no sanitize)', async () => {
    const { senders, sendRichMessage } = makeSenders();
    const { original, calls } = makeOriginal();
    const post = wrapPostMessageWithRich(senders, original, visible);

    const long = '**bold**\n'.repeat(800); // > 4000 chars, contains rich-markdown syntax
    expect(long.length).toBeGreaterThan(TELEGRAM_PLAIN_LIMIT);

    const r = await post('tid', { markdown: long });

    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendRichMessage.mock.calls[0][1]).toBe(long); // raw, not sanitized
    expect(calls).toEqual([]);
    expect(r).toEqual({ id: 'r1', threadId: 'tid' });
  });

  it('truncates text-only markdown at the rich ceiling', async () => {
    const { senders, sendRichMessage } = makeSenders();
    const { original } = makeOriginal();
    const post = wrapPostMessageWithRich(senders, original, identity);

    const huge = 'x'.repeat(TELEGRAM_RICH_LIMIT + 500);
    await post('tid', { markdown: huge });

    const sent = sendRichMessage.mock.calls[0][1] as string;
    expect(sent.length).toBe(TELEGRAM_RICH_LIMIT);
  });

  it('routes image + short caption through sendPhoto with sanitized caption', async () => {
    const { senders, sendPhoto, sendRichMessage } = makeSenders();
    const { original, calls } = makeOriginal();
    const post = wrapPostMessageWithRich(senders, original, visible);

    const img = makeImage();
    const r = await post('tid', { markdown: 'caption', files: [img] });

    expect(sendPhoto).toHaveBeenCalledWith('tid', img, '<caption>');
    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(r).toEqual({ id: 'p1', threadId: 'tid' });
  });

  it('routes image + caption-cap-exceeding markdown through sendPhoto(empty) + sendRichMessage', async () => {
    const { senders, sendPhoto, sendRichMessage } = makeSenders();
    const { original, calls } = makeOriginal();
    const post = wrapPostMessageWithRich(senders, original, visible);

    const long = 'a'.repeat(TELEGRAM_CAPTION_LIMIT + 100);
    const img = makeImage();

    const r = await post('tid', { markdown: long, files: [img] });

    expect(sendPhoto).toHaveBeenCalledWith('tid', img, '');
    expect(sendRichMessage).toHaveBeenCalledWith('tid', long);
    expect(calls).toEqual([]);
    expect(r).toEqual({ id: 'p1', threadId: 'tid' }); // photo id (head)
  });

  it('falls back to chunked sendMessage when sendRichMessage fails', async () => {
    const sendPhoto = vi.fn();
    const sendRichMessage = vi.fn(async () => {
      throw new Error('Bot API server too old');
    });
    const { original, calls } = makeOriginal();
    const post = wrapPostMessageWithRich({ sendPhoto, sendRichMessage }, original, identity);

    const long = 'paragraph\n\n'.repeat(500).trim(); // > 4000 chars, paragraph-aware
    const r = await post('tid', { markdown: long });

    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(calls.length).toBeGreaterThanOrEqual(2); // at least two chunks
    for (const c of calls) {
      expect((c.markdown ?? '').length).toBeLessThanOrEqual(TELEGRAM_PLAIN_LIMIT);
    }
    expect(r).toEqual({ id: 'o1', threadId: 'tid' });
  });

  it('falls back after sendRichMessage fails in image+long path, photo head still returned', async () => {
    const sendPhoto = vi.fn(async () => ({ id: 'p1', threadId: 'tid' }) as PostResult);
    const sendRichMessage = vi.fn(async () => {
      throw new Error('unsupported');
    });
    const { original, calls } = makeOriginal();
    const post = wrapPostMessageWithRich({ sendPhoto, sendRichMessage }, original, identity);

    const long = 'a'.repeat(TELEGRAM_CAPTION_LIMIT + 100);
    const r = await post('tid', { markdown: long, files: [makeImage()] });

    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(calls.length).toBeGreaterThanOrEqual(1); // body delivered via chunked text
    expect(r).toEqual({ id: 'p1', threadId: 'tid' }); // photo head
  });

  it('falls back to original when sendPhoto fails on image+short caption', async () => {
    const sendPhoto = vi.fn(async () => {
      throw new Error('413 payload too large');
    });
    const sendRichMessage = vi.fn();
    const { original, calls } = makeOriginal();
    const post = wrapPostMessageWithRich({ sendPhoto, sendRichMessage }, original, visible);

    const img = makeImage();
    const r = await post('tid', { markdown: 'short', files: [img] });

    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(calls).toEqual([{ markdown: '<short>', files: [img] }]);
    expect(r).toEqual({ id: 'o1', threadId: 'tid' });
  });

  it('passes cards straight through to the original SDK', async () => {
    const { senders, sendPhoto, sendRichMessage } = makeSenders();
    const { original, calls } = makeOriginal();
    const post = wrapPostMessageWithRich(senders, original, visible);

    const card = { title: 'Q', children: [] };
    await post('tid', { card, fallbackText: 'fallback' });

    expect(sendPhoto).not.toHaveBeenCalled();
    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(calls).toEqual([{ card, fallbackText: 'fallback' }]);
  });

  it('routes non-image file (no markdown) to the original SDK', async () => {
    const { senders, sendPhoto, sendRichMessage } = makeSenders();
    const { original, calls } = makeOriginal();
    const post = wrapPostMessageWithRich(senders, original, identity);

    const doc: OutboundFile = { data: Buffer.from('pdf'), filename: 'report.pdf' };
    await post('tid', { files: [doc] });

    expect(sendPhoto).not.toHaveBeenCalled();
    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(calls).toEqual([{ files: [doc] }]);
  });

  it('routes two-image attachment to the original SDK (not the single-image fast path)', async () => {
    const { senders, sendPhoto } = makeSenders();
    const { original, calls } = makeOriginal();
    const post = wrapPostMessageWithRich(senders, original, identity);

    const files = [makeImage('a.png'), makeImage('b.jpg')];
    await post('tid', { markdown: 'pair', files });

    expect(sendPhoto).not.toHaveBeenCalled();
    expect(calls).toEqual([{ markdown: 'pair', files }]);
  });
});

describe('sendTelegramRichMessage', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), {
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs sendRichMessage with chat_id and rich_message.markdown for a plain chat thread', async () => {
    const r = await sendTelegramRichMessage('TOKEN', '12345', '# hello\n\n$$x^2$$');

    const f = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendRichMessage');
    expect(init?.method).toBe('POST');
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body).toEqual({
      chat_id: '12345',
      rich_message: { markdown: '# hello\n\n$$x^2$$' },
    });
    expect(r).toEqual({ id: '4242', threadId: '12345' });
  });

  it('forwards message_thread_id as a number when the threadId carries one', async () => {
    await sendTelegramRichMessage('T', '12345:7', 'body');

    const f = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const body = JSON.parse((f.mock.calls[0][1]?.body as string) ?? '{}');
    expect(body.chat_id).toBe('12345');
    expect(body.message_thread_id).toBe(7);
  });

  it('throws with Telegram description when the API returns ok=false', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, description: 'METHOD_NOT_FOUND' }), {
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    await expect(sendTelegramRichMessage('T', '1', 'x')).rejects.toThrow(/METHOD_NOT_FOUND/);
  });
});
