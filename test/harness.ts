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
 */
export function fakeOutboundHttp(savedResponses: Record<string, unknown> = {}) {
  const requests: string[] = [];
  const sent: unknown[] = [];
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
      requests.push(url);
      if (!(url in savedResponses)) {
        unanswered.push(url);
        throw new Error(`No saved response for ${url}`);
      }
      return Response.json(savedResponses[url]);
    }
  );
  return { requests, telegramMessages: sent };
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
 * the webhook left running finish. `sentWhenAcknowledged` is how many messages
 * Telegram had received when the webhook answered.
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
  await waitOnExecutionContext(ctx);
  return { status: response.status, sentWhenAcknowledged };
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
  const stub = agent();
  await runInDurableObject(stub, async (instance: FantasyWeeklyAgent) => {
    await instance.schedule(new Date(instant), "scheduledRun");
  });
  const ran = await runDurableObjectAlarm(stub);
  if (!ran) throw new Error(`No alarm was pending for ${instant}`);
  // The agent's scheduler swallows a failed run, so surface the cause here.
  if (unanswered.length > 0) {
    throw new Error(`No saved response for: ${unanswered.join(", ")}`);
  }
}
