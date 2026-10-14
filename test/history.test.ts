import { expect, it } from "vitest";
import {
  databaseSize,
  deliverTelegramUpdate,
  fakeOutboundHttp,
  fillDatabaseTo,
  setClock,
  storedHistory,
  textMessage,
  triggerScheduledRun,
  type WriterMaterial
} from "./harness";
import { savedSourcesAhead, URLS } from "./sources";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Sets the NFL week Sleeper reports, with that week's matchups and schedule
 * the saved ones of week 6.
 */
function atWeek(sources: Record<string, unknown>, week: number) {
  (sources[URLS.nflState] as { week: number }).week = week;
  for (const url of [URLS.matchupsRedraft, URLS.matchupsDynasty]) {
    sources[url.replace(/\/6$/, `/${week}`)] = sources[url];
  }
  sources[URLS.scoreboard.replace("week=6", `week=${week}`)] =
    sources[URLS.scoreboard];
}

/** The instant of a date as the writer is handed it, in Pacific time. */
function pacificDate(date: string) {
  // "Sunday, October 11, 2026 at 1:48 PM PDT"
  const instant = new Date(date.replace(/^\w+, /, "").replace(" at ", " "));
  if (isNaN(instant.getTime())) throw new Error(`Not a date: ${date}`);
  return instant;
}

/** The earliest date of the source items handed to the writer. */
function earliestItem(material: WriterMaterial) {
  const dates = material.sourceItems.map(({ date }) => pacificDate(date));
  return new Date(Math.min(...dates.map((date) => date.getTime())));
}

/** The texts of the Telegram messages sent, in order. */
function texts(messages: unknown[]) {
  return messages.map((message) => (message as { text: string }).text);
}

/** What identifies a source item, whether handed to the writer or stored. */
function identities(
  items:
    | WriterMaterial["sourceItems"]
    | { playerId: string; link: string; source: string; text: string }[]
) {
  return items.map(({ playerId, link, source, text }) => ({
    playerId,
    link,
    source,
    text
  }));
}

it("an automatic digest is stored per league with its season, week, time sent, the message as sent and the source items it was built from", async () => {
  const outbound = fakeOutboundHttp(savedSourcesAhead());

  // The morning the saved ESPN injuries were read: Tuesday 15 October 2030.
  await triggerScheduledRun("2030-10-15T16:00:00Z");

  const history = await storedHistory();
  expect(
    history.map(({ messages: _, sourceItems: __, ...digest }) => digest)
  ).toEqual([
    {
      season: "2026",
      seasonType: "regular",
      week: 6,
      leagueId: "1364555323238551552",
      leagueName: "Duffy Redraft",
      sentAt: "2030-10-15T16:00:00.000Z"
    },
    {
      season: "2026",
      seasonType: "regular",
      week: 6,
      leagueId: "1353515683878559744",
      leagueName: "Joel is the GOAT",
      sentAt: "2030-10-15T16:00:00.000Z"
    }
  ]);
  expect(history.map(({ messages }) => messages)).toEqual(
    texts(outbound.telegramMessages).map((text) => [text])
  );
  // The items stored are those the writer was handed for the league: its
  // players' and their opponent's, and none of the downloads they came from.
  expect(history.map(({ sourceItems }) => identities(sourceItems))).toEqual(
    outbound.writerCalls.map(({ material }) => identities(material.sourceItems))
  );
  expect(history[1].sourceItems).toContainEqual({
    playerId: "13298",
    date: "2030-10-13T20:48:00.000Z",
    source: "ESPN",
    link: "https://www.espn.com/nfl/player/_/id/4870653/kc-concepcion",
    text: expect.stringMatching(/^ESPN status: Questionable\. Concepcion /)
  });
});

it("the next digest for a league hands the writer only the items since that league's previous digest, and a league without one those of the last seven days", async () => {
  const sources = savedSourcesAhead();
  const [redraft, dynasty] = sources[URLS.leagues] as unknown[];
  const outbound = fakeOutboundHttp(sources);
  // Week 5's digest goes out on the Monday morning, to the redraft league
  // alone.
  const previous = new Date("2030-10-14T12:00:00Z");
  sources[URLS.leagues] = [redraft];
  atWeek(sources, 5);
  await triggerScheduledRun(previous.toISOString());

  sources[URLS.leagues] = [redraft, dynasty];
  atWeek(sources, 6);
  const now = new Date("2030-10-15T16:00:00Z");
  await triggerScheduledRun(now.toISOString());

  const [, redraftMaterial, dynastyMaterial] = outbound.writerCalls.map(
    ({ material }) => material
  );
  expect(redraftMaterial.league.name).toBe("Duffy Redraft");
  expect(redraftMaterial.sourceItems).not.toEqual([]);
  expect(earliestItem(redraftMaterial).getTime()).toBeGreaterThanOrEqual(
    previous.getTime()
  );
  // The dynasty league had no previous digest, so its window is wider.
  expect(dynastyMaterial.league.name).toBe("Joel is the GOAT");
  expect(earliestItem(dynastyMaterial).getTime()).toBeLessThan(
    previous.getTime()
  );
  expect(earliestItem(dynastyMaterial).getTime()).toBeGreaterThanOrEqual(
    now.getTime() - WEEK_MS
  );
});

it("a preview stores nothing in the history and does not move the news window, which it shares with the automatic digest", async () => {
  const sources = savedSourcesAhead();
  const outbound = fakeOutboundHttp(sources);
  const previous = new Date("2030-10-14T12:00:00Z");
  atWeek(sources, 5);
  await triggerScheduledRun(previous.toISOString());
  atWeek(sources, 6);

  setClock("2030-10-15T15:00:00Z");
  await deliverTelegramUpdate(textMessage("/preview"));
  await triggerScheduledRun("2030-10-15T16:00:00Z");

  // Handed to the writer for the preview, then for the automatic digest.
  const materials = outbound.writerCalls
    .slice(2)
    .map(({ material }) => material);
  expect(materials).toHaveLength(4);
  for (const material of materials) {
    expect(earliestItem(material).getTime()).toBeGreaterThanOrEqual(
      previous.getTime()
    );
  }
  const items = (material: WriterMaterial) => identities(material.sourceItems);
  expect(materials.slice(2).map(items)).toEqual(
    materials.slice(0, 2).map(items)
  );
  expect(
    (await storedHistory()).map(({ week, leagueName }) => [week, leagueName])
  ).toEqual([
    [5, "Duffy Redraft"],
    [5, "Joel is the GOAT"],
    [6, "Duffy Redraft"],
    [6, "Joel is the GOAT"]
  ]);
});

it("when the database is over 800 MB after a digest is stored, the oldest digests are deleted until it is under", async () => {
  const limit = 800_000_000;
  const sources = savedSourcesAhead();
  fakeOutboundHttp(sources);
  atWeek(sources, 4);
  await triggerScheduledRun("2030-10-14T12:00:00Z");
  atWeek(sources, 5);
  await triggerScheduledRun("2030-10-15T16:00:00Z");
  const digest = ({ week, leagueName }: { week: number; leagueName: string }) =>
    `${leagueName}, week ${week}`;
  const stored = (await storedHistory()).map(digest);
  expect(stored).toHaveLength(4);

  // Something besides the history has taken the database just past the limit.
  await fillDatabaseTo(limit + 1);
  atWeek(sources, 6);
  await triggerScheduledRun("2030-10-16T16:00:00Z");

  const all = [...stored, "Duffy Redraft, week 6", "Joel is the GOAT, week 6"];
  const kept = (await storedHistory()).map(digest);
  // Some are gone, all of them from the oldest, and the newest are kept.
  expect(kept.length).toBeLessThan(all.length);
  expect(kept).toEqual(all.slice(all.length - kept.length));
  expect(kept.slice(-2)).toEqual(all.slice(-2));
  expect(await databaseSize()).toBeLessThanOrEqual(limit);
});
