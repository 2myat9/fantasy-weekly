import { Agent } from "agents";
import { nextDigestTime } from "./digest-time";
import { fetchWeekSchedule, NO_SCHEDULE } from "./espn";
import {
  callTool,
  CLIENT_METADATA_PATH,
  clientMetadata,
  completeSignIn,
  connection,
  fetchPlayerNews,
  SIGN_IN_CALLBACK_PATH,
  startSignIn,
  type SignInCallback
} from "./fantasypros";
import { composeFailureMessage, composeLeagueMessage } from "./league-message";
import { checkLineup } from "./lineup-check";
import { newsWindowStart, recordDigest, wasSent } from "./history";
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
import {
  fetchMyLeagues,
  fetchNflState,
  isEliminated,
  rosterSpots,
  type League,
  type RosterSpot,
  type UnreadLeague
} from "./sleeper";
import {
  commandIn,
  hasWebhookSecret,
  linkTo,
  sendMessage,
  textFromMyChat
} from "./telegram";
import { NO_SECTIONS, writeSections, type Sections } from "./writer";
import { writerMaterial } from "./writer-material";

// The system is single-user, so there is exactly one agent instance.
export const AGENT_NAME = "fantasy-weekly";

// The parts of the NFL season, as Sleeper names them, that get a digest.
const DIGEST_SEASON_TYPES = new Set(["regular", "post"]);

// How many times the automatic digest takes a step before giving the run up.
const STEP_ATTEMPTS = 3;

// Whether a run still has FantasyPros' news to read. A run stored before
// FantasyPros was read has no players to look up, and goes on without it.
function lookingUp({ news }: Gathered) {
  return (news.toLookUp?.length ?? 0) > 0;
}

// Where the news is gathered from: the start of the widest league window.
function earliestWindow(windows: Map<string, Date>) {
  return new Date(
    Math.min(...[...windows.values()].map((start) => start.getTime()))
  );
}

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

  // Any text other than a command gets a hint, so the bot never behaves like
  // a chat assistant.
  async sendHint() {
    await this.armDigest();
    await sendMessage(
      this.telegram,
      "Send /preview to see the digest as it would be written now, or /connect to sign in to FantasyPros."
    );
  }

  // Replies with a link to sign in to FantasyPros. `origin` is the Worker's
  // own, where FantasyPros reads the client metadata document and sends the
  // browser back to.
  async requestSignIn(origin: string) {
    await this.armDigest();
    let reply;
    try {
      const link = await startSignIn(this.ctx.storage, origin);
      reply = `Sign in to FantasyPros to connect it: ${linkTo(link, "sign in")}`;
    } catch (error) {
      console.error("The sign-in to FantasyPros could not be started", error);
      reply =
        "The sign-in to FantasyPros could not be started. Send /connect to try again.";
    }
    await sendMessage(this.telegram, reply);
  }

  // Completes the sign-in from the address FantasyPros sent the browser back
  // to, and tells the chat how it went. A callback for no sign-in the agent
  // started sends nothing, so the route cannot be used to message the chat.
  async completeSignIn(callback: SignInCallback) {
    const outcome = await completeSignIn(this.ctx.storage, callback);
    if (outcome !== "unknown") {
      await sendMessage(
        this.telegram,
        outcome === "connected"
          ? "FantasyPros is connected."
          : "The sign-in to FantasyPros failed. Send /connect to try again."
      ).catch((error) => {
        // The page the browser is shown says the same.
        console.error("The sign-in's outcome could not be sent", error);
      });
    }
    return outcome;
  }

  // Calls one of FantasyPros' tools as the user, with nobody there: the
  // sign-in is renewed when it has to be, and the outcome says when it is
  // lost, for the caller to tell the chat.
  async callFantasyPros(tool: string, args: unknown) {
    return callTool(this.ctx.storage, tool, args);
  }

  fantasyProsConnection() {
    return connection(this.ctx.storage);
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
    startRun(this.ctx.storage, { preview });
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
      // A run that ended before the failure, which sending its last message
      // can be, is over: there is no step of it left to fail.
      // The run is read again, for what the step stored before it failed.
      const failed = oldestRun(this.ctx.storage);
      if (run && failed?.id === run.id) {
        try {
          await this.stepFailed(failed);
        } catch (error) {
          // A run that cannot even be failed must not be taken up for ever,
          // ahead of every run after it.
          console.error("The failed step could not be handled", error);
          endRun(this.ctx.storage, run);
        }
      }
    } finally {
      if (oldestRun(this.ctx.storage)) {
        await this.scheduleStep({ fromStep: true });
      }
    }
  }

  // A preview's step that fails is not taken again, so a failure cannot send
  // a message twice. The automatic digest has nobody waiting to ask again, so
  // its step is. A step given up is never silent: a league that failed is
  // passed over for the next and named at the end of the run, and a run that
  // failed before reaching its leagues is reported at once.
  private async stepFailed(run: Run) {
    if (!run.preview && run.failures + 1 < STEP_ATTEMPTS) {
      saveRun(this.ctx.storage, { ...run, failures: run.failures + 1 });
      return;
    }
    const { gathered } = run;
    if (gathered && !lookingUp(gathered)) {
      const [league, ...leagues] = gathered.leagues;
      const failed = [...gathered.failed, league.name];
      await this.leagueDone(run, { ...gathered, leagues, failed });
    } else {
      await this.finishRun(run, []);
    }
  }

  // Ends a run, with one short message when it failed for the given leagues,
  // or altogether. The run is ended first, so that the message failing to
  // send does not leave it to be taken up again.
  private async finishRun(run: Run, failed: string[] | null) {
    endRun(this.ctx.storage, run);
    if (failed) {
      await sendMessage(
        this.telegram,
        composeFailureMessage({ leagues: failed, preview: run.preview })
      );
    }
  }

  // Moves a run on from the league it was at: to the next one, or to its end.
  private async leagueDone(run: Run, gathered: Gathered) {
    const { leagues, failed } = gathered;
    if (leagues.length > 0) {
      this.stepTaken(run, { ...gathered, written: undefined });
    } else await this.finishRun(run, failed.length > 0 ? failed : null);
  }

  // A run gathers the shared sources, then FantasyPros' news on the user's
  // players, then writes and sends one league message per step. What a step
  // produced is stored only once it has succeeded, so a step that is taken
  // again starts from the same place.
  private async takeStep(run: Run) {
    const { gathered } = run;
    if (!gathered) {
      await this.gatherShared(run);
      return;
    }
    if (lookingUp(gathered)) {
      const news = await gatherPlayerNews(
        gathered.news,
        gathered.players,
        earliestWindow(gathered.windows),
        (names) => fetchPlayerNews(this.ctx.storage, names)
      );
      this.stepTaken(run, { ...gathered, news });
      return;
    }
    const [league, ...leagues] = gathered.leagues;
    // Checked again here, in case the week's message went out while this run
    // was gathering.
    if (run.preview || !wasSent(this.ctx.storage, gathered.nfl, league.id)) {
      let written = gathered.written ?? {
        ...(await this.leagueMessage(league, gathered, run.preview)),
        sent: 0
      };
      while (written.sent < written.parts.length) {
        await sendMessage(this.telegram, written.parts[written.sent]);
        written = { ...written, sent: written.sent + 1 };
        // Kept part by part, so a step that is taken again sends only the
        // parts that have not gone out, as they were first written.
        saveRun(this.ctx.storage, {
          ...run,
          gathered: { ...gathered, written }
        });
      }
      // Recorded league by league, so a run that fails part-way does not send
      // the leagues it reached again when it is retried.
      if (!run.preview) {
        recordDigest(this.ctx.storage, {
          nfl: gathered.nfl,
          league,
          messages: written.parts,
          items: written.items,
          newsGatheredAt: gathered.gatheredAt
        });
      }
    }
    await this.leagueDone(run, { ...gathered, leagues });
  }

  private stepTaken(run: Run, gathered: Gathered) {
    saveRun(this.ctx.storage, { ...run, failures: 0, gathered });
  }

  // The first step: what Sleeper and ESPN report now, and the news from the
  // sources shared by all players. The run ends here when no league is due a
  // message, or none of those due one could be read.
  private async gatherShared(run: Run) {
    const nfl = await fetchNflState();
    if (!run.preview && !DIGEST_SEASON_TYPES.has(nfl.seasonType)) {
      return this.finishRun(run, null);
    }
    const mine = await fetchMyLeagues(this.env.SLEEPER_USERNAME, nfl);
    const due = (league: UnreadLeague) =>
      run.preview ||
      (league.status !== "complete" &&
        !wasSent(this.ctx.storage, nfl, league.id));
    const leagues = [];
    for (const league of mine.leagues.filter(due)) {
      if (!run.preview) {
        // A bracket that cannot be read does not show the team is out, and
        // a message too many costs less than one too few.
        const eliminated = await isEliminated(league, nfl).catch((error) => {
          console.error("The playoff bracket could not be read", error);
          return false;
        });
        if (eliminated) continue;
      }
      leagues.push(league);
    }
    const failed = mine.unread.filter(due).map(({ name }) => name);
    if (leagues.length === 0) {
      return this.finishRun(run, failed.length > 0 ? failed : null);
    }
    const ids = (spots: RosterSpot[]) => spots.map(({ playerId }) => playerId);
    const myPlayers = leagues.flatMap((league) => ids(rosterSpots(league)));
    // The league messages are built from Sleeper, so they can go without the
    // schedule, and on an old copy of the players, but not without players.
    const [schedule, { players, stale }] = await Promise.all([
      fetchWeekSchedule(nfl).catch((error) => {
        console.error("The schedule could not be read", error);
        return null;
      }),
      playersById(this.ctx.storage, [
        ...myPlayers,
        ...leagues.flatMap((league) => ids(league.opponent))
      ])
    ]);
    // A preview's window is the one the automatic digest would have now.
    const now = new Date();
    const windows = new Map(
      leagues.map(({ id }) => [id, newsWindowStart(this.ctx.storage, id, now)])
    );
    const news = await gatherSharedNews({
      players: [...players.values()],
      mine: new Set(myPlayers),
      schedule: schedule ?? NO_SCHEDULE,
      windowStart: earliestWindow(windows)
    });
    const missing = [];
    if (!schedule) {
      missing.push("ESPN's schedule (byes and kickoffs were not checked)");
    }
    if (stale) {
      missing.push(
        "a fresh copy of Sleeper's players (injury statuses may be out of date)"
      );
    }
    this.stepTaken(run, {
      nfl,
      leagues,
      failed,
      schedule,
      players,
      windows,
      gatheredAt: now,
      news,
      missing
    });
  }

  // The message for one league, built from what was gathered and what the
  // writer makes of the news. What could not be gathered or written is left
  // out and named in the message, which is then a reduced one.
  private async leagueMessage(
    league: League,
    gathered: Gathered,
    preview: boolean
  ) {
    const { nfl, players, news } = gathered;
    const schedule = gathered.schedule ?? NO_SCHEDULE;
    const roster = rosterSpots(league);
    const missing = [...gathered.missing, ...news.missing];
    // The news was gathered for the league with the widest window.
    const windowStart = gathered.windows.get(league.id)!;
    const { items, kickedOff } = writerMaterial({
      league,
      roster,
      players,
      schedule,
      items: news.items.filter(({ date }) => date >= windowStart),
      now: new Date()
    });
    // The writer works only from source items, so with none it has nothing
    // to write. With none because something could not be read, nobody was
    // looked at, and that is not the same as their having no news.
    let sections: Sections | null = missing.length > 0 ? null : NO_SECTIONS;
    if (items.length > 0) {
      try {
        sections = await writeSections(this.env.ANTHROPIC_API_KEY, {
          league,
          week: nfl.week,
          roster,
          kickedOff,
          opponent: league.opponent,
          players,
          items
        });
      } catch (error) {
        console.error("The writer failed", error);
        sections = null;
        missing.push("the written news sections (the model call failed)");
      }
    }
    const parts = composeLeagueMessage({
      league,
      week: nfl.week,
      findings: checkLineup(league.lineup, players, schedule),
      roster,
      players,
      sections,
      unmatched: news.unmatched,
      missing,
      byesChecked: gathered.schedule !== null,
      preview
    });
    return { parts, items };
  }
}

// The page the browser is shown once FantasyPros has sent it back, by what
// came of the sign-in.
const SIGN_IN_PAGES = {
  connected: {
    status: 200,
    text: "FantasyPros is connected. You can close this page."
  },
  failed: {
    status: 200,
    text: "The sign-in to FantasyPros failed. Send /connect to the bot to try again."
  },
  unknown: {
    status: 400,
    text: "This is not a sign-in the bot started."
  }
};

async function signInCallback(request: Request, env: Env) {
  const query = new URL(request.url).searchParams;
  const outcome = await env.FantasyWeeklyAgent.getByName(
    AGENT_NAME
  ).completeSignIn({
    state: query.get("state"),
    code: query.get("code"),
    error: query.get("error")
  });
  const { status, text } = SIGN_IN_PAGES[outcome];
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

export default {
  // The HTTP surface is the Telegram webhook, the client metadata document
  // FantasyPros reads during a sign-in, and the address it sends the browser
  // back to after one, and nothing else.
  async fetch(request, env, ctx) {
    const { origin, pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === CLIENT_METADATA_PATH) {
      return Response.json(clientMetadata(origin));
    }
    if (request.method === "GET" && pathname === SIGN_IN_CALLBACK_PATH) {
      return signInCallback(request, env);
    }
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
      const command = commandIn(text);
      if (command === "preview") {
        // Awaited, so a request that was not recorded is not acknowledged and
        // Telegram delivers it again.
        await agent.requestPreview();
      } else if (command === "connect") {
        ctx.waitUntil(agent.requestSignIn(origin));
      } else {
        ctx.waitUntil(agent.sendHint());
      }
    }
    return new Response(null, { status: 200 });
  }
} satisfies ExportedHandler<Env>;
