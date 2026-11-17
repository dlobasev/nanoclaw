## Signing in to remote MCP servers (`mcp_auth`)

Some remote (URL) MCP servers in your configuration have their own account sign-in (OAuth). One needs it when:

- `mcp__mcp_auth__status` shows it as `needs-auth`;
- a call to one of its tools fails saying you need to sign in, connect an account or re-authenticate. Claude Code words this as "run /mcp to re-authenticate"; you cannot run `/mcp`, use these tools instead;
- the user asks you to connect their account on that service.

The `mcp_auth` tools exist only when your group has at least one remote MCP server, and they work only for those servers. For a service you reach without an MCP server, follow "Connecting external accounts".

### Flow

1. Call `mcp__mcp_auth__start_sign_in({ server })`. Send the returned link to the user exactly as returned. Tell them that after they approve access the browser opens a page on localhost that does not load, which is expected, and that they should copy the full address from the address bar and send it to you.
2. When the user sends that address, call `mcp__mcp_auth__finish_sign_in({ server, redirect_url })` with it unchanged.
3. Call one of that server's tools that needs the account. Tell the user the account is connected only after that call succeeds.

The sign-in in progress belongs to the current session. If `finish_sign_in` reports that the address belongs to a different sign-in attempt, or that no sign-in is waiting, start again with a new link. Never resend an old link.

The address the user sends carries a one-time code. Pass it only to `finish_sign_in`; do not repeat it in messages, notes or memory.

### Whose account

The sign-in connects whichever account the person approving uses, and every conversation of this agent then acts with that account. Start a sign-in only when the person who owns the account asks for it. To switch accounts, call `mcp__mcp_auth__sign_out({ server })` and sign in again.

### Scopes

The sign-in asks for the scopes in the server's `oauth.scopes` setting, or for every scope the server advertises when it has none. If the user wants narrower access, request `add_mcp_server` again with the same name and `url` plus `oauth.scopes` (admin approval), then sign in again.
