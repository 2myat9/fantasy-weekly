import { Agent } from "agents";
import { nextDigestTime } from "./digest-time";
import { fetchWeekSchedule } from "./espn";
import { composeLeagueMessage } from "./league-message";
import { checkLineup } from "./lineup-check";
import { gatherPlayerNews, gatherSharedNews } from "./news";
import { playersById } from "./player-directory";
import {
  endRun,
  oldestRun,
  saveRun,
  startRun,
  type Gathered,
  type Run
} from "./runs";
import { recordSent, wasSent } from "./sent-record";
import {
  fetchMyLeagues,
  fetchNflState,
  isEliminated,
  rosterSpots,
  type League,
  type RosterSpot
} from "./sleeper";
import {
  hasWebhookSecret,
  isPreviewCommand,
  sendMessage,
  textFromMyChat
} from "./telegram";
import { NO_SECTIONS, writeSections } from "./writer";
import { writerMaterial } from "./writer-material";

// The system is single-user, so there is exactly one agent instance.
export const AGENT_NAME = "fantasy-weekly";

// The parts of the NFL season, as Sleeper names them, that get a digest.
const DIGEST_SEASON_TYPES = new Set(["regular", "post"]);

// How far back news is considered.
const NEWS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// The free plan allows one invocation 50 outbound requests, and each player's
// own page at ESPN is one of them. Read from Cloudflare's Workers limits page
// on 2026-10-13.
const LOOKUPS_PER_STEP = 25;

// How many times the automatic digest takes a step before giving the run up.
const STEP_ATTEMPTS = 3;

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
    await this.startRun({ preview: false });
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
    await this.startRun({ preview: true });
  }

  // The automatic digest and the preview are the same run, taken through the
  // same steps, so a preview shows what the digest would say at that moment.
  private async startRun({ preview }: { preview: boolean }) {
    startRun(this.ctx.storage, {
      preview,
      windowStart: new Date(Date.now() - NEWS_WINDOW_MS)
    });
    await this.scheduleStep({ fromStep: false });
  }

  // One task takes every step, so that two steps never share an invocation
  // and its allowance of outbound requests. A step schedules the next one
  // itself: its own task is still on the schedule while it runs, and would be
  // taken for the next one if tasks were matched up.
  private async scheduleStep({ fromStep }: { fromStep: boolean }) {
    await this.schedule(0, "runStep", undefined, {
      idempotent: !fromStep,
      // The scheduler retries within the invocation, which would spend the
      // allowance twice. A failed step is taken again in a later one.
      retry: { maxAttempts: 1 }
    });
  }

  // Takes one step of the oldest run in progress.
  async runStep() {
    const run = oldestRun(this.ctx.storage);
    try {
      if (run) await this.takeStep(run);
    } catch (error) {
      console.error("A step of the run failed", error);
      if (run) await this.stepFailed(run);
    } finally {
      if (oldestRun(this.ctx.storage)) {
        await this.scheduleStep({ fromStep: true });
      }
    }
  }

  // A preview that fails is reported, not retried, so a failure cannot send
  // it twice. The automatic digest has nobody waiting to ask again, so its
  // step is taken again.
  private async stepFailed(run: Run) {
    if (run.preview) {
      endRun(this.ctx.storage, run);
      await sendMessage(
        this.telegram,
        "The preview failed. Send /preview to try again."
      );
    } else if (run.failures + 1 < STEP_ATTEMPTS) {
      saveRun(this.ctx.storage, { ...run, failures: run.failures + 1 });
    } else {
      endRun(this.ctx.storage, run);
    }
  }

  // A run gathers the shared sources, then the per-player sources a batch at
  // a time, then writes and sends one league message per step. What a step
  // produced is stored only once it has succeeded, so a step that is taken
  // again starts from the same place.
  private async takeStep(run: Run) {
    const { gathered } = run;
    if (!gathered) {
      const shared = await this.gatherShared(run);
      if (shared) this.stepTaken(run, shared);
      else endRun(this.ctx.storage, run);
      return;
    }
    if (gathered.news.lookups.length > 0) {
      const news = await gatherPlayerNews(
        gathered.news,
        run.windowStart,
        LOOKUPS_PER_STEP
      );
      this.stepTaken(run, { ...gathered, news });
      return;
    }
    const [league, ...rest] = gathered.leagues;
    // Checked again here, in case the week's message went out while this run
    // was gathering.
    if (run.preview || !wasSent(this.ctx.storage, gathered.nfl, league.id)) {
      await sendMessage(
        this.telegram,
        await this.leagueMessage(league, gathered, run.preview)
      );
      // Recorded league by league, so a run that fails part-way does not send
      // the leagues it reached again when it is retried.
      if (!run.preview) recordSent(this.ctx.storage, gathered.nfl, league.id);
    }
    if (rest.length > 0) this.stepTaken(run, { ...gathered, leagues: rest });
    else endRun(this.ctx.storage, run);
  }

  private stepTaken(run: Run, gathered: Gathered) {
    saveRun(this.ctx.storage, { ...run, failures: 0, gathered });
  }

  // The first step: what Sleeper and ESPN report now, and the news from the
  // sources shared by all players. Nothing when no league is due a message.
  private async gatherShared(run: Run): Promise<Gathered | null> {
    const nfl = await fetchNflState();
    if (!run.preview && !DIGEST_SEASON_TYPES.has(nfl.seasonType)) return null;
    const mine = await fetchMyLeagues(this.env.SLEEPER_USERNAME, nfl);
    const leagues = [];
    for (const league of mine) {
      if (!run.preview) {
        if (league.status === "complete") continue;
        if (wasSent(this.ctx.storage, nfl, league.id)) continue;
        if (await isEliminated(league, nfl)) continue;
      }
      leagues.push(league);
    }
    if (leagues.length === 0) return null;
    const ids = (spots: RosterSpot[]) => spots.map(({ playerId }) => playerId);
    const myPlayers = leagues.flatMap((league) => ids(rosterSpots(league)));
    const [schedule, players] = await Promise.all([
      fetchWeekSchedule(nfl),
      playersById(this.ctx.storage, [
        ...myPlayers,
        ...leagues.flatMap((league) => ids(league.opponent))
      ])
    ]);
    const news = await gatherSharedNews({
      players: [...players.values()],
      ownPages: new Set(myPlayers),
      schedule,
      windowStart: run.windowStart
    });
    return { nfl, leagues, schedule, players, news };
  }

  // The message for one league, built from what was gathered and what the
  // writer makes of the news.
  private async leagueMessage(
    league: League,
    { nfl, schedule, players, news }: Gathered,
    preview: boolean
  ) {
    const roster = rosterSpots(league);
    const { items, kickedOff } = writerMaterial({
      league,
      roster,
      players,
      schedule,
      items: news.items,
      now: new Date()
    });
    // The writer works only from source items, so with none it has nothing
    // to write.
    const sections =
      items.length > 0
        ? await writeSections(this.env.ANTHROPIC_API_KEY, {
            league,
            week: nfl.week,
            roster,
            kickedOff,
            opponent: league.opponent,
            players,
            items
          })
        : NO_SECTIONS;
    return composeLeagueMessage({
      league,
      week: nfl.week,
      findings: checkLineup(league.lineup, players, schedule),
      roster,
      players,
      sections,
      unmatched: news.unmatched,
      preview
    });
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
