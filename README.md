# Fantasy Weekly

An agent that sends a weekly fantasy football digest on Telegram. It runs on Cloudflare, reads rosters from [Sleeper](https://sleeper.com), gathers the week's news about those players from free public sources, and sends one message per league every Saturday at 6:00 PM Pacific: a check of the lineup currently set, followed by the news that affects it.

The full specification is in [issue #1](https://github.com/2myat9/fantasy-weekly/issues/1).

## Status

The project is a bare agent with a test harness. The digest itself is built ticket by ticket on top of it. Nothing is scheduled yet and the Worker serves no HTTP routes. The agent's scheduled run is a placeholder that records which NFL week Sleeper reports, and only the tests trigger it.

## How it is built

- One [Agents SDK](https://developers.cloudflare.com/agents/) agent, `FantasyWeeklyAgent`, backed by a single SQLite Durable Object. It owns scheduling, state and history.
- The Worker is named `fantasy-weekly`. Its HTTP surface is empty until the Telegram webhook is added.
- There is no web interface.

```
src/
  server.ts          # The agent and the Worker entry point
test/
  harness.ts         # The test seam: faked outbound HTTP, a controlled clock, scheduled-run trigger
  fixtures/          # Saved copies of real responses
  smoke.test.ts
```

## Development

```bash
npm install
npm run dev      # Run the Worker locally
npm test         # Run the tests
npm run check    # Format check, lint and typecheck
npm run types    # Regenerate env.d.ts after changing bindings in wrangler.jsonc
```

## Testing

Tests run with Vitest inside Cloudflare's Workers runtime through [`@cloudflare/vitest-plugin`](https://developers.cloudflare.com/workers/testing/vitest-integration/), so the agent's real Durable Object storage and scheduling are exercised.

There is one test seam, the agent's outside edge. A test fakes what the agent reaches out to, triggers it the way the outside world does, and asserts only on what leaves it. `test/harness.ts` provides:

- `fakeOutboundHttp(savedResponses)`: answers outbound HTTP from saved responses and records the requests made. A request with no saved response fails instead of reaching the network.
- `setClock(instant)`: sets the time the agent reads.
- `triggerScheduledRun(instant)`: runs the agent's scheduled run at a chosen instant.

## Deploy

```bash
npm run deploy
```

Deployment is manual. Nothing is deployed on push.

## License

MIT
