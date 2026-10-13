import { Agent } from "agents";
import { fetchWeekSchedule } from "./espn";
import { composeLeagueMessage } from "./league-message";
import { checkLineup } from "./lineup-check";
import { playersById } from "./player-directory";
import { fetchMyLeagues, fetchNflState } from "./sleeper";
import {
  hasWebhookSecret,
  isPreviewCommand,
  sendMessage,
  textFromMyChat
} from "./telegram";

// The system is single-user, so there is exactly one agent instance.
export const AGENT_NAME = "fantasy-weekly";

export type RunRecord = {
  at: string;
  season: string;
  seasonType: string;
  week: number;
};

type State = { lastRun: RunRecord | null };

export class FantasyWeeklyAgent extends Agent<Env, State> {
  initialState: State = { lastRun: null };

  // Placeholder run: it only records which NFL week Sleeper reports. The
  // digest pipeline replaces it.
  async scheduledRun() {
    const nfl = await fetchNflState();
    this.setState({
      lastRun: {
        at: new Date().toISOString(),
        season: nfl.season,
        seasonType: nfl.seasonType,
        week: nfl.week
      }
    });
  }

  lastRun() {
    return this.state.lastRun;
  }

  private get telegram() {
    return {
      botToken: this.env.TELEGRAM_BOT_TOKEN,
      chatId: this.env.TELEGRAM_CHAT_ID
    };
  }

  // Any text other than `/preview` gets a hint, so the bot never behaves like
  // a chat assistant.
  async sendHint() {
    await sendMessage(
      this.telegram,
      "Send /preview to see the digest as it would be written now."
    );
  }

  // Only records that a preview was requested, so the webhook can answer
  // Telegram at once. The run happens from the agent's alarm, which is not
  // tied to the webhook request and its 30 seconds of background work.
  async requestPreview() {
    // A preview that fails is reported, not retried, so a failure cannot send
    // it twice. The scheduler still runs the task again if the agent is reset
    // mid-run, so that a preview is never lost silently.
    await this.schedule(0, "runPreview", undefined, {
      retry: { maxAttempts: 1 }
    });
  }

  async runPreview() {
    try {
      const messages = await this.leagueMessages({ preview: true });
      for (const message of messages) {
        await sendMessage(this.telegram, message);
      }
    } catch (error) {
      console.error("The preview run failed", error);
      await sendMessage(
        this.telegram,
        "The preview failed. Send /preview to try again."
      );
    }
  }

  // One message per league, built from what Sleeper and ESPN report now.
  private async leagueMessages({ preview }: { preview: boolean }) {
    const nfl = await fetchNflState();
    const [leagues, schedule] = await Promise.all([
      fetchMyLeagues(this.env.SLEEPER_USERNAME, nfl.season),
      fetchWeekSchedule(nfl)
    ]);
    const players = await playersById(
      this.ctx.storage,
      leagues.flatMap((league) =>
        league.lineup.flatMap(({ playerId }) => playerId ?? [])
      )
    );
    return leagues.map((league) =>
      composeLeagueMessage({
        league,
        week: nfl.week,
        findings: checkLineup(league.lineup, players, schedule),
        preview
      })
    );
  }
}

export default {
  // The HTTP surface is the Telegram webhook and nothing else.
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST" || pathname !== "/telegram/webhook") {
      return new Response("Not found", { status: 404 });
    }
    if (!hasWebhookSecret(request, env.TELEGRAM_WEBHOOK_SECRET ?? "")) {
      return new Response("Forbidden", { status: 403 });
    }
    // A body that is not JSON is dropped like any other update we ignore.
    const update = await request.json().catch(() => null);
    const text = textFromMyChat(update, env.TELEGRAM_CHAT_ID);
    // Updates from any other chat are dropped, and acknowledged so Telegram
    // does not redeliver them.
    if (text !== null) {
      const agent = env.FantasyWeeklyAgent.getByName(AGENT_NAME);
      if (isPreviewCommand(text)) {
        // Awaited, so a request that was not recorded is not acknowledged and
        // Telegram delivers it again.
        await agent.requestPreview();
      } else {
        ctx.waitUntil(agent.sendHint());
      }
    }
    return new Response(null, { status: 200 });
  }
} satisfies ExportedHandler<Env>;
