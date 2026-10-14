# A small MCP client of our own for FantasyPros, not the Agents SDK's

The agent reaches FantasyPros' MCP server with its own client in `src/fantasypros.ts`: OAuth with PKCE and a client ID metadata document (dynamic client registration at first; see [ADR 0003](0003-client-id-metadata-document-for-fantasypros.md)), the tokens in the agent's Durable Object storage, and one Streamable HTTP session per tool call. The Agents SDK's MCP client (`addMcpServer`, `this.mcp.configureOAuthCallback`) was preferred, and was checked against `agents` 0.17.4 before deciding.

## Considered Options

- **The Agents SDK's MCP client.** Rejected for two reasons. When the agent wakes, the SDK reconnects and re-discovers every stored server in the background (`restoreConnectionsFromStorage`, with up to three attempts). Those requests come out of whichever invocation woke the agent, a webhook hint or a step of a run, and the free plan allows one invocation 50 outbound requests. Also, when a refresh is refused, the SDK starts a new authorization, and nobody is present at a scheduled run to complete it. The agent needs to record the sign-in as lost and say so.

## Consequences

- A request to FantasyPros is made only when a tool is called: three requests (initialize, the initialized notification, the call), four when the access token has expired, and up to seven when FantasyPros refuses a token that has not (the session is set up again after the refresh).
- The client covers only what the agent uses: tool calls, with results sent as JSON or as an event stream. It keeps no session between calls, and it does not handle resources, prompts or server-sent requests.
- The authorization server is found from `/.well-known/oauth-protected-resource/mcp` rather than from the `WWW-Authenticate` header of a refused request, which saves a request. Both name `https://secure.fantasypros.com`.
