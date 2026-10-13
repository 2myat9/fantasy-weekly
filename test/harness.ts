// The single test seam: the agent's outside edge. Tests fake what the agent
// reaches out to (HTTP, the clock), trigger it the way the outside world does,
// and assert only on what leaves it.
import {
  createExecutionContext,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, vi } from "vitest";
import worker, { AGENT_NAME, type FantasyWeeklyAgent } from "../src/server";

/** The chat the bot answers: the one configured as the user's. */
export const MY_CHAT_ID = Number(env.TELEGRAM_CHAT_ID);

const TELEGRAM_SEND_MESSAGE = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
const TELEGRAM_WEBHOOK = "https://fantasy-weekly.example/telegram/webhook";
const CLAUDE_MESSAGES = "https://api.anthropic.com/v1/messages";

/** One entry of a model-written section, as the writer returns it. */
export type WrittenEntry = {
  playerId: string;
  status: "out" | "questionable" | "cleared" | "none";
  text: string;
  sourceItemIds: string[];
};

/** The model-written sections, as the writer returns them. */
export type WrittenSections = {
  needsDecision: WrittenEntry[];
  stillUnresolved: WrittenEntry[];
  otherNews: WrittenEntry[];
};

/** The material the writer is handed for one league. */
export type WriterMaterial = {
  league: { name: string; format: string };
  week: number;
  today: string;
  roster: {
    playerId: string;
    name: string;
    position: string | null;
    team: string | null;
    slot: string;
    sleeperStatus: string | null;
  }[];
  sourceItems: {
    id: string;
    playerId: string;
    date: string;
    source: string;
    link: string;
    text: string;
  }[];
};

/** One call to the writer: the request as Claude received it. */
export type WriterCall = {
  model: string;
  instructions: string;
  material: WriterMaterial;
};

/** Stands in for Claude: the sections it writes from the material handed over. */
export type WriterStandIn = (material: WriterMaterial) => WrittenSections;

const writesNothing: WriterStandIn = () => ({
  needsDecision: [],
  stillUnresolved: [],
  otherNews: []
});

// The outbound fake of the current test, so a delivery can read what was sent.
let telegramMessages: unknown[] = [];

let unanswered: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  unanswered = [];
  telegramMessages = [];
  // Each test starts with an agent that has no state and nothing scheduled.
  await reset();
});

export function agent() {
  return env.FantasyWeeklyAgent.getByName(AGENT_NAME);
}

/**
 * Answers the agent's outbound HTTP from saved responses, keyed by URL.
 * A request to any other URL throws, so a test never reaches the network, and
 * fails the run that made it.
 *
 * Telegram sends are accepted without a saved response and collected in
 * `telegramMessages` as the bodies Telegram received, in order. They are kept
 * out of `requests`, which lists what the agent read.
 *
 * Calls to Claude are answered by `writer`, the stand-in for the model, and
 * collected in `writerCalls`. Unless a test gives one, it writes no sections.
 */
export function fakeOutboundHttp(
  savedResponses: Record<string, unknown> = {},
  { writer = writesNothing }: { writer?: WriterStandIn } = {}
) {
  const requests: string[] = [];
  const sent: unknown[] = [];
  const writerCalls: WriterCall[] = [];
  telegramMessages = sent;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = request.url;
      if (url === TELEGRAM_SEND_MESSAGE) {
        const message = await request.json();
        // Telegram never answers within the tick that sent the request.
        await new Promise((resolve) => setTimeout(resolve, 0));
        sent.push(message);
        return Response.json({ ok: true, result: {} });
      }
      if (url.split("?")[0] === CLAUDE_MESSAGES) {
        const body = await request.json<{
          model: string;
          system: string;
          messages: { content: string }[];
        }>();
        const material = JSON.parse(body.messages[0].content);
        writerCalls.push({
          model: body.model,
          instructions: body.system,
          material
        });
        return Response.json({
          id: "msg_stand_in",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: JSON.stringify(writer(material)) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        });
      }
      requests.push(url);
      if (!(url in savedResponses)) {
        unanswered.push(url);
        throw new Error(`No saved response for ${url}`);
      }
      const saved = savedResponses[url];
      // A saved `Response` is returned as it is, to stand in for a failing source.
      return saved instanceof Response ? saved.clone() : Response.json(saved);
    }
  );
  return { requests, telegramMessages: sent, writerCalls };
}

/** A Telegram update carrying one text message from the given chat. */
export function textMessage(text: string, chatId = MY_CHAT_ID) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: chatId, type: "private" },
      text
    }
  };
}

/**
 * Delivers an update to the webhook the way Telegram does, then lets the work
 * it started finish: what the webhook left running, and the run it put on the
 * agent's schedule. `sentWhenAcknowledged` is how many messages Telegram had
 * received when the webhook answered, and `scheduledWhenAcknowledged` what was
 * pending on the agent's schedule then.
 */
export async function deliverTelegramUpdate(
  update: unknown,
  { secret = env.TELEGRAM_WEBHOOK_SECRET }: { secret?: string | null } = {}
) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (secret !== null) headers.set("X-Telegram-Bot-Api-Secret-Token", secret);
  // The cast supplies the Cloudflare request metadata type the handler is
  // declared with; the webhook reads none of it.
  const request = new Request(TELEGRAM_WEBHOOK, {
    method: "POST",
    headers,
    body: JSON.stringify(update)
  }) as Request<unknown, IncomingRequestCfProperties>;
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  const sentWhenAcknowledged = telegramMessages.length;
  const scheduledWhenAcknowledged = await pendingSchedule();
  await waitOnExecutionContext(ctx);
  await finishDueTasks();
  return {
    status: response.status,
    sentWhenAcknowledged,
    scheduledWhenAcknowledged
  };
}

/**
 * Lets the tasks that are due on the agent's schedule run to the end. A task
 * due now may already be running, because the runtime fires an alarm that is
 * due without being asked, so firing the alarm here is not enough: a task
 * stays on the schedule until it has finished, and that is what is waited for.
 */
async function finishDueTasks() {
  await runDurableObjectAlarm(agent());
  const isDue = (task: { at: string }) => new Date(task.at) <= new Date();
  for (let waited = 0; (await pendingSchedule()).some(isDue); waited++) {
    if (waited === 1000) throw new Error("A due task did not finish");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Puts a digest run on the agent's schedule for the given instant without
 * firing it, unless the agent has already scheduled one for then.
 */
async function scheduleRun(instant: string) {
  await runInDurableObject(agent(), async (instance: FantasyWeeklyAgent) => {
    const at = new Date(instant);
    const scheduled = instance
      .getSchedules()
      .some(
        ({ callback, time }) =>
          callback === "runDigest" && time * 1000 === at.getTime()
      );
    if (!scheduled) await instance.schedule(at, "runDigest");
  });
}

/** What is pending on the agent's schedule: each task and when it is due. */
export async function pendingSchedule() {
  return runInDurableObject(agent(), (instance: FantasyWeeklyAgent) =>
    instance.getSchedules().map(({ callback, time }) => ({
      task: callback,
      at: new Date(time * 1000).toISOString()
    }))
  );
}

/** Moves the clock the agent reads to the given instant. */
export function setClock(instant: string) {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(instant) });
}

/**
 * Triggers a scheduled run at the given instant: the clock is moved there, a
 * run is put on the agent's own schedule for that instant, and its alarm fires.
 */
export async function triggerScheduledRun(instant: string) {
  setClock(instant);
  await scheduleRun(instant);
  const ran = await runDurableObjectAlarm(agent());
  if (!ran) throw new Error(`No alarm was pending for ${instant}`);
  // The agent's scheduler swallows a failed run, so surface the cause here.
  if (unanswered.length > 0) {
    throw new Error(`No saved response for: ${unanswered.join(", ")}`);
  }
}

/** What the agent has stored about one player: every field it kept. */
export async function storedPlayer(id: string) {
  return runInDurableObject(agent(), (_instance, state) =>
    state.storage.sql.exec("SELECT * FROM players WHERE id = ?", id).one()
  );
}
