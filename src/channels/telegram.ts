import fs from 'fs';
import https from 'https';
import path from 'path';

import { Api, Bot, InputFile } from 'grammy';
import OpenAI from 'openai';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { createDraftStream, DraftStream } from '../draft-stream.js';
import { getLatestMessage, getMessageById, storeReaction } from '../db.js';
import { transcribeAudio } from '../transcription.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
/** Convert standard Markdown to Telegram Markdown v1 inline. */
function toTelegramMarkdown(text: string): string {
  // Bold: **text** → *text*
  let t = text.replace(/\*\*(.+?)\*\*/g, '*$1*');
  // Headings: ## Title → *Title*
  t = t.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  return t;
}

async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: {
    message_thread_id?: number;
    reply_parameters?: { message_id: number };
  } = {},
): Promise<void> {
  const formatted = toTelegramMarkdown(text);
  try {
    await api.sendMessage(chatId, formatted, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, formatted, options);
  }
}

const MAX_LENGTH = 4096;

/**
 * Split text into chunks that respect content boundaries.
 * Priority: code block boundaries > double newline (paragraph) > single newline > space > hard cut.
 */
export function splitMessage(text: string): string[] {
  if (text.length <= MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_LENGTH) {
    let splitAt = -1;

    // 1. Try to split at a code block boundary (``` on its own line)
    const codeBlockPattern = /\n```\n/g;
    let match;
    while ((match = codeBlockPattern.exec(remaining)) !== null) {
      const pos = match.index + match[0].length;
      if (pos <= MAX_LENGTH && pos > splitAt) {
        splitAt = pos;
      }
    }

    // 2. Try to split at a paragraph boundary (double newline)
    if (splitAt === -1) {
      const lastParagraph = remaining.lastIndexOf('\n\n', MAX_LENGTH);
      if (lastParagraph > MAX_LENGTH * 0.3) {
        splitAt = lastParagraph + 2;
      }
    }

    // 3. Try to split at a single newline
    if (splitAt === -1) {
      const lastNewline = remaining.lastIndexOf('\n', MAX_LENGTH);
      if (lastNewline > MAX_LENGTH * 0.3) {
        splitAt = lastNewline + 1;
      }
    }

    // 4. Try to split at a space
    if (splitAt === -1) {
      const lastSpace = remaining.lastIndexOf(' ', MAX_LENGTH);
      if (lastSpace > MAX_LENGTH * 0.3) {
        splitAt = lastSpace + 1;
      }
    }

    // 5. Hard cut (last resort)
    if (splitAt === -1) {
      splitAt = MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Truncate a string to a maximum length, appending "..." if truncated.
 */
function truncate(s: string, max = 120): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

/**
 * Resolve a Telegram reply context: look up the replied-to message in the DB
 * and return a prefix string with the quoted content.
 * Falls back to the reply message text if DB lookup fails (common for bot messages
 * whose DB id doesn't match Telegram message_id).
 */
function resolveReply(
  replyMsg: {
    message_id: number;
    text?: string;
    caption?: string;
    from?: { first_name?: string };
  },
  chatJid: string,
): string {
  // Try DB lookup first (may fail in tests where DB is not initialized)
  try {
    const original = getMessageById(replyMsg.message_id.toString(), chatJid);
    if (original) {
      return `[Replying to ${original.sender_name}: "${truncate(original.content, 200)}"]\n`;
    }
  } catch {
    // DB not available, fall through to Telegram message data
  }
  // Fall back to the reply message text directly from Telegram
  const text = replyMsg.text || replyMsg.caption;
  if (text) {
    const sender = replyMsg.from?.first_name || 'Unknown';
    return `[Replying to ${sender}: "${truncate(text, 200)}"]\n`;
  }
  return '';
}

/**
 * Resolve t.me/c/<chat_id>/<message_id> links in content.
 * Replaces each link with `[Message: "<content>"]` if found in DB.
 */
function resolveMessageLinks(content: string): string {
  return content.replace(
    /https?:\/\/t\.me\/c\/(\d+)\/(\d+)/g,
    (_match, rawChatId, msgId) => {
      // Telegram supergroup JID: URL chat_id is bare id without -100 prefix
      const candidateJids = [`tg:-100${rawChatId}`, `tg:${rawChatId}`];
      try {
        for (const jid of candidateJids) {
          const msg = getMessageById(msgId, jid);
          if (msg) return `[Message: "${truncate(msg.content)}"]`;
        }
      } catch {
        // DB not available
      }
      return `[Message: not found]`;
    },
  );
}

/**
 * Download a file from Telegram's file API.
 * Returns a Buffer with the file contents.
 */
async function downloadTelegramFile(bot: Bot, fileId: string): Promise<Buffer> {
  const file = await bot.api.getFile(fileId);
  const filePath = file.file_path!;
  const token = bot.token;
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
  });
}

/**
 * Save a Telegram document to the group's workspace and return the container path.
 */
async function saveDocument(
  bot: Bot,
  fileId: string,
  fileName: string,
  groupFolder: string,
): Promise<string | null> {
  try {
    const buffer = await downloadTelegramFile(bot, fileId);
    const docsDir = path.join(GROUPS_DIR, groupFolder, 'documents');
    fs.mkdirSync(docsDir, { recursive: true });
    // Prefix with timestamp to avoid collisions
    const safeName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const filePath = path.join(docsDir, safeName);
    fs.writeFileSync(filePath, buffer);
    logger.info(
      { groupFolder, fileName: safeName, size: buffer.length },
      'Saved Telegram document',
    );
    return `/workspace/group/documents/${safeName}`;
  } catch (err) {
    logger.error({ err, fileName }, 'Failed to save Telegram document');
    return null;
  }
}

/**
 * Save a Telegram photo to the group's workspace and return the file path.
 * Downloads the highest-resolution version of the photo.
 */
async function savePhoto(
  bot: Bot,
  photoSizes: Array<{ file_id: string; width: number; height: number }>,
  groupFolder: string,
): Promise<string | null> {
  try {
    // Pick the largest photo
    const largest = photoSizes.reduce((a, b) =>
      a.width * a.height > b.width * b.height ? a : b,
    );
    const buffer = await downloadTelegramFile(bot, largest.file_id);
    const imagesDir = path.join(GROUPS_DIR, groupFolder, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    const filename = `${Date.now()}.jpg`;
    const filePath = path.join(imagesDir, filename);
    fs.writeFileSync(filePath, buffer);
    logger.info(
      { groupFolder, filename, size: buffer.length },
      'Saved Telegram photo',
    );
    return `/workspace/group/images/${filename}`;
  } catch (err) {
    logger.error({ err }, 'Failed to save Telegram photo');
    return null;
  }
}

/**
 * Transcribe a voice message using OpenAI Whisper API.
 * Returns the transcript text, or null on failure.
 */
async function transcribeVoice(audioBuffer: Buffer): Promise<string | null> {
  const envVars = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = process.env.OPENAI_API_KEY || envVars.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set, cannot transcribe voice');
    return null;
  }

  try {
    const openai = new OpenAI({ apiKey });
    const file = new File([audioBuffer], 'voice.ogg', { type: 'audio/ogg' });
    const transcription = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file,
    });
    return transcription.text;
  } catch (err) {
    logger.error({ err }, 'OpenAI transcription failed');
    return null;
  }
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    // No pool bots — fall back to main bot sendMessage via channel
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    // Rename the bot to match the sender's role, then wait for Telegram to propagate
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn(
        { sender, err },
        'Failed to rename pool bot (sending anyway)',
      );
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      await sendTelegramMessage(api, numericId, chunk);
    }
    logger.info(
      {
        chatId,
        sender,
        poolIndex: idx,
        length: text.length,
        chunks: chunks.length,
      },
      'Pool message sent',
    );
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /**
   * Download a Telegram file to the group's attachments directory.
   * Returns the container-relative path (e.g. /workspace/group/attachments/photo_123.jpg)
   * or null if the download fails.
   */
  private async downloadFile(
    fileId: string,
    groupFolder: string,
    filename: string,
  ): Promise<string | null> {
    if (!this.bot) return null;

    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) {
        logger.warn({ fileId }, 'Telegram getFile returned no file_path');
        return null;
      }

      const groupDir = resolveGroupFolderPath(groupFolder);
      const attachDir = path.join(groupDir, 'attachments');
      fs.mkdirSync(attachDir, { recursive: true });

      // Sanitize filename and add extension from Telegram's file_path if missing
      const tgExt = path.extname(file.file_path);
      const localExt = path.extname(filename);
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalName = localExt ? safeName : `${safeName}${tgExt}`;
      const destPath = path.join(attachDir, finalName);

      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const resp = await fetch(fileUrl);
      if (!resp.ok) {
        logger.warn(
          { fileId, status: resp.status },
          'Telegram file download failed',
        );
        return null;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(destPath, buffer);

      logger.info({ fileId, dest: destPath }, 'Telegram file downloaded');
      return `/workspace/group/attachments/${finalName}`;
    } catch (err) {
      logger.error({ fileId, err }, 'Failed to download Telegram file');
      return null;
    }
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;

      const replyTo = ctx.message.reply_to_message;
      const replyToMessageId = replyTo?.message_id?.toString();
      const replyToContent = replyTo?.text || replyTo?.caption;
      const replyToSenderName = replyTo
        ? replyTo.from?.first_name ||
          replyTo.from?.username ||
          replyTo.from?.id?.toString() ||
          'Unknown'
        : undefined;

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Resolve reply context — include quoted message content for the agent
      if (replyTo) {
        const prefix = resolveReply(replyTo, chatJid);
        if (prefix) content = prefix + content;
      }

      // Handle Telegram's quote feature (selected text excerpt)
      if (ctx.message.quote?.text) {
        content = `[Quoted: "${truncate(ctx.message.quote.text, 300)}"]\n${content}`;
      }

      // Resolve t.me/c message links
      content = resolveMessageLinks(content);

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId ? threadId.toString() : undefined,
        reply_to_message_id: replyToMessageId,
        reply_to_message_content: replyToContent,
        reply_to_sender_name: replyToSenderName,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages: download files when possible, fall back to placeholders.
    const storeMedia = (
      ctx: any,
      placeholder: string,
      opts?: { fileId?: string; filename?: string },
    ) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      const deliver = (content: string) => {
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });
      };

      // If we have a file_id, attempt to download; deliver asynchronously
      if (opts?.fileId) {
        const msgId = ctx.message.message_id.toString();
        const filename =
          opts.filename ||
          `${placeholder.replace(/[\[\] ]/g, '').toLowerCase()}_${msgId}`;
        this.downloadFile(opts.fileId, group.folder, filename).then(
          (filePath) => {
            if (filePath) {
              deliver(`${placeholder} (${filePath})${caption}`);
            } else {
              deliver(`${placeholder}${caption}`);
            }
          },
        );
        return;
      }

      deliver(`${placeholder}${caption}`);
    };

    this.bot.on('message:photo', (ctx) => {
      // Telegram sends multiple sizes; last is largest
      const photos = ctx.message.photo;
      const largest = photos?.[photos.length - 1];
      storeMedia(ctx, '[Photo]', {
        fileId: largest?.file_id,
        filename: `photo_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:video', (ctx) => {
      storeMedia(ctx, '[Video]', {
        fileId: ctx.message.video?.file_id,
        filename: `video_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const fileId = ctx.message.voice?.file_id;
      if (!fileId) {
        storeMedia(ctx, '[Voice message]');
        return;
      }

      const filename = `voice_${ctx.message.message_id}`;
      const filePath = await this.downloadFile(fileId, group.folder, filename);
      if (!filePath) {
        storeMedia(ctx, '[Voice message]');
        return;
      }

      // Resolve the actual host path for transcription
      const groupDir = resolveGroupFolderPath(group.folder);
      const hostPath = filePath.replace('/workspace/group/', `${groupDir}/`);

      const transcript = await transcribeAudio(hostPath);
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      const content = transcript
        ? `[Voice: ${transcript}]${caption}`
        : `[Voice message] (${filePath})${caption}`;

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, transcribed: !!transcript },
        'Telegram voice message processed',
      );
    });
    this.bot.on('message:audio', (ctx) => {
      const name =
        ctx.message.audio?.file_name || `audio_${ctx.message.message_id}`;
      storeMedia(ctx, '[Audio]', {
        fileId: ctx.message.audio?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeMedia(ctx, `[Document: ${name}]`, {
        fileId: ctx.message.document?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeMedia(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeMedia(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeMedia(ctx, '[Contact]'));

    // Handle emoji reactions — deliver as messages and store in DB
    this.bot.on('message_reaction', (ctx) => {
      const update = ctx.messageReaction;
      if (!update) return;

      const chatJid = `tg:${update.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const newReactions = update.new_reaction || [];
      const oldReactions = update.old_reaction || [];

      // Find added reactions (in new but not in old)
      const added = newReactions.filter(
        (nr) =>
          nr.type === 'emoji' &&
          !oldReactions.some(
            (or) => or.type === 'emoji' && or.emoji === nr.emoji,
          ),
      );

      if (added.length === 0) return;

      const reactorId = update.user?.id?.toString() || '';
      const senderName =
        update.user?.first_name ||
        update.user?.username ||
        update.user?.id?.toString() ||
        'Unknown';
      const timestamp = new Date(update.date * 1000).toISOString();
      const emojis = added.map((r) => (r as { emoji: string }).emoji).join('');

      // Deliver reaction as a message for the agent
      this.opts.onMessage(chatJid, {
        id: `reaction_${update.message_id}_${Date.now()}`,
        chat_jid: chatJid,
        sender: reactorId,
        sender_name: senderName,
        content: `[Reaction: ${emojis} to message #${update.message_id}]`,
        timestamp,
        is_from_me: false,
      });

      // Store each reaction in the database
      for (const reaction of added) {
        if (reaction.type === 'emoji') {
          storeReaction({
            message_id: update.message_id.toString(),
            message_chat_jid: chatJid,
            reactor_jid: `${reactorId}@telegram`,
            reactor_name: senderName,
            emoji: reaction.emoji,
            timestamp,
          });
        }
      }

      logger.info(
        { chatJid, emojis, messageId: update.message_id, sender: senderName },
        'Telegram reaction received and stored',
      );
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        allowed_updates: ['message', 'edited_message', 'message_reaction'],
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const options: {
        message_thread_id?: number;
        reply_parameters?: { message_id: number };
      } = {};

      if (replyToMessageId) {
        options.reply_parameters = {
          message_id: parseInt(replyToMessageId, 10),
        };
      }

      // Split respecting content boundaries (code blocks, paragraphs, etc.)
      const chunks = splitMessage(text);
      for (let i = 0; i < chunks.length; i++) {
        // Only reply on the first chunk
        const chunkOptions = i === 0 ? options : {};
        await sendTelegramMessage(
          this.bot.api,
          numericId,
          chunks[i],
          chunkOptions,
        );
      }
      logger.info(
        { jid, length: text.length, replyToMessageId, chunks: chunks.length },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendReaction(
    jid: string,
    messageId: string | undefined,
    emoji: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    // If no messageId provided, react to the latest message
    if (!messageId) {
      const latest = getLatestMessage(jid);
      if (!latest) {
        logger.warn({ jid }, 'No messages found to react to');
        return;
      }
      messageId = latest.id;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const msgId = parseInt(messageId, 10);
      await this.bot.api.raw.setMessageReaction({
        chat_id: numericId,
        message_id: msgId,
        reaction: emoji ? [{ type: 'emoji', emoji: emoji as any }] : [],
      });
      logger.info({ jid, messageId, emoji }, 'Telegram reaction sent');
    } catch (err) {
      logger.error(
        { jid, messageId, emoji, err },
        'Failed to send Telegram reaction',
      );
    }
  }

  async sendFile(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const fileBuffer = fs.readFileSync(filePath);
      const filename = path.basename(filePath);

      await this.bot.api.sendDocument(
        numericId,
        new InputFile(fileBuffer, filename),
        caption ? { caption } : undefined,
      );

      logger.info({ jid, filePath, filename }, 'Telegram file sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Telegram file');
    }
  }

  async sendVoice(
    jid: string,
    audioBuffer: Buffer,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendVoice(
        numericId,
        new InputFile(audioBuffer, 'voice.ogg'),
        caption ? { caption } : undefined,
      );
      logger.info({ jid, size: audioBuffer.length }, 'Telegram voice sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram voice');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }

  async reactToLatestMessage(jid: string, emoji: string): Promise<void> {
    const latest = getLatestMessage(jid);
    if (!latest) {
      logger.warn({ jid }, 'No messages found to react to');
      return;
    }
    await this.sendReaction(jid, latest.id, emoji);
  }

  createDraftStream(jid: string): DraftStream {
    const numericId = jid.replace(/^tg:/, '');
    return createDraftStream({
      sendMessage: async (text) => {
        const msg = await this.bot!.api.sendMessage(numericId, text);
        return msg.message_id;
      },
      editMessage: async (messageId, text) => {
        await this.bot!.api.editMessageText(numericId, messageId, text);
      },
      deleteMessage: async (messageId) => {
        await this.bot!.api.deleteMessage(numericId, messageId);
      },
      throttleMs: 1000,
      maxLength: 4096,
      minInitialChars: 30,
    });
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
