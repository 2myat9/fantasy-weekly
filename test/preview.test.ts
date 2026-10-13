import { expect, it } from "vitest";
import {
  deliverTelegramUpdate,
  fakeOutboundHttp,
  MY_CHAT_ID,
  pendingSchedule,
  setClock,
  storedPlayer,
  textMessage,
  triggerScheduledRun
} from "./harness";
import { MY_USER_ID, savedSources, URLS } from "./sources";

/** The texts of the Telegram messages sent, in order. */
function texts(messages: unknown[]) {
  return messages.map((message) => (message as { text: string }).text);
}

/** A league message up to the end of its lineup check: its first two blocks. */
function throughLineupCheck(text: string) {
  return text.split("\n\n").slice(0, 2).join("\n\n");
}

/** Sets my lineup in the saved rosters of one league. */
function setMyStarters(
  sources: ReturnType<typeof savedSources>,
  rostersUrl: string,
  starters: string[]
) {
  const rosters = sources[rostersUrl] as {
    owner_id: string;
    starters: string[];
  }[];
  rosters.find((roster) => roster.owner_id === MY_USER_ID)!.starters = starters;
}

// Lineups with nothing to flag in week 6, in each league's slot order.
const CLEAR_REDRAFT = [
  "11564", // QB Drake Maye
  "9509",
  "13287",
  "13346",
  "12501",
  "8130",
  "12519", // FLEX Luther Burden
  "11584",
  "1945", // K Chris Boswell
  "SEA"
];
const CLEAR_DYNASTY = [
  "6904",
  "12507",
  "12481",
  "8146",
  "12490",
  "11631", // REC_FLEX Brian Thomas
  "9487",
  "13294",
  "7523",
  "1945",
  "SEA"
];

it("/preview sends one preview-marked message per league, each opening with its lineup check", async () => {
  const outbound = fakeOutboundHttp(savedSources());

  await deliverTelegramUpdate(textMessage("/preview"));

  expect(outbound.telegramMessages).toEqual([
    {
      chat_id: String(MY_CHAT_ID),
      text: expect.any(String),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true }
    },
    {
      chat_id: String(MY_CHAT_ID),
      text: expect.any(String),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true }
    }
  ]);
  expect(texts(outbound.telegramMessages).map(throughLineupCheck)).toEqual([
    [
      "<b>Preview · Duffy Redraft</b>",
      "Redraft · Week 6",
      "",
      "<b>Lineup check</b>",
      "🔴 QB <b>Jared Goff</b> (DET) is on bye",
      "🔴 FLEX <b>Sam LaPorta</b> (DET) is on bye",
      "🔴 K <b>Jake Bates</b> (DET) is on bye"
    ].join("\n"),
    [
      "<b>Preview · Joel is the GOAT</b>",
      "Dynasty · Week 6",
      "",
      "<b>Lineup check</b>",
      "🔴 REC FLEX <b>KC Concepcion</b> (CLE) is ruled out",
      "🔴 DEF <b>Detroit Lions</b> (DET) is on bye"
    ].join("\n")
  ]);
});

it("a starter on IR and an empty starting slot are flagged", async () => {
  const sources = savedSources();
  setMyStarters(sources, URLS.rostersRedraft, [
    "11564",
    "9509",
    "13287",
    "8142", // WR Alec Pierce, on IR
    "12501",
    "8130",
    "12519",
    "0", // FLEX left empty
    "1945",
    "SEA"
  ]);
  const outbound = fakeOutboundHttp(sources);

  await deliverTelegramUpdate(textMessage("/preview"));

  expect(throughLineupCheck(texts(outbound.telegramMessages)[0])).toBe(
    [
      "<b>Preview · Duffy Redraft</b>",
      "Redraft · Week 6",
      "",
      "<b>Lineup check</b>",
      "🔴 WR <b>Alec Pierce</b> (IND) is on IR",
      "🔴 FLEX slot is empty"
    ].join("\n")
  );
});

it("a lineup with nothing to flag is reported as clear", async () => {
  const sources = savedSources();
  setMyStarters(sources, URLS.rostersRedraft, CLEAR_REDRAFT);
  setMyStarters(sources, URLS.rostersDynasty, CLEAR_DYNASTY);
  const outbound = fakeOutboundHttp(sources);

  await deliverTelegramUpdate(textMessage("/preview"));

  const clear =
    "✅ Lineup clear: no starter is on bye, ruled out or on IR, and every slot is filled.";
  expect(texts(outbound.telegramMessages).map(throughLineupCheck)).toEqual([
    `<b>Preview · Duffy Redraft</b>\nRedraft · Week 6\n\n<b>Lineup check</b>\n${clear}`,
    `<b>Preview · Joel is the GOAT</b>\nDynasty · Week 6\n\n<b>Lineup check</b>\n${clear}`
  ]);
});

it("lineup slots are read from the league, so a changed league is checked by its own slots", async () => {
  const sources = savedSources();
  const leagues = sources[URLS.leagues] as { roster_positions: string[] }[];
  // The redraft league drops a FLEX and starts a superflex and a second TE.
  leagues[0].roster_positions = ["QB", "SUPER_FLEX", "TE", "TE", "BN", "BN"];
  setMyStarters(sources, URLS.rostersRedraft, ["11564", "3163", "0", "10859"]);
  const outbound = fakeOutboundHttp(sources);

  await deliverTelegramUpdate(textMessage("/preview"));

  expect(throughLineupCheck(texts(outbound.telegramMessages)[0])).toBe(
    [
      "<b>Preview · Duffy Redraft</b>",
      "Redraft · Week 6",
      "",
      "<b>Lineup check</b>",
      "🔴 SUPER FLEX <b>Jared Goff</b> (DET) is on bye",
      "🔴 TE slot is empty",
      "🔴 TE <b>Sam LaPorta</b> (DET) is on bye"
    ].join("\n")
  );
});

it("a second run on the same day does not fetch the Sleeper player file again", async () => {
  const outbound = fakeOutboundHttp(savedSources());
  setClock("2026-10-13T16:00:00Z");
  await deliverTelegramUpdate(textMessage("/preview"));

  setClock("2026-10-14T15:00:00Z");
  await deliverTelegramUpdate(textMessage("/preview"));

  const playerFileFetches = () =>
    outbound.requests.filter((url) => url === URLS.players).length;
  expect(playerFileFetches()).toBe(1);
  // The second run still names players, from the stored copy.
  expect(texts(outbound.telegramMessages)[3]).toContain(
    "🔴 REC FLEX <b>KC Concepcion</b> (CLE) is ruled out"
  );

  // A day after the fetch, the file is read again.
  setClock("2026-10-14T16:00:00Z");
  await deliverTelegramUpdate(textMessage("/preview"));
  expect(playerFileFetches()).toBe(2);
});

it("only the reduced fields of a player are stored", async () => {
  fakeOutboundHttp(savedSources());

  await deliverTelegramUpdate(textMessage("/preview"));

  expect(await storedPlayer("13298")).toEqual({
    id: "13298",
    name: "KC Concepcion",
    position: "WR",
    team: "CLE",
    injury_status: "Out",
    espn_id: null
  });
});

it("the webhook answers Telegram before any message is sent, leaving the run on the agent's schedule", async () => {
  const outbound = fakeOutboundHttp(savedSources());
  // A clock ahead of the runtime's, so the run cannot start by itself.
  setClock("2030-10-13T16:00:00Z");

  const delivery = await deliverTelegramUpdate(textMessage("/preview"));

  expect(delivery.status).toBe(200);
  expect(delivery.sentWhenAcknowledged).toBe(0);
  expect(delivery.scheduledWhenAcknowledged).toContainEqual({
    task: "runPreview",
    at: "2030-10-13T16:00:00.000Z"
  });
  expect(outbound.telegramMessages).toHaveLength(2);
});

it("a preview run that fails sends one short failure message and is not retried", async () => {
  const sources = savedSources();
  const outbound = fakeOutboundHttp({
    ...sources,
    [URLS.scoreboard]: new Response("Service Unavailable", { status: 503 })
  });

  await deliverTelegramUpdate(textMessage("/preview"));

  expect(texts(outbound.telegramMessages)).toEqual([
    "The preview failed. Send /preview to try again."
  ]);
  expect(outbound.requests.filter((url) => url === URLS.scoreboard)).toEqual([
    URLS.scoreboard
  ]);
  const pending = (await pendingSchedule()).map(({ task }) => task);
  expect(pending).not.toContain("runPreview");
});

it("/preview changes neither the next scheduled time nor what the automatic digest sends", async () => {
  const outbound = fakeOutboundHttp(savedSources());
  // Wednesday 16 October 2030, noon Pacific.
  setClock("2030-10-16T19:00:00Z");
  await deliverTelegramUpdate(textMessage("hello"));
  const before = await pendingSchedule();

  await deliverTelegramUpdate(textMessage("/preview"));

  expect(await pendingSchedule()).toEqual(before);
  // The week's automatic digest still goes out in full after the preview.
  await triggerScheduledRun("2030-10-20T01:00:00Z");
  expect(texts(outbound.telegramMessages).slice(3)).toEqual([
    expect.stringMatching(/^<b>Duffy Redraft<\/b>/),
    expect.stringMatching(/^<b>Joel is the GOAT<\/b>/)
  ]);
});
