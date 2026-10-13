import { expect, it } from "vitest";
import stateNfl from "./fixtures/sleeper/state-nfl.json";
import { agent, fakeOutboundHttp, triggerScheduledRun } from "./harness";

const SLEEPER_NFL_STATE = "https://api.sleeper.app/v1/state/nfl";

it("a scheduled run reads the NFL week from Sleeper at the instant it was triggered", async () => {
  const outbound = fakeOutboundHttp({ [SLEEPER_NFL_STATE]: stateNfl });

  // Saturday 17 October 2026, 6:00 PM Pacific.
  await triggerScheduledRun("2026-10-18T01:00:00Z");

  expect(outbound.requests).toEqual([SLEEPER_NFL_STATE]);
  expect(await agent().lastRun()).toEqual({
    at: "2026-10-18T01:00:00.000Z",
    season: "2026",
    seasonType: "regular",
    week: 6
  });
});
