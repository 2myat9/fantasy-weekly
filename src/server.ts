import { Agent } from "agents";
import { hasWebhookSecret, sendMessage, textFromMyChat } from "./telegram";

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
    const response = await fetch("https://api.sleeper.app/v1/state/nfl");
    if (!response.ok) {
      throw new Error(`Sleeper NFL state returned ${response.status}`);
    }
    const nfl = await response.json<{
      season: string;
      season_type: string;
      week: number;
    }>();
    this.setState({
      lastRun: {
        at: new Date().toISOString(),
        season: nfl.season,
        seasonType: nfl.season_type,
        week: nfl.week
      }
    });
  }

  lastRun() {
    return this.state.lastRun;
  }

  // Answers a message from the user's chat. `/preview` is the only command;
  // anything else gets a hint, so the bot never behaves like a chat assistant.
  async answerMessage(text: string) {
    const telegram = {
      botToken: this.env.TELEGRAM_BOT_TOKEN,
      chatId: this.env.TELEGRAM_CHAT_ID
    };
    // Telegram appends the bot's name to a command picked from its menu.
    if (!/^\/preview(@\w+)?$/.test(text.trim())) {
      await sendMessage(
        telegram,
        "Send /preview to see the digest as it would be written now."
      );
      return;
    }
    // Placeholder preview: the league messages replace this text.
    await sendMessage(
      telegram,
      "<b>Preview</b>\nThe league messages are not written yet."
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
      ctx.waitUntil(agent.answerMessage(text));
    }
    return new Response(null, { status: 200 });
  }
} satisfies ExportedHandler<Env>;
