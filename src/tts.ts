import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const DEFAULT_VOICE = 'marin';
const DEFAULT_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_SPEED = 1.15;
const DEFAULT_INSTRUCTIONS =
  'You are Yuna, a 30-year-old japanese woman working as a CEO personal assistant. ' +
  'Speak naturally with real emotion and warmth. ' +
  'Make me feel how care you are and your surrounding supporting woman energy. ' +
  'Vary your intonation like in a real conversation — smile when something is nice, ' +
  'pause briefly when thinking, let curiosity come through in your voice. ' +
  'Sound like a real person talking to a friend. ' +
  "Don't pause much near commas and names.";

/**
 * Synthesize speech from text using OpenAI TTS API.
 * Returns OGG Opus buffer suitable for Telegram voice notes, or null on failure.
 */
export async function synthesizeVoice(text: string): Promise<Buffer | null> {
  const env = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = env.OPENAI_API_KEY;

  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set in .env — TTS disabled');
    return null;
  }

  try {
    const openaiModule = await import('openai');
    const OpenAI = openaiModule.default;
    const openai = new OpenAI({ apiKey });

    const response = await openai.audio.speech.create({
      input: text,
      model: DEFAULT_MODEL,
      voice: DEFAULT_VOICE,
      response_format: 'opus',
      speed: DEFAULT_SPEED,
      instructions: DEFAULT_INSTRUCTIONS,
    });

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    logger.info(
      { textLength: text.length, audioSize: buffer.length },
      'Voice synthesized',
    );
    return buffer;
  } catch (err) {
    logger.error({ err, textLength: text.length }, 'TTS synthesis error');
    return null;
  }
}
