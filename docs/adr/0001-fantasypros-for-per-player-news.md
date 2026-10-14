# Per-player news from FantasyPros' MCP server, signed in with /connect

The news on each of my players came from ESPN's per-player pages, reached by resolving the player to an ESPN ID from Sleeper or by matching their name. Those reads failed on almost every run, so per-player news now comes from FantasyPros' `injury_status` tool on its MCP server, and the ESPN lookups by name are gone. One call covers every player on my rosters, and each news item has a date and a fantasypros.com link. FantasyPros accepts only a browser OAuth sign-in, so the agent is signed in once with `/connect`, and the Worker has a callback route besides the Telegram webhook.

## Considered Options

- **Keep ESPN's per-player pages.** Rejected because they failed on most runs.
- **Sign in on a local machine and store the refresh token as a Worker secret.** This would keep the webhook as the only route, but a secret cannot be updated if FantasyPros replaces the refresh token each time it is used.

## Consequences

- When the sign-in is lost, per-player news is missing until someone sends `/connect` again. The league message says so.
- FantasyPros returns only the last 14 days of news, so a news window longer than that loses its oldest days.
- Players are matched by name, with FantasyPros' team checked against Sleeper's. A player FantasyPros resolves to another team is unmatched rather than given someone else's news.
