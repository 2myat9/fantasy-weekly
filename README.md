# Fantasy Weekly

An agent that sends a weekly fantasy football digest on Telegram. It runs on Cloudflare, reads rosters from [Sleeper](https://sleeper.com), gathers the week's news about those players from free public sources, and sends one message per league every Saturday at 6:00 PM Pacific: a check of the lineup currently set, followed by the news that affects it.

The full specification is in [issue #1](https://github.com/2myat9/fantasy-weekly/issues/1).

## Status

The digest goes out on its own every Saturday at 6:00 PM Pacific, one message per Sleeper league, and `/preview` sends the same messages on demand, marked as previews. So far each message holds the lineup check: a starter on bye, ruled out or on IR, or an empty starting slot. The rest of the digest is built ticket by ticket on top of this.

- Each run schedules the next one as an instant computed in `America/Los_Angeles`, so the send time holds across both daylight-saving changes. The schedule is armed the first time anything reaches the agent, which after a deploy means the first message sent to the bot.
- The automatic digest is recorded per season, week and league, and a run sends nothing to a league already recorded for its week.
- A league gets nothing when the NFL is outside its regular season and postseason, when the league is complete, or when my team is eliminated from its playoffs. A team left with only a placement game, such as the one for third place, counts as eliminated.
- `/preview` works on any day, ignores those rules, and touches neither the record nor the schedule. It is the fallback if a Saturday digest fails to arrive.

## How it is built

- One [Agents SDK](https://developers.cloudflare.com/agents/) agent, `FantasyWeeklyAgent`, backed by a single SQLite Durable Object. It owns scheduling, state and history.
- The Worker is named `fantasy-weekly`. Its HTTP surface is the Telegram webhook, `POST /telegram/webhook`, and nothing else.
- The webhook accepts a request only if it carries the webhook secret, and acts on an update only if it comes from the configured chat. It acknowledges Telegram straight away and the agent sends the reply afterwards.
- `/preview` is the only command. Any other message from the configured chat gets a one-line hint.
- There is no web interface.
- A run is taken in steps, each its own invocation of the agent, because Cloudflare's free plan allows one invocation 50 outbound requests: the shared sources first, then each player's own page at ESPN in batches, then one league message per step. What a run has gathered is kept in the agent's storage in between. The automatic digest and `/preview` go through the same steps.

```
src/
  server.ts          # The agent and the Worker entry point (the webhook)
  digest-time.ts     # When the automatic digest runs: the next Saturday 6:00 PM Pacific
  runs.ts            # The runs in progress and what each has gathered so far
  sent-record.ts     # Which leagues the automatic digest has gone out to, per NFL week
  sleeper.ts         # Sleeper client: NFL week, leagues, rosters, this week's opponents, playoff bracket, player directory
  player-directory.ts # The stored copy of the Sleeper player directory
  espn.ts            # ESPN client: the week's byes and kickoffs, injury reports, league news, a player's overview
  pft.ts             # ProFootballTalk client: the latest entries of its feed
  news.ts            # News gathering: source items about players, from all the news sources
  writer.ts          # The writer: the Claude call that writes the news sections
  writer-material.ts # Which source items the writer is handed for a league
  lineup-check.ts    # The lineup check
  league-message.ts  # Digest composer: the message for one league
  telegram.ts        # Telegram client: sends messages, verifies webhook requests
test/
  harness.ts         # The test seam: faked outbound HTTP, a controlled clock, scheduled-run trigger, Telegram update delivery
  fixtures/          # Saved copies of real responses
  sources.ts         # The saved responses a run reads, keyed by URL
  digest.test.ts
  news.test.ts
  news-sources.test.ts
  preview.test.ts
  telegram.test.ts
```

## Setup

These steps are done once, by hand. They need a Cloudflare account and a Telegram account.

### 1. Create the bot

1. In Telegram, open a chat with [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Give it a name and a username when asked. BotFather replies with the bot token, which looks like `1234567890:AA...`. Keep it private: anyone who has it controls the bot.
3. Optionally send `/setcommands` to BotFather, pick the bot, and send `preview - Send the digest as it would be written now` so the command appears in the bot's menu.

### 2. Find your chat ID

Do this before registering the webhook. Telegram does not serve `getUpdates` while a webhook is set.

1. Open a chat with your new bot and send it any message.
2. Fetch the bot's pending updates:

   ```bash
   curl "https://api.telegram.org/bot<BOT_TOKEN>/getUpdates"
   ```

3. Your chat ID is the number at `result[0].message.chat.id`.

### 3. Choose a webhook secret

Any random string of 1 to 256 characters from `A-Z`, `a-z`, `0-9`, `_` and `-`:

```bash
openssl rand -hex 32
```

### 4. Set the secrets

The configuration is five values, all held as Worker secrets:

| Name                      | Value                   |
| ------------------------- | ----------------------- |
| `ANTHROPIC_API_KEY`       | An Anthropic API key    |
| `SLEEPER_USERNAME`        | Your Sleeper username   |
| `TELEGRAM_BOT_TOKEN`      | The token from step 1   |
| `TELEGRAM_CHAT_ID`        | The chat ID from step 2 |
| `TELEGRAM_WEBHOOK_SECRET` | The secret from step 3  |

Set each one on the deployed Worker. Wrangler prompts for the value, so it does not end up in your shell history:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put SLEEPER_USERNAME
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

For local development, mirror them in `.dev.vars`, which is ignored by git:

```bash
cp .dev.vars.example .dev.vars   # then fill in the values
```

### 5. Deploy and register the webhook

1. Deploy. The output includes the Worker's URL, `https://fantasy-weekly.<your-subdomain>.workers.dev`.

   ```bash
   npm run deploy
   ```

2. Tell Telegram where to deliver updates and which secret to send with them:

   ```bash
   curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
     --data-urlencode "url=https://fantasy-weekly.<your-subdomain>.workers.dev/telegram/webhook" \
     --data-urlencode "secret_token=<WEBHOOK_SECRET>" \
     --data-urlencode 'allowed_updates=["message"]'
   ```

3. Send `/preview` to the bot. It replies with one message per league, each marked as a preview. This first message also arms the Saturday schedule: nothing is scheduled until something has reached the agent. If it does not, `curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"` shows the last delivery error, and `npx wrangler tail` shows the Worker's logs.

The webhook only needs registering again if the Worker's URL or the webhook secret changes.

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
- `triggerScheduledRun(instant)`: runs the agent's scheduled digest run at a chosen instant.
- `pendingSchedule()`: what is on the agent's schedule, to assert on the next scheduled time.
- `deliverTelegramUpdate(update)`: delivers an update to the webhook as Telegram does and waits for the reply work to finish. `textMessage(text, chatId)` builds the update.

The fake collects the messages sent to Telegram in `telegramMessages`. Tests get stand-in secrets from `vitest.config.ts`, never from `.dev.vars`.

## Deploy

```bash
npm run deploy
```

Deployment is manual. Nothing is deployed on push.

## License

MIT
