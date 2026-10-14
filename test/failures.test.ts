import { expect, it } from "vitest";
import {
  deliverTelegramUpdate,
  fakeOutboundHttp,
  pendingSchedule,
  setClock,
  textMessage,
  triggerScheduledRun,
  type WriterMaterial,
  type WriterStandIn
} from "./harness";
import { FANTASYPROS } from "./fantasypros";
import { fakeSavedSources, savedSources, URLS } from "./sources";

// The saved ESPN injuries were read that morning, so the week before it is the
// news window these tests run in.
const TUESDAY = "2026-10-13T16:00:00Z";

/** The texts of the Telegram messages sent, in order. */
function texts(messages: unknown[]) {
  return messages.map((message) => (message as { text: string }).text);
}

const unavailable = () => new Response("Service Unavailable", { status: 503 });

/** A saved response that is unavailable the first time it is read. */
function failingOnce(saved: unknown) {
  let reads = 0;
  return () => (reads++ === 0 ? unavailable() : saved);
}

// Writes one entry, so that a message shows whether the writer was heard.
const writer: WriterStandIn = (material: WriterMaterial) => ({
  needsDecision: [],
  stillUnresolved: [],
  otherNews:
    material.league.format === "dynasty"
      ? [
          {
            playerId: "8161",
            status: "none",
            text: "Started and finished the game.",
            sourceItemIds: [
              material.sourceItems.find((item) => item.playerId === "8161")!.id
            ]
          }
        ]
      : []
});

// The dynasty players the saved Sleeper player file gives an injury status,
// in roster order.
const DYNASTY_STATUSES = [
  "<b>KC Concepcion</b> (CLE): Out",
  "<b>Andrei Iosivas</b> (CIN): IR",
  "<b>Terrance Ferguson</b> (LAR): IR",
  "<b>Eli Stowers</b> (PHI): IR",
  "<b>James Conner</b> (ARI): IR",
  "<b>Rico Dowdle</b> (PIT): Out",
  "<b>Jayden Higgins</b> (HOU): IR",
  "<b>Jaylin Lane</b> (WAS): IR"
];

/** The league messages of a preview in which nothing fails. */
async function fullPreview() {
  const outbound = await fakeSavedSources(savedSources(), { writer });
  await deliverTelegramUpdate(textMessage("/preview"));
  return texts(outbound.telegramMessages);
}

it("a source call that fails once and then succeeds produces the normal league message", async () => {
  setClock(TUESDAY);
  const full = await fullPreview();
  const sources = savedSources();
  for (const url of [URLS.nflState, URLS.rostersDynasty, URLS.injuries]) {
    sources[url] = failingOnce(sources[url]);
  }
  const outbound = await fakeSavedSources(sources, { writer });

  await deliverTelegramUpdate(textMessage("/preview"));

  expect(full).toHaveLength(2);
  expect(texts(outbound.telegramMessages)).toEqual(full);
});

it("a model call that fails once and then succeeds produces the normal league message", async () => {
  setClock(TUESDAY);
  const full = await fullPreview();
  let calls = 0;
  const outbound = await fakeSavedSources(savedSources(), {
    writer: (material) => {
      if (calls++ === 0) throw new Error("Overloaded");
      return writer(material);
    }
  });

  await deliverTelegramUpdate(textMessage("/preview"));

  expect(full[1]).toContain("Started and finished the game.");
  expect(texts(outbound.telegramMessages)).toEqual(full);
});

it("when a source keeps failing, the league message still has the lineup check and the Sleeper injury statuses, and names the missing source", async () => {
  setClock(TUESDAY);
  const outbound = await fakeSavedSources(
    { ...savedSources(), [URLS.injuries]: unavailable },
    {
      writer: () => ({ needsDecision: [], stillUnresolved: [], otherNews: [] })
    }
  );

  await deliverTelegramUpdate(textMessage("/preview"));

  const [, dynasty] = texts(outbound.telegramMessages);
  expect(dynasty.split("\n\n").slice(0, 3)).toEqual([
    [
      "<b>Preview · Joel is the GOAT</b>",
      "Dynasty · Week 6",
      "⚠️ Missing from this message: ESPN's injury reports."
    ].join("\n"),
    [
      "<b>Lineup check</b>",
      "🔴 REC FLEX <b>KC Concepcion</b> (CLE) is ruled out",
      "🔴 DEF <b>Detroit Lions</b> (DET) is on bye"
    ].join("\n"),
    ["<b>Injury statuses from Sleeper</b>", ...DYNASTY_STATUSES].join("\n")
  ]);
});

it("when the model keeps failing, the league message still has the lineup check and the Sleeper injury statuses, and says the written sections are missing", async () => {
  setClock(TUESDAY);
  const outbound = await fakeSavedSources(savedSources(), {
    writer: () => {
      throw new Error("Overloaded");
    }
  });

  await deliverTelegramUpdate(textMessage("/preview"));

  const [, dynasty] = texts(outbound.telegramMessages);
  expect(dynasty).toBe(
    [
      "<b>Preview · Joel is the GOAT</b>",
      "Dynasty · Week 6",
      "⚠️ Missing from this message: the written news sections (the model call failed).",
      "",
      "<b>Lineup check</b>",
      "🔴 REC FLEX <b>KC Concepcion</b> (CLE) is ruled out",
      "🔴 DEF <b>Detroit Lions</b> (DET) is on bye",
      "",
      "<b>Injury statuses from Sleeper</b>",
      ...DYNASTY_STATUSES,
      "",
      // Nobody is listed as having no significant news: nothing was written.
      "<b>Couldn't check</b>",
      "KC Concepcion"
    ].join("\n")
  );
});

it("when ESPN's schedule keeps failing, the lineup check says that byes were not checked", async () => {
  setClock(TUESDAY);
  const outbound = await fakeSavedSources({
    ...savedSources(),
    [URLS.scoreboard]: unavailable
  });

  await deliverTelegramUpdate(textMessage("/preview"));

  const [redraft, dynasty] = texts(outbound.telegramMessages);
  expect(redraft.split("\n\n").slice(0, 2)).toEqual([
    [
      "<b>Preview · Duffy Redraft</b>",
      "Redraft · Week 6",
      "⚠️ Missing from this message: ESPN's schedule (byes and kickoffs were not checked)."
    ].join("\n"),
    [
      "<b>Lineup check</b>",
      "✅ No starter is ruled out or on IR, and every slot is filled.",
      "⚠️ Byes could not be checked."
    ].join("\n")
  ]);
  expect(dynasty.split("\n\n")[1]).toBe(
    [
      "<b>Lineup check</b>",
      "🔴 REC FLEX <b>KC Concepcion</b> (CLE) is ruled out",
      "⚠️ Byes could not be checked."
    ].join("\n")
  );
});

it("when FantasyPros keeps failing, the league message names it as missing and still has the other sources' news", async () => {
  setClock(TUESDAY);
  const outbound = await fakeSavedSources(
    { ...savedSources(), [FANTASYPROS.mcp]: unavailable },
    { writer }
  );

  await deliverTelegramUpdate(textMessage("/preview"));

  const [redraft, dynasty] = texts(outbound.telegramMessages);
  expect(redraft.split("\n")[2]).toBe(
    "⚠️ Missing from this message: FantasyPros' news."
  );
  expect(dynasty.split("\n")[2]).toBe(
    "⚠️ Missing from this message: FantasyPros' news."
  );
  // Malik Willis' entry is written from ESPN's report on him.
  expect(dynasty).toContain("Started and finished the game.");
  const sources = new Set(
    outbound.writerCalls.flatMap(({ material }) =>
      material.sourceItems.map(({ source }) => source)
    )
  );
  expect([...sources].sort()).toEqual(["ESPN", "ProFootballTalk"]);
  // Nothing looked up the players Sleeper has no ESPN ID for, so they are not
  // said to have no news.
  expect(redraft.split("\n").slice(-2)).toEqual([
    "<b>Couldn't check</b>",
    "Bijan Robinson, Jeremiyah Love, Denzel Boston, Matthew Golden, Trey McBride, Sam LaPorta, Bucky Irving, Jake Bates, Drake Maye, Luther Burden, Alec Pierce, Rashid Shaheed"
  ]);
  expect(Math.max(...outbound.requestsPerInvocation)).toBeLessThanOrEqual(50);
});

it("when FantasyPros answers with something other than the news, such as a notice that the plan does not include the tool, the league message names it as missing", async () => {
  setClock(TUESDAY);
  const outbound = await fakeSavedSources(savedSources(), {
    writer,
    injuryStatus: () => ({
      status: "premium_required",
      required_user_disclosure: "This feature is not included in your plan."
    })
  });

  await deliverTelegramUpdate(textMessage("/preview"));

  for (const text of texts(outbound.telegramMessages)) {
    expect(text.split("\n")[2]).toBe(
      "⚠️ Missing from this message: FantasyPros' news."
    );
  }
  // An answer that will not change is not asked for again.
  expect(outbound.fantasyPros.toolCalls).toHaveLength(1);
});

it("when the agent is not connected to FantasyPros, the league message names FantasyPros as missing and says to send /connect", async () => {
  setClock(TUESDAY);
  const outbound = fakeOutboundHttp(savedSources(), { writer });

  await deliverTelegramUpdate(textMessage("/preview"));

  const [redraft, dynasty] = texts(outbound.telegramMessages);
  for (const text of [redraft, dynasty]) {
    expect(text.split("\n")[2]).toBe(
      "⚠️ Missing from this message: FantasyPros' news (not connected, send /connect)."
    );
  }
  expect(dynasty).toContain("Started and finished the game.");
});

it("when FantasyPros has ended the agent's sign-in, the league message names FantasyPros as missing and says to send /connect", async () => {
  setClock(TUESDAY);
  const outbound = await fakeSavedSources(savedSources(), { writer });
  outbound.fantasyPros.revoke();
  // A day after the sign-in, so that its access token has to be renewed.
  setClock("2026-10-14T16:00:00Z");

  await deliverTelegramUpdate(textMessage("/preview"));

  const [redraft, dynasty] = texts(outbound.telegramMessages);
  for (const text of [redraft, dynasty]) {
    expect(text.split("\n")[2]).toBe(
      "⚠️ Missing from this message: FantasyPros' news (the sign-in was lost, send /connect)."
    );
  }
  expect(outbound.fantasyPros.toolCalls).toEqual([]);
});

// Saturday 19 October 2030, 6:00 PM Pacific, and the Saturday after it. The
// saved sources report week 6 of 2026 on both.
const SATURDAY = "2030-10-20T01:00:00Z";
const NEXT_SATURDAY = "2030-10-27T01:00:00Z";

it("when the model fails for one league, the other league's full message is still sent", async () => {
  // Inside the news window, so that there is news for the writer to be handed.
  setClock(TUESDAY);
  const outbound = await fakeSavedSources(savedSources(), {
    writer: (material) => {
      if (material.league.format === "redraft") throw new Error("Overloaded");
      return writer(material);
    }
  });

  await deliverTelegramUpdate(textMessage("/preview"));

  const [redraft, dynasty] = texts(outbound.telegramMessages);
  expect(redraft).toContain("<b>Preview · Duffy Redraft</b>");
  expect(redraft).toContain("the written news sections");
  expect(dynasty).toContain("<b>Preview · Joel is the GOAT</b>");
  expect(dynasty).not.toContain("Missing from this message");
  expect(dynasty).toContain("<b>No significant news</b>");
});

it("when Sleeper keeps failing, the automatic run sends one short failure message that names /preview, and the next run is still scheduled", async () => {
  const outbound = await fakeSavedSources({
    ...savedSources(),
    [URLS.nflState]: unavailable
  });

  await triggerScheduledRun(SATURDAY);

  expect(texts(outbound.telegramMessages)).toEqual([
    "The digest could not be built. Send /preview to try again."
  ]);
  expect(await pendingSchedule()).toEqual([
    { task: "runDigest", at: "2030-10-27T01:00:00.000Z" }
  ]);
});

it("when one league's message cannot be built at all, the other league's is sent and the failure message names the league that failed", async () => {
  const outbound = await fakeSavedSources({
    ...savedSources(),
    [URLS.rostersRedraft]: unavailable
  });

  await triggerScheduledRun(SATURDAY);

  const [dynasty, ...rest] = texts(outbound.telegramMessages);
  expect(dynasty).toMatch(/^<b>Joel is the GOAT<\/b>/);
  expect(dynasty).not.toContain("Missing from this message");
  expect(rest).toEqual([
    "The digest could not be built for Duffy Redraft. Send /preview to try again."
  ]);
});

it("a league whose automatic message failed is not written to the sent record, and a league that was sent is", async () => {
  const sources = savedSources();
  const rosters = sources[URLS.rostersRedraft];
  sources[URLS.rostersRedraft] = unavailable;
  const outbound = await fakeSavedSources(sources);
  await triggerScheduledRun(SATURDAY);
  const sentFirst = outbound.telegramMessages.length;

  // Sleeper is back, and still reports the same week.
  sources[URLS.rostersRedraft] = rosters;
  await triggerScheduledRun(NEXT_SATURDAY);

  expect(sentFirst).toBe(2);
  expect(
    texts(outbound.telegramMessages)
      .slice(sentFirst)
      .map((text) => text.split("\n")[0])
  ).toEqual(["<b>Duffy Redraft</b>"]);
});

it("a league whose message cannot be delivered does not keep the other league's from being sent", async () => {
  const outbound = await fakeSavedSources(savedSources(), {
    rejectTelegram: (text) => text.includes("Duffy Redraft</b>\n")
  });

  await triggerScheduledRun(SATURDAY);

  expect(texts(outbound.telegramMessages)).toEqual([
    expect.stringMatching(/^<b>Joel is the GOAT<\/b>/),
    "The digest could not be built for Duffy Redraft. Send /preview to try again."
  ]);
});

it("when no news could be read at all, nobody is listed as having no significant news", async () => {
  setClock(TUESDAY);
  const sources = savedSources();
  for (const url of Object.keys(sources)) {
    if (!url.startsWith("https://api.sleeper.app/")) sources[url] = unavailable;
  }
  // The agent is signed in to FantasyPros, whose tools fail.
  sources[FANTASYPROS.mcp] = unavailable;
  const outbound = await fakeSavedSources(sources);

  await deliverTelegramUpdate(textMessage("/preview"));

  const [redraft, dynasty] = texts(outbound.telegramMessages);
  expect(redraft).toContain("<b>Injury statuses from Sleeper</b>");
  expect(dynasty).toContain("<b>Injury statuses from Sleeper</b>");
  expect(redraft + dynasty).not.toContain("No significant news");
  expect(Math.max(...outbound.requestsPerInvocation)).toBeLessThanOrEqual(50);
});
