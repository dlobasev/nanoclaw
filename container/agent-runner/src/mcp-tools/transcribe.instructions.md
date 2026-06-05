## Voice and audio (`transcribe_audio`)

When you receive a voice note or audio attachment, you'll see it in the inbound message as something like:

```
[voice: attachment-1.ogg — saved to /workspace/inbox/<msgId>/attachment-1.ogg]
```

Call `mcp__nanoclaw__transcribe_audio({ path })` with that absolute path to get the spoken text. Then respond to the actual content of the voice message, not to the fact that it was a voice note. Don't ask the user to type it out instead.

If transcription returns an error (missing API key, network failure), acknowledge briefly and ask the user to retype the key points if needed.
