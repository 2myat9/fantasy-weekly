import { expect, it } from "vitest";
import {
  deliverTelegramUpdate,
  fakeOutboundHttp,
  MY_CHAT_ID,
  pendingSchedule,
  setClock,
  textMessage,
  triggerScheduledRun
} from "./harness";
import { savedSources, URLS } from "./sources";

/** The first line of each Telegram message sent, in order. */
function titles(messages: unknown[]) {
  return messages.map(
    (message) => (message as { text: string }).text.split("\n")[0]
  );
}

// The instants are years ahead of the runtime's clock, so that a run starts
// only when a test triggers it. The saved sources still report week 6 of 2026.

it("a scheduled run on Saturday at 6:00 PM Pacific sends one league message per league, not marked as a preview", async () => {
  const outbound = fakeOutboundHttp(savedSources());

  // Saturday 19 October 2030, 6:00 PM Pacific.
  await triggerScheduledRun("2030-10-20T01:00:00Z");

  expect(outbound.telegramMessages).toEqual([
    {
      chat_id: String(MY_CHAT_ID),
      text: [
        "<b>Duffy Redraft</b>",
        "Redraft · Week 6",
        "",
        "<b>Lineup check</b>",
        "🔴 QB <b>Jared Goff</b> (DET) is on bye",
        "🔴 FLEX <b>Sam LaPorta</b> (DET) is on bye",
        "🔴 K <b>Jake Bates</b> (DET) is on bye"
      ].join("\n"),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true }
    },
    {
      chat_id: String(MY_CHAT_ID),
      text: [
        "<b>Joel is the GOAT</b>",
        "Dynasty · Week 6",
        "",
        "<b>Lineup check</b>",
        "🔴 REC FLEX <b>KC Concepcion</b> (CLE) is ruled out",
        "🔴 DEF <b>Detroit Lions</b> (DET) is on bye"
      ].join("\n"),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true }
    }
  ]);
});

it("after a run, the next run is scheduled for the following Saturday at 6:00 PM Pacific", async () => {
  fakeOutboundHttp(savedSources());

  await triggerScheduledRun("2030-10-20T01:00:00Z");

  // Saturday 26 October 2030, 6:00 PM Pacific.
  expect(await pendingSchedule()).toEqual([
    { task: "runDigest", at: "2030-10-27T01:00:00.000Z" }
  ]);
});

it("the next run stays at 6:00 PM Pacific across the autumn daylight-saving change", async () => {
  fakeOutboundHttp(savedSources());

  // Saturday 2 November 2030, 6:00 PM Pacific Daylight Time.
  await triggerScheduledRun("2030-11-03T01:00:00Z");

  // Saturday 9 November 2030, 6:00 PM Pacific Standard Time: 169 hours later.
  expect(await pendingSchedule()).toEqual([
    { task: "runDigest", at: "2030-11-10T02:00:00.000Z" }
  ]);
});

it("the next run stays at 6:00 PM Pacific across the spring daylight-saving change", async () => {
  fakeOutboundHttp(savedSources());

  // Saturday 8 March 2031, 6:00 PM Pacific Standard Time.
  await triggerScheduledRun("2031-03-09T02:00:00Z");

  // Saturday 15 March 2031, 6:00 PM Pacific Daylight Time: 167 hours later.
  expect(await pendingSchedule()).toEqual([
    { task: "runDigest", at: "2031-03-16T01:00:00.000Z" }
  ]);
});

it("the schedule is armed when the agent first starts, and only once", async () => {
  fakeOutboundHttp();
  // Wednesday 16 October 2030, noon Pacific.
  setClock("2030-10-16T19:00:00Z");

  // The first thing to reach the agent starts it.
  await deliverTelegramUpdate(textMessage("hello"));

  const saturday = [{ task: "runDigest", at: "2030-10-20T01:00:00.000Z" }];
  expect(await pendingSchedule()).toEqual(saturday);

  await deliverTelegramUpdate(textMessage("hello again"));
  expect(await pendingSchedule()).toEqual(saturday);
});

it("a second automatic run for the same season and week sends nothing", async () => {
  const outbound = fakeOutboundHttp(savedSources());
  await triggerScheduledRun("2030-10-20T01:00:00Z");

  // Sleeper still reports week 6.
  await triggerScheduledRun("2030-10-27T01:00:00Z");

  expect(outbound.telegramMessages).toHaveLength(2);
});

it("the automatic digest is recorded per league, so a league that was not sent yet still is", async () => {
  // The saved responses are read when a request is made, so the list of my
  // leagues can change between the two runs.
  const sources: Record<string, unknown> = savedSources();
  const [redraft, dynasty] = sources[URLS.leagues] as unknown[];
  const outbound = fakeOutboundHttp(sources);
  sources[URLS.leagues] = [redraft];
  await triggerScheduledRun("2030-10-20T01:00:00Z");

  sources[URLS.leagues] = [redraft, dynasty];
  await triggerScheduledRun("2030-10-27T01:00:00Z");

  expect(titles(outbound.telegramMessages)).toEqual([
    "<b>Duffy Redraft</b>",
    "<b>Joel is the GOAT</b>"
  ]);
});

it.each(["off", "pre"])(
  "nothing is sent when Sleeper reports the NFL season type as %s, and the next run is still scheduled",
  async (seasonType) => {
    const sources = savedSources();
    (sources[URLS.nflState] as { season_type: string }).season_type =
      seasonType;
    const outbound = fakeOutboundHttp(sources);

    await triggerScheduledRun("2030-10-20T01:00:00Z");

    expect(outbound.telegramMessages).toEqual([]);
    expect(await pendingSchedule()).toEqual([
      { task: "runDigest", at: "2030-10-27T01:00:00.000Z" }
    ]);
  }
);

it("nothing is sent for a league whose status is complete", async () => {
  const sources = savedSources();
  const [redraft] = sources[URLS.leagues] as { status: string }[];
  redraft.status = "complete";
  const outbound = fakeOutboundHttp(sources);

  await triggerScheduledRun("2030-10-20T01:00:00Z");

  expect(titles(outbound.telegramMessages)).toEqual([
    "<b>Joel is the GOAT</b>"
  ]);
});

it("nothing is sent for a league where my team is eliminated from the playoffs", async () => {
  const sources = savedSources();
  // Week 15 is the first playoff week in both leagues. My roster is number 9.
  (sources[URLS.nflState] as { week: number }).week = 15;
  const outbound = fakeOutboundHttp({
    ...sources,
    [URLS.scoreboardWeek15]: sources[URLS.scoreboard],
    // Six teams made the redraft playoffs and mine is not one of them.
    [URLS.bracketRedraft]: [
      { m: 1, r: 1, l: null, w: null, t1: 4, t2: 2 },
      { m: 2, r: 1, l: null, w: null, t1: 1, t2: 6 },
      { m: 3, r: 2, l: null, w: null, t1: 11, t2: null, t2_from: { w: 1 } },
      { m: 4, r: 2, l: null, w: null, t1: 7, t2: null, t2_from: { w: 2 } }
    ],
    // In the dynasty league I have a bye into the second round.
    [URLS.bracketDynasty]: [
      { m: 1, r: 1, l: null, w: null, t1: 4, t2: 2 },
      { m: 2, r: 1, l: null, w: null, t1: 1, t2: 6 },
      { m: 3, r: 2, l: null, w: null, t1: 3, t2: null, t2_from: { w: 1 } },
      { m: 4, r: 2, l: null, w: null, t1: 9, t2: null, t2_from: { w: 2 } }
    ]
  });

  await triggerScheduledRun("2030-10-20T01:00:00Z");

  expect(titles(outbound.telegramMessages)).toEqual([
    "<b>Joel is the GOAT</b>"
  ]);
});

it("a team left with only a placement game counts as eliminated, and one in the title game does not", async () => {
  const sources = savedSources();
  (sources[URLS.nflState] as { week: number }).week = 15;
  // Both leagues going into the last round. My roster is number 9.
  const lastRound = (semifinalWinner: number, semifinalLoser: number) => [
    { m: 1, r: 1, l: 5, w: 9, t1: 9, t2: 5 },
    { m: 2, r: 1, l: 2, w: 6, t1: 6, t2: 2 },
    {
      m: 3,
      r: 2,
      l: semifinalLoser,
      w: semifinalWinner,
      t1: 7,
      t2: 9,
      t2_from: { w: 1 }
    },
    { m: 4, r: 2, l: 6, w: 10, t1: 10, t2: 6, t2_from: { w: 2 } },
    { p: 5, m: 5, r: 2, l: 2, w: 5, t1: 5, t2: 2 },
    { p: 1, m: 6, r: 3, l: null, w: null, t1: semifinalWinner, t2: 10 },
    { p: 3, m: 7, r: 3, l: null, w: null, t1: semifinalLoser, t2: 6 }
  ];
  const outbound = fakeOutboundHttp({
    ...sources,
    [URLS.scoreboardWeek15]: sources[URLS.scoreboard],
    // I lost the redraft semifinal and play for third place.
    [URLS.bracketRedraft]: lastRound(7, 9),
    // I won the dynasty semifinal and play for the title.
    [URLS.bracketDynasty]: lastRound(9, 7)
  });

  await triggerScheduledRun("2030-10-20T01:00:00Z");

  expect(titles(outbound.telegramMessages)).toEqual([
    "<b>Joel is the GOAT</b>"
  ]);
});
