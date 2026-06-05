/**
 * Voice/audio transcription via OpenAI Whisper API.
 *
 * The Telegram bridge downloads voice notes as .ogg files into the agent's
 * inbox (referenced in the formatter as `[voice: ... — saved to /workspace/inbox/...]`).
 * This tool transcribes them on demand using OPENAI_API_KEY from the
 * container environment.
 */
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const transcribeAudio: McpToolDefinition = {
  tool: {
    name: 'transcribe_audio',
    description:
      'Transcribe an audio file (voice note, recording) to text via OpenAI Whisper. Use whenever you receive a voice attachment.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description:
            'Absolute path to the audio file inside the container (e.g., /workspace/inbox/<msgId>/attachment-1.ogg).',
        },
      },
      required: ['path'],
    },
  },
  async handler(args) {
    const filePath = String(args.path ?? '');
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return err('OPENAI_API_KEY is not set in the container environment');
    if (!filePath) return err('path is required');
    if (!fs.existsSync(filePath)) return err(`File not found: ${filePath}`);

    const buffer = fs.readFileSync(filePath);
    const filename = path.basename(filePath) || 'audio.ogg';
    const form = new FormData();
    form.append('file', new Blob([buffer]), filename);
    form.append('model', 'whisper-1');
    form.append('response_format', 'text');

    try {
      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!res.ok) {
        const detail = await res.text();
        return err(`Whisper API ${res.status}: ${detail.slice(0, 300)}`);
      }
      const transcript = (await res.text()).trim();
      return ok(transcript || '(empty transcript)');
    } catch (e) {
      return err(`Whisper request failed: ${String(e)}`);
    }
  },
};

registerTools([transcribeAudio]);
