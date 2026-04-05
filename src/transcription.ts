import fs from 'fs';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

/**
 * Transcribe an audio file using OpenAI Whisper API.
 * Reads OPENAI_API_KEY from .env. Returns transcript text or null.
 */
export async function transcribeAudio(
  filePath: string,
): Promise<string | null> {
  const env = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = env.OPENAI_API_KEY;

  if (!apiKey) {
    logger.warn(
      'OPENAI_API_KEY not set in .env — voice transcription disabled',
    );
    return null;
  }

  try {
    const openaiModule = await import('openai');
    const OpenAI = openaiModule.default;
    const toFile = openaiModule.toFile;

    const openai = new OpenAI({ apiKey });
    const audioBuffer = fs.readFileSync(filePath);

    const file = await toFile(audioBuffer, 'voice.ogg', {
      type: 'audio/ogg',
    });

    const transcript = (await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'text',
    })) as unknown as string;

    const text = transcript?.trim();
    if (!text) return null;

    logger.info({ filePath, length: text.length }, 'Audio transcribed');
    return text;
  } catch (err) {
    logger.error({ err, filePath }, 'Transcription error');
    return null;
  }
}
