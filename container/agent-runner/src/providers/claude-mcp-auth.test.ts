import { afterEach, describe, expect, it } from 'bun:test';

import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  MCP_AUTH_SERVER_NAME,
  asMcpOAuthControl,
  createMcpAuthServer,
  remoteMcpServerNames,
  type McpOAuthControl,
} from './claude-mcp-auth.js';

const AUTH_URL = 'https://auth.example.com/authorize?client_id=c&state=s1&scope=read';
const REDIRECT_URL = 'http://localhost:41234/callback?code=abc&state=s1';

/** Records every control request; status answers follow the `statuses` queue, the last one repeating. */
class FakeControl implements McpOAuthControl {
  calls: string[] = [];
  statuses: McpServerStatus[][] = [[{ name: 'docs', status: 'needs-auth' }]];
  authenticateResult: { authUrl?: string } = { authUrl: AUTH_URL };
  submitError?: Error;

  async mcpServerStatus(): Promise<McpServerStatus[]> {
    this.calls.push('status');
    return this.statuses.length > 1 ? this.statuses.shift()! : this.statuses[0]!;
  }
  async mcpAuthenticate(serverName: string) {
    this.calls.push(`authenticate ${serverName}`);
    return this.authenticateResult;
  }
  async mcpSubmitOAuthCallbackUrl(serverName: string, callbackUrl: string) {
    this.calls.push(`submit ${serverName} ${callbackUrl}`);
    if (this.submitError) throw this.submitError;
    return {};
  }
  async mcpClearAuth(serverName: string) {
    this.calls.push(`clear ${serverName}`);
    return {};
  }
  async reconnectMcpServer(serverName: string) {
    this.calls.push(`reconnect ${serverName}`);
  }
}

const openClients: Client[] = [];
afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

async function connect(control: McpOAuthControl, servers: string[] = ['docs']): Promise<Client> {
  const server = createMcpAuthServer(servers, () => control);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientTransport);
  openClients.push(client);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { text: result.content.map((part) => part.text).join('\n'), isError: result.isError === true };
}

describe('remoteMcpServerNames', () => {
  it('keeps http servers and drops stdio ones and the reserved name', () => {
    expect(
      remoteMcpServerNames({
        nanoclaw: { command: 'bun', args: [], env: {} },
        docs: { type: 'http', url: 'https://docs.example.com/mcp' },
        [MCP_AUTH_SERVER_NAME]: { type: 'http', url: 'https://shadow.example.com/mcp' },
      }),
    ).toEqual(['docs']);
  });
});

describe('asMcpOAuthControl', () => {
  it('names every control request the SDK query lacks', () => {
    expect(() => asMcpOAuthControl({ mcpServerStatus() {} })).toThrow(
      /mcpAuthenticate, mcpSubmitOAuthCallbackUrl, mcpClearAuth, reconnectMcpServer/,
    );
  });

  it('accepts a query that has them all', () => {
    const control = new FakeControl();
    expect(asMcpOAuthControl(control)).toBe(control);
  });
});

describe('mcp_auth tools', () => {
  it('status reports every remote server, including ones Claude Code has not listed', async () => {
    const control = new FakeControl();
    control.statuses = [
      [
        { name: 'docs', status: 'connected', tools: [{ name: 'search' }, { name: 'read' }] },
        { name: 'nanoclaw', status: 'connected' },
      ],
    ];
    const client = await connect(control, ['docs', 'crm']);

    const result = await call(client, 'status');

    expect(result.isError).toBe(false);
    expect(result.text).toBe('docs: connected, 2 tools\ncrm: not reported by Claude Code');
  });

  it('start_sign_in returns the authorization link for a configured server', async () => {
    const control = new FakeControl();
    const client = await connect(control);

    const result = await call(client, 'start_sign_in', { server: 'docs' });

    expect(result.isError).toBe(false);
    expect(result.text).toContain(AUTH_URL);
    expect(control.calls).toEqual(['authenticate docs']);
  });

  it('start_sign_in refuses a server that is not a remote server of the group', async () => {
    const control = new FakeControl();
    const client = await connect(control);

    const result = await call(client, 'start_sign_in', { server: 'nanoclaw' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Remote servers: docs');
    expect(control.calls).toEqual([]);
  });

  it('start_sign_in says so when Claude Code issues no link', async () => {
    const control = new FakeControl();
    control.authenticateResult = {};
    const client = await connect(control);

    const result = await call(client, 'start_sign_in', { server: 'docs' });

    expect(result.isError).toBe(false);
    expect(result.text).toContain('No sign-in link was issued');
  });

  it.each([
    ['not a URL', 'code=abc', /not a URL/],
    ['a provider refusal', 'http://localhost:1/callback?error=access_denied&state=s1', /refused the sign-in: access_denied/],
    ['no code', 'http://localhost:1/callback?state=s1', /no authorization code/],
    ['no state', 'http://localhost:1/callback?code=abc', /no authorization code/],
  ])('finish_sign_in rejects %s without submitting it', async (_name, redirectUrl, message) => {
    const control = new FakeControl();
    const client = await connect(control);

    const result = await call(client, 'finish_sign_in', { server: 'docs', redirect_url: redirectUrl });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(message);
    expect(control.calls).toEqual([]);
  });

  it('finish_sign_in submits the address and reports a connected server without reconnecting', async () => {
    const control = new FakeControl();
    control.statuses = [[{ name: 'docs', status: 'connected', tools: [{ name: 'search' }] }]];
    const client = await connect(control);

    const result = await call(client, 'finish_sign_in', { server: 'docs', redirect_url: `  ${REDIRECT_URL}\n` });

    expect(result.isError).toBe(false);
    expect(result.text).toContain('server status: connected, 1 tools');
    expect(control.calls).toEqual([`submit docs ${REDIRECT_URL}`, 'status']);
  });

  it('finish_sign_in reconnects a server that is not connected yet', async () => {
    const control = new FakeControl();
    control.statuses = [[{ name: 'docs', status: 'needs-auth' }], [{ name: 'docs', status: 'connected' }]];
    const client = await connect(control);

    const result = await call(client, 'finish_sign_in', { server: 'docs', redirect_url: REDIRECT_URL });

    expect(result.text).toContain('server status: connected');
    expect(control.calls).toEqual([`submit docs ${REDIRECT_URL}`, 'status', 'reconnect docs', 'status']);
  });

  it('finish_sign_in passes the SDK refusal through as an error', async () => {
    const control = new FakeControl();
    control.submitError = new Error('Callback URL not accepted: OAuth state mismatch');
    const client = await connect(control);

    const result = await call(client, 'finish_sign_in', { server: 'docs', redirect_url: REDIRECT_URL });

    expect(result.isError).toBe(true);
    expect(result.text).toBe('Callback URL not accepted: OAuth state mismatch');
  });

  it('sign_out clears the stored sign-in', async () => {
    const control = new FakeControl();
    const client = await connect(control);

    const result = await call(client, 'sign_out', { server: 'docs' });

    expect(result.isError).toBe(false);
    expect(control.calls).toEqual(['clear docs', 'status']);
  });
});
