/**
 * In-chat OAuth sign-in for the remote MCP servers configured in this group.
 *
 * Claude Code owns MCP OAuth for `type: 'http'` servers: it registers the
 * client (CIMD or DCR), keeps the tokens in its credential store (the group's
 * mounted `.claude-shared`, so they outlive the container) and refreshes them.
 * Headless, it cannot open a browser, so the SDK exposes the flow as control
 * requests: `mcpAuthenticate` returns the authorization URL, and
 * `mcpSubmitOAuthCallbackUrl` takes the address the provider redirected the
 * user's browser to. This module puts those requests behind four tools of an
 * in-process MCP server, so the agent can hand the link to the user in chat
 * and finish the sign-in with the address the user sends back.
 *
 * The flow in progress (PKCE verifier, state) lives in the Claude Code process
 * of the query that started it. The poll loop keeps one query open across
 * turns, so a reply in the same container finishes it; after a container
 * restart the sign-in has to start again.
 */
// Namespace import on purpose: the provider tests replace the SDK module with
// one that exports only `query`, and a named import of a missing export fails
// at link time. The helpers are only reached when a group has remote servers.
import * as agentSdk from '@anthropic-ai/claude-agent-sdk';
import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { McpServerConfig } from './types.js';

/**
 * In-process server name, reserved: it replaces a configured server of the
 * same name. Its tools reach the model as `mcp__mcp_auth__<tool>`.
 */
export const MCP_AUTH_SERVER_NAME = 'mcp_auth';

/** The group's remote MCP servers: the ones Claude Code signs in to over OAuth. */
export function remoteMcpServerNames(servers: Record<string, McpServerConfig>): string[] {
  return Object.entries(servers)
    .filter(([name, config]) => config.type === 'http' && name !== MCP_AUTH_SERVER_NAME)
    .map(([name]) => name);
}

/** What `mcpAuthenticate` returns when the CLI starts a browser sign-in. */
interface McpAuthenticateResult {
  authUrl?: string;
  requiresUserAction?: boolean;
  callbackExpected?: boolean;
}

/**
 * The SDK control requests this module drives. Agent SDK 0.3.321 implements
 * them on `Query` but leaves the OAuth ones out of `sdk.d.ts`, so they are
 * typed here and checked at call time.
 */
export interface McpOAuthControl {
  mcpServerStatus(): Promise<McpServerStatus[]>;
  mcpAuthenticate(serverName: string): Promise<McpAuthenticateResult>;
  mcpSubmitOAuthCallbackUrl(serverName: string, callbackUrl: string): Promise<unknown>;
  mcpClearAuth(serverName: string): Promise<unknown>;
  reconnectMcpServer(serverName: string): Promise<void>;
}

const CONTROL_METHODS: ReadonlyArray<keyof McpOAuthControl> = [
  'mcpServerStatus',
  'mcpAuthenticate',
  'mcpSubmitOAuthCallbackUrl',
  'mcpClearAuth',
  'reconnectMcpServer',
];

/** Narrow an SDK query to the control requests, failing with a clear message if the SDK dropped one. */
export function asMcpOAuthControl(query: object): McpOAuthControl {
  const methods = query as Record<string, unknown>;
  const missing = CONTROL_METHODS.filter((method) => typeof methods[method] !== 'function');
  if (missing.length > 0) {
    throw new Error(`This Agent SDK has no ${missing.join(', ')}; in-chat MCP sign-in is unavailable.`);
  }
  return query as unknown as McpOAuthControl;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(message: string): void {
  console.error(`[mcp-auth] ${message}`);
}

function describeStatus(status: McpServerStatus | undefined): string {
  if (!status) return 'not reported by Claude Code';
  const tools = status.tools?.length;
  return [
    status.status,
    tools === undefined ? undefined : `${tools} tools`,
    status.error ? `error: ${status.error}` : undefined,
  ]
    .filter(Boolean)
    .join(', ');
}

/** A redirect address worth submitting: the provider put the code and the state on it. */
function checkRedirectUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return 'That is not a URL. Ask the user for the full address from the browser address bar.';
  }
  if (url.searchParams.has('error')) {
    return `The provider refused the sign-in: ${url.searchParams.get('error_description') ?? url.searchParams.get('error')}.`;
  }
  if (!url.searchParams.has('code') || !url.searchParams.has('state')) {
    return 'The address has no authorization code. Ask the user for the full address of the page the browser opened after they approved access.';
  }
  return undefined;
}

/**
 * Build the in-process server. `servers` are the group's remote MCP server
 * names (the only ones that sign in through Claude Code); `control` resolves
 * the running query's control requests when a tool is called.
 */
export function createMcpAuthServer(servers: readonly string[], control: () => McpOAuthControl) {
  const serverList = servers.join(', ');
  const serverArg = z.string().describe(`Remote MCP server name, as configured: ${serverList}`);
  const unknownServer = (name: string): ToolResult =>
    fail(`"${name}" is not a remote MCP server of this group. Remote servers: ${serverList}.`);

  async function statusOf(name: string): Promise<McpServerStatus | undefined> {
    return (await control().mcpServerStatus()).find((entry) => entry.name === name);
  }

  const { createSdkMcpServer, tool } = agentSdk;
  return createSdkMcpServer({
    name: MCP_AUTH_SERVER_NAME,
    version: '1.0.0',
    tools: [
      tool(
        'status',
        "Connection status of this group's remote MCP servers: connected, needs-auth (sign-in required), failed, pending or disabled.",
        {},
        async () => {
          try {
            const statuses = await control().mcpServerStatus();
            const lines = servers.map(
              (name) => `${name}: ${describeStatus(statuses.find((entry) => entry.name === name))}`,
            );
            return ok(lines.join('\n'));
          } catch (error) {
            return fail(errorMessage(error));
          }
        },
      ),
      tool(
        'start_sign_in',
        "Start signing in to a remote MCP server's own account (OAuth). Returns the link the user must open.",
        { server: serverArg },
        async ({ server }) => {
          if (!servers.includes(server)) return unknownServer(server);
          try {
            const result = await control().mcpAuthenticate(server);
            if (!result.authUrl) {
              log(`start_sign_in ${server}: no link issued`);
              return ok(
                `No sign-in link was issued for ${server} (${JSON.stringify(result)}). Check mcp_auth status before asking the user to do anything.`,
              );
            }
            log(`start_sign_in ${server}: link issued`);
            return ok(
              [
                `Sign-in link for ${server}:`,
                result.authUrl,
                '',
                'Send the link to the user unchanged. After they approve access, the browser opens an address on localhost that does not load. That is expected: ask them to copy the full address from the address bar and send it to you, then call finish_sign_in with it. The link works only while this conversation stays active; if it fails later, start again.',
              ].join('\n'),
            );
          } catch (error) {
            log(`start_sign_in ${server}: ${errorMessage(error)}`);
            return fail(errorMessage(error));
          }
        },
      ),
      tool(
        'finish_sign_in',
        'Finish a sign-in started with start_sign_in, using the full address the user copied from the browser after approving access.',
        {
          server: serverArg,
          redirect_url: z.string().describe('The full address from the browser address bar, exactly as the user sent it'),
        },
        async ({ server, redirect_url }) => {
          if (!servers.includes(server)) return unknownServer(server);
          const problem = checkRedirectUrl(redirect_url);
          if (problem) return fail(problem);
          try {
            await control().mcpSubmitOAuthCallbackUrl(server, redirect_url.trim());
            let status = await statusOf(server);
            if (status?.status !== 'connected') {
              await control().reconnectMcpServer(server);
              status = await statusOf(server);
            }
            log(`finish_sign_in ${server}: ${status?.status ?? 'unknown'}`);
            return ok(
              `Sign-in for ${server} accepted; server status: ${describeStatus(status)}. Before telling the user the account is connected, make one call to a ${server} tool that needs the account and check that it succeeds.`,
            );
          } catch (error) {
            log(`finish_sign_in ${server}: ${errorMessage(error)}`);
            return fail(errorMessage(error));
          }
        },
      ),
      tool(
        'sign_out',
        "Forget the stored sign-in for a remote MCP server, e.g. to switch to another account. The next sign-in starts from scratch.",
        { server: serverArg },
        async ({ server }) => {
          if (!servers.includes(server)) return unknownServer(server);
          try {
            await control().mcpClearAuth(server);
            log(`sign_out ${server}`);
            return ok(`Signed out of ${server}; status: ${describeStatus(await statusOf(server))}.`);
          } catch (error) {
            log(`sign_out ${server}: ${errorMessage(error)}`);
            return fail(errorMessage(error));
          }
        },
      ),
    ],
  });
}
