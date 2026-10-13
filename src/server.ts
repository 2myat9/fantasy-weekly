import { Agent } from "agents";
import { nextDigestTime } from "./digest-time";
import { fetchWeekSchedule } from "./espn";
import { composeLeagueMessage } from "./league-message";
import { checkLineup } from "./lineup-check";
import { playersById } from "./player-directory";
import { recordSent, wasSent } from "./sent-record";
import {
  fetchMyLeagues,
  fetchNflState,
  isEliminated,
  type League,
  type NflState
} from "./sleeper";
import {
  hasWebhookSecret,
  isPreviewCommand,
  sendMessage,
  textFromMyChat
} from "./telegram";

// The system is single-user, so there is exactly one agent instance.
export const AGENT_NAME = "fantasy-weekly";

// The parts of the NFL season, as Sleeper names them, that get a digest.
const DIGEST_SEASON_TYPES = new Set(["regular", "post"]);

export class FantasyWeeklyAgent extends Agent<Env> {
  // Puts the next digest run on the schedule unless it is already there.
  // Everything that reaches the agent calls this, so the schedule is armed
  // the first time the agent is used and put back if it has gone missing. The
  // SDK's `onStart` would not do: it does not run for the webhook's calls.
  private async armDigest() {
    const next = nextDigestTime(new Date());
    const pending = await this.listSchedules({ type: "scheduled" });
    const armed = pending.some(
      (task) =>
        task.callback === "runDigest" && task.time * 1000 === next.getTime()
    );
    if (!armed) {
      // The check above already keeps the run from being scheduled twice.
      await this.schedule(next, "runDigest", undefined, { idempotent: false });
    }
  }

  // The automatic digest: one league message per league that is due one.
  async runDigest() {
    // Armed before anything can fail, so a failed run still leaves next
    // week's on the schedule.
    await this.armDigest();
    const nfl = await fetchNflState();
    if (!DIGEST_SEASON_TYPES.has(nfl.seasonType)) return;
    const leagues = await fetchMyLeagues(this.env.SLEEPER_USERNAME, nfl.season);
    const due = [];
    for (const league of leagues) {
      if (league.status === "complete") continue;
      if (wasSent(this.ctx.storage, nfl, league.id)) continue;
      if (await isEliminated(league, nfl)) continue;
      due.push(league);
    }
    const messages = await this.leagueMessages(nfl, due, { preview: false });
    for (const { league, message } of messages) {
      await sendMessage(this.telegram, message);
      // Recorded league by league, so a run that fails part-way does not send
      // the leagues it reached again when it is retried.
      recordSent(this.ctx.storage, nfl, league.id);
    }
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
    await this.armDigest();
    await sendMessage(
      this.telegram,
      "Send /preview to see the digest as it would be written now."
    );
  }

  // Only records that a preview was requested, so the webhook can answer
  // Telegram at once. The run happens from the agent's alarm, which is not
  // tied to the webhook request and its 30 seconds of background work.
  async requestPreview() {
    await this.armDigest();
    // A preview that fails is reported, not retried, so a failure cannot send
    // it twice. The scheduler still runs the task again if the agent is reset
    // mid-run, so that a preview is never lost silently.
    await this.schedule(0, "runPreview", undefined, {
      retry: { maxAttempts: 1 }
    });
  }

  async runPreview() {
    try {
      const nfl = await fetchNflState();
      const leagues = await fetchMyLeagues(
        this.env.SLEEPER_USERNAME,
        nfl.season
      );
      const messages = await this.leagueMessages(nfl, leagues, {
        preview: true
      });
      for (const { message } of messages) {
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

  // One message per given league, built from what Sleeper and ESPN report
  // now. The automatic digest and the preview share it.
  private async leagueMessages(
    nfl: NflState,
    leagues: League[],
    { preview }: { preview: boolean }
  ) {
    if (leagues.length === 0) return [];
    const [schedule, players] = await Promise.all([
      fetchWeekSchedule(nfl),
      playersById(
        this.ctx.storage,
        leagues.flatMap((league) =>
          league.lineup.flatMap(({ playerId }) => playerId ?? [])
        )
      )
    ]);
    return leagues.map((league) => ({
      league,
      message: composeLeagueMessage({
        league,
        week: nfl.week,
        findings: checkLineup(league.lineup, players, schedule),
        preview
      })
    }));
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
