// The single test seam: the agent's outside edge. Tests fake what the agent
// reaches out to (HTTP, the clock), trigger it the way the outside world does,
// and assert only on what leaves it.
import {
  reset,
  runDurableObjectAlarm,
  runInDurableObject
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, vi } from "vitest";
import { AGENT_NAME, type FantasyWeeklyAgent } from "../src/server";

let unanswered: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  unanswered = [];
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
 */
export function fakeOutboundHttp(savedResponses: Record<string, unknown>) {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new Request(input).url;
    requests.push(url);
    if (!(url in savedResponses)) {
      unanswered.push(url);
      throw new Error(`No saved response for ${url}`);
    }
    return Response.json(savedResponses[url]);
  });
  return { requests };
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
