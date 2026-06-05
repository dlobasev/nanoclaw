/**
 * Voice/audio transcription via OpenAI Whisper API.
 *
 * The Telegram bridge downloads voice notes as .ogg files into the agent's
 * inbox (referenced in the formatter as `[voice: ... — saved to /workspace/inbox/...]`).
 * This tool transcribes them on demand.
 *
 * Auth: the container's HTTPS_PROXY routes outbound traffic through OneCLI's
 * gateway, which injects the OpenAI API key into the Authorization header
 * (vault secret named `OpenAI`, host pattern `api.openai.com`). No api key is
 * read from env — we send a placeholder Bearer that the gateway overwrites.
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
        // Placeholder bearer — OneCLI gateway replaces with the real OpenAI
        // key from the vault if the agent has access to the `OpenAI` secret.
        headers: { Authorization: 'Bearer onecli-inject' },
        body: form,
      });
      if (!res.ok) {
        const detail = await res.text();
        if (res.status === 401) {
          return err(
            `Whisper API 401 — OneCLI did not inject the OpenAI key. Verify the agent is allowed to use the OpenAI secret (PUT /api/agents/<id>/secrets).`,
          );
        }
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
