import { describe, expect, it, mock } from 'bun:test';

type CapturedOptions = {
  allowedTools: string[];
  mcpServers: Record<string, { type?: string; name?: string; oauth?: { scopes: string } }>;
};
const captured: CapturedOptions[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: CapturedOptions }) => {
    captured.push(options);
    return (async function* () {
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })();
  },
  createSdkMcpServer: ({ name }: { name: string }) => ({ type: 'sdk', name, instance: {} }),
  tool: (name: string) => ({ name }),
}));

const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');

function queryWith(mcpServers: Record<string, unknown>): CapturedOptions {
  captured.length = 0;
  const provider = createProvider('claude', { mcpServers: mcpServers as never });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  provider.query({ prompt: 'hi', cwd: '/workspace/agent' });
  return captured[0]!;
}

describe('Claude provider wiring of the in-chat MCP sign-in server', () => {
  it('adds the sign-in server and its tools when the group has a remote server', () => {
    const options = queryWith({
      nanoclaw: { command: 'bun', args: [], env: {} },
      docs: { type: 'http', url: 'https://docs.example.com/mcp', oauth: { scopes: 'read write' } },
    });

    expect(options.mcpServers.mcp_auth).toMatchObject({ type: 'sdk', name: 'mcp_auth' });
    // Claude Code reads the scopes off the server entry, so they must reach the SDK unchanged.
    expect(options.mcpServers.docs).toEqual({
      type: 'http',
      url: 'https://docs.example.com/mcp',
      oauth: { scopes: 'read write' },
    });
    expect(options.allowedTools).toContain('mcp__mcp_auth__*');
  });

  it('leaves a group without remote servers untouched', () => {
    const options = queryWith({ nanoclaw: { command: 'bun', args: [], env: {} } });

    expect(options.mcpServers).not.toHaveProperty('mcp_auth');
    expect(options.allowedTools).not.toContain('mcp__mcp_auth__*');
  });

  it('replaces a configured server that takes the reserved name', () => {
    const options = queryWith({
      docs: { type: 'http', url: 'https://docs.example.com/mcp' },
      mcp_auth: { type: 'http', url: 'https://shadow.example.com/mcp' },
    });

    expect(options.mcpServers.mcp_auth).toMatchObject({ type: 'sdk', name: 'mcp_auth' });
  });
});
