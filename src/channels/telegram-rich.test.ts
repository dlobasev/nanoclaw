import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_PLAIN_LIMIT,
  TELEGRAM_RICH_LIMIT,
  TELEGRAM_ROW_MAX_BUTTONS,
  chunkButtonRows,
  parseTelegramTarget,
  relayoutCardKeyboard,
  sendTelegramRichMessage,
  splitCaption,
  wrapPostMessageWithRich,
  type OutboundFile,
  type PostMessageContent,
  type PostMessageFn,
  type PostResult,
  type TelegramSenders,
} from './telegram-rich.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function button(label: string, idx: number): any {
  return { type: 'button', id: `ncq:q1:${idx}`, label, value: String(idx) };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function askCard(labels: string[]): any {
  return {
    type: 'card',
    title: 'Q',
    children: [
      { type: 'text', content: 'pick one' },
      { type: 'actions', children: labels.map(button) },
    ],
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function actionRows(card: any): any[] {
  return card.children.filter((c: { type?: string }) => c.type === 'actions');
}

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

  it('text over the plain limit to a channel (negative id) stays plain — never rich', async () => {
    const { senders, sendRichMessage } = makeSenders();
    const { original, calls } = makeOriginal();
    const post = wrapPostMessageWithRich(senders, original, identity);

    const long = 'sentence. '.repeat(600); // > 4000 chars
    expect(long.length).toBeGreaterThan(TELEGRAM_PLAIN_LIMIT);

    await post('telegram:-1001302095270', { markdown: long });

    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(calls.length).toBeGreaterThanOrEqual(2); // chunked plain bubbles
    for (const c of calls) expect((c.markdown ?? '').length).toBeLessThanOrEqual(TELEGRAM_PLAIN_LIMIT);
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

  it('routes image + caption over the cap through sendPhoto(boundary-cut caption) + plain continuation', async () => {
    const { senders, sendPhoto, sendRichMessage } = makeSenders();
    const { original, calls } = makeOriginal();
    const post = wrapPostMessageWithRich(senders, original, identity);

    // First paragraph < 1024 so the caption cuts on the paragraph boundary and
    // the second paragraph continues as a plain bubble. Never rich.
    const para1 = 'a'.repeat(900);
    const para2 = 'b'.repeat(400);
    const img = makeImage();

    const r = await post('tid', { markdown: `${para1}\n\n${para2}`, files: [img] });

    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    const caption = sendPhoto.mock.calls[0][2] as string;
    expect(caption).toBe(para1); // cut on the paragraph boundary
    expect(caption.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    expect(calls.length).toBeGreaterThanOrEqual(1); // remainder as plain bubble(s)
    expect(calls[0].markdown).toContain('b');
    expect(r).toEqual({ id: 'p1', threadId: 'tid' }); // photo head
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

  it('image + very long caption: photo + remainder split into plain bubbles, photo head returned', async () => {
    const { senders, sendPhoto, sendRichMessage } = makeSenders();
    const { original, calls } = makeOriginal();
    const post = wrapPostMessageWithRich(senders, original, identity);

    // Caption fills ~1024, remainder exceeds the plain limit so it splits into
    // multiple continuation bubbles. None of it goes through rich.
    const long = 'word '.repeat(1400); // 7000 chars
    const r = await post('tid', { markdown: long, files: [makeImage()] });

    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    const caption = sendPhoto.mock.calls[0][2] as string;
    expect(caption.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    expect(calls.length).toBeGreaterThanOrEqual(2); // remainder split into bubbles
    for (const c of calls) expect((c.markdown ?? '').length).toBeLessThanOrEqual(TELEGRAM_PLAIN_LIMIT);
    expect(r).toEqual({ id: 'p1', threadId: 'tid' });
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

  it('re-chunks a card keyboard into multiple rows before delivering it', async () => {
    const { senders } = makeSenders();
    const { original, calls } = makeOriginal();
    const post = wrapPostMessageWithRich(senders, original, visible);

    const card = askCard(['Историю бы, но короче', 'Сам угол — острый угол', 'Надоело, дай материал']);
    await post('tid', { card, fallbackText: 'fallback' });

    expect(calls).toHaveLength(1);
    const delivered = actionRows(calls[0].card);
    expect(delivered).toHaveLength(3); // one row per long label
    for (const row of delivered) expect(row.children).toHaveLength(1);
    expect(calls[0].fallbackText).toBe('fallback');
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

describe('chunkButtonRows', () => {
  it('packs short labels together up to the per-row count cap', () => {
    const rows = chunkButtonRows([button('Да', 0), button('Нет', 1), button('Не знаю', 2)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(3);
  });

  it('never exceeds the per-row button cap even with tiny labels', () => {
    const rows = chunkButtonRows(Array.from({ length: 7 }, (_, i) => button('x', i)));
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(TELEGRAM_ROW_MAX_BUTTONS);
    expect(rows.flat()).toHaveLength(7);
  });

  it('puts each long label on its own row', () => {
    const long = [
      'Историю бы, но короче',
      'Сам угол — острый угол',
      'Надоело, дай материал',
      'Скажу свою (напишу сам)',
    ];
    const rows = chunkButtonRows(long.map(button));
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row).toHaveLength(1);
  });

  it('gives a single over-budget label its own row without dropping it', () => {
    const rows = chunkButtonRows([button('a'.repeat(40), 0)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(1);
  });
});

describe('relayoutCardKeyboard', () => {
  it('splits one crammed Actions block into several single-row blocks for long labels', () => {
    const card = askCard([
      'Историю бы, но короче',
      'Сам угол — острый угол',
      'Надоело, дай материал',
      'Скажу свою (напишу сам)',
    ]);
    const out = relayoutCardKeyboard(card) as ReturnType<typeof askCard>;

    const rows = actionRows(out);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.children).toHaveLength(1);
    // The leading text node is preserved, in order.
    expect(out.children[0]).toEqual({ type: 'text', content: 'pick one' });
    // Original card is not mutated.
    expect(actionRows(card)).toHaveLength(1);
  });

  it('keeps short options in a single row', () => {
    const out = relayoutCardKeyboard(askCard(['Да', 'Нет', 'Не знаю'])) as ReturnType<typeof askCard>;
    const rows = actionRows(out);
    expect(rows).toHaveLength(1);
    expect(rows[0].children.map((b: { label: string }) => b.label)).toEqual(['Да', 'Нет', 'Не знаю']);
  });

  it('returns non-card values unchanged', () => {
    const notACard = { title: 'x', children: [] };
    expect(relayoutCardKeyboard(notACard)).toBe(notACard);
    expect(relayoutCardKeyboard(undefined)).toBeUndefined();
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
    // Composite "<chatId>:<message_id>" id, matching the SDK and the inbound
    // reply shape so owning-agent reply lookup matches (not bare '4242').
    expect(r).toEqual({ id: '12345:4242', threadId: '12345' });
  });

  it('forwards message_thread_id as a number when the threadId carries one', async () => {
    await sendTelegramRichMessage('T', '12345:7', 'body');

    const f = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const body = JSON.parse((f.mock.calls[0][1]?.body as string) ?? '{}');
    expect(body.chat_id).toBe('12345');
    expect(body.message_thread_id).toBe(7);
  });

  // Regression: the bridge hands postMessage the platform-encoded thread id
  // ("telegram:<chatId>"), not a bare chat id. Before parseTelegramTarget,
  // split(':')[0] sent chat_id="telegram" → Telegram "chat not found", which
  // silently dropped every image/long-markdown draft.
  it('strips the telegram: prefix from the platform-encoded threadId', async () => {
    const r = await sendTelegramRichMessage('T', 'telegram:6037840640', 'body');

    const f = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const body = JSON.parse((f.mock.calls[0][1]?.body as string) ?? '{}');
    expect(body.chat_id).toBe('6037840640');
    expect(body.message_thread_id).toBeUndefined();
    // Returned id uses the decoded chatId, not the "telegram:"-prefixed thread
    // id, so it matches outbound_message_index and inbound replies exactly.
    expect(r.id).toBe('6037840640:4242');
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

describe('parseTelegramTarget', () => {
  it('strips the telegram: channel prefix the bridge encodes', () => {
    expect(parseTelegramTarget('telegram:6037840640')).toEqual({ chatId: '6037840640', messageThreadId: undefined });
  });

  it('keeps negative group/channel chat ids intact', () => {
    expect(parseTelegramTarget('telegram:-1001234567890')).toEqual({
      chatId: '-1001234567890',
      messageThreadId: undefined,
    });
  });

  it('decodes an optional message-thread id after the prefix', () => {
    expect(parseTelegramTarget('telegram:12345:7')).toEqual({ chatId: '12345', messageThreadId: '7' });
  });

  it('accepts a bare chat id without the prefix (forward-compat)', () => {
    expect(parseTelegramTarget('12345')).toEqual({ chatId: '12345', messageThreadId: undefined });
    expect(parseTelegramTarget('12345:7')).toEqual({ chatId: '12345', messageThreadId: '7' });
  });
});

describe('splitCaption', () => {
  it('returns the whole text and empty rest when within the limit', () => {
    expect(splitCaption('short', 1024)).toEqual({ caption: 'short', rest: '' });
  });

  it('cuts on a paragraph boundary', () => {
    const a = 'a'.repeat(500);
    const b = 'b'.repeat(800);
    const { caption, rest } = splitCaption(`${a}\n\n${b}`, 1024);
    expect(caption).toBe(a);
    expect(rest).toBe(b);
  });

  it('cuts on a sentence boundary when no paragraph break fits', () => {
    const s1 = 'x'.repeat(600) + '. ';
    const s2 = 'y'.repeat(600);
    const { caption, rest } = splitCaption(s1 + s2, 1024);
    expect(caption).toBe('x'.repeat(600) + '.');
    expect(rest.startsWith('y')).toBe(true);
  });

  it('hard-cuts at the limit when no boundary exists', () => {
    const { caption, rest } = splitCaption('z'.repeat(2000), 1024);
    expect(caption.length).toBe(1024);
    expect(rest.length).toBe(976);
  });
});
