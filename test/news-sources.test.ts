import { expect, it } from "vitest";
import {
  deliverTelegramUpdate,
  fakeOutboundHttp,
  setClock,
  textMessage,
  triggerScheduledRun,
  type WriterMaterial,
  type WriterStandIn
} from "./harness";
import { overviewUrl, savedSources, URLS } from "./sources";

// The saved sources were read that morning, so the week before it is the news
// window these tests run in unless they say otherwise.
const TUESDAY = "2026-10-13T16:00:00Z";

/** What the writer was handed for the league of the given format on a preview. */
async function previewMaterial(
  format: "redraft" | "dynasty",
  sources: Record<string, unknown> = savedSources()
): Promise<WriterMaterial> {
  const outbound = fakeOutboundHttp(sources);
  await deliverTelegramUpdate(textMessage("/preview"));
  return outbound.writerCalls
    .map(({ material }) => material)
    .find(({ league }) => league.format === format)!;
}

it("an ESPN league news article tagged with a roster player reaches the writer as a source item about that player", async () => {
  setClock(TUESDAY);

  const dynasty = await previewMaterial("dynasty");

  // Malik Willis is tagged in the article.
  expect(dynasty.sourceItems).toContainEqual({
    id: expect.any(String),
    playerId: "8161",
    date: "Monday, October 12, 2026 at 4:34 PM PDT",
    source: "ESPN",
    link: "https://www.espn.com/nfl/story/_/id/50168959/dolphins-hafley-says-not-mulling-qb-change-entering-bye",
    text: expect.stringMatching(
      /^Dolphins' Jeff Hafley says he's not mulling QB change entering bye\n\S/
    )
  });
});

it("an article from a player's own ESPN overview reaches the writer, and a video clip does not", async () => {
  setClock(TUESDAY);

  const redraft = await previewMaterial("redraft");

  expect(redraft.sourceItems).toContainEqual({
    id: expect.any(String),
    playerId: "3163",
    date: "Monday, October 12, 2026 at 8:42 AM PDT",
    source: "ESPN",
    link: "https://www.espn.com/fantasy/football/story/_/page/FFSundayHighLows-50160964/nfl-week-5-fantasy-football-winners-losers-injuries-rankings-more",
    text: expect.stringMatching(
      /^Week 5 winners and losers: Maye, Warren, Gibbs dominate; Taylor, Brown struggle\nDrake Maye, /
    )
  });
  // Jared Goff's overview also lists clips of his touchdowns that week.
  expect(
    redraft.sourceItems.filter(({ link }) => link.includes("/video/clip/"))
  ).toEqual([]);
});

it("the Rotowire note in a player's overview reaches the writer, unless an ESPN injury report already says the same", async () => {
  setClock(TUESDAY);
  const sources = savedSources();
  // Jared Goff has an ESPN ID in Sleeper, so he is matched without a report.
  const injuries = sources[URLS.injuries] as {
    injuries: { injuries: { athlete: { displayName: string } }[] }[];
  };
  for (const team of injuries.injuries) {
    team.injuries = team.injuries.filter(
      ({ athlete }) => athlete.displayName !== "Jared Goff"
    );
  }

  const redraft = await previewMaterial("redraft", sources);

  expect(
    redraft.sourceItems.filter(({ source }) => source === "Rotowire")
  ).toEqual([
    {
      id: expect.any(String),
      playerId: "3163",
      date: "Sunday, October 11, 2026 at 6:29 PM PDT",
      source: "Rotowire",
      link: "https://www.espn.com/nfl/player/_/id/3046779",
      text: expect.stringMatching(
        /^Goff completed 19 of 30 passes .* The Lions offense got off to /
      )
    }
  ]);
});

it("a ProFootballTalk entry that names a roster player reaches the writer as a source item about that player", async () => {
  setClock(TUESDAY);

  const dynasty = await previewMaterial("dynasty");

  expect(
    dynasty.sourceItems.filter(({ source }) => source === "ProFootballTalk")
  ).toEqual([
    {
      id: expect.any(String),
      playerId: "8161",
      date: "Monday, October 12, 2026 at 8:11 PM PDT",
      source: "ProFootballTalk",
      link: "https://www.nbcsports.com/nfl/profootballtalk/rumor-mill/news/dolphins-coach-jeff-hafley-isnt-considering-benching-qb-malik-willis",
      text: expect.stringMatching(
        /^Dolphins coach Jeff Hafley isn't considering benching QB Malik Willis\n\S/
      )
    }
  ]);
});

it("a ProFootballTalk entry that names a player in the possessive, or with a suffix Sleeper leaves out, is still about that player", async () => {
  setClock(TUESDAY);
  const sources = savedSources();
  const entry = (title: string, slug: string) => `<item>
      <title>${title}</title>
      <link>https://www.nbcsports.com/nfl/profootballtalk/rumor-mill/news/${slug}</link>
      <description><![CDATA[Bears &amp; Lions news.]]></description>
      <pubDate>Tue, 13 Oct 2026 09:00:00 -0400</pubDate>
    </item>`;
  sources[URLS.proFootballTalk] = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>profootballtalk</title>
    ${entry("Jared Goff&#39;s contract is restructured", "goff")}
    ${entry("Lions QB Jared Goff\u2014who sat out&#99999999;\u2014is back", "goff-back")}
    ${entry("Luther Burden III returns to practice", "burden")}
    ${entry("Jared Goffman signs with the Bears", "goffman")}
</channel></rss>`;

  const redraft = await previewMaterial("redraft", sources);

  expect(
    redraft.sourceItems
      .filter(({ source }) => source === "ProFootballTalk")
      .map(({ playerId, text }) => ({ playerId, text }))
  ).toEqual([
    {
      playerId: "3163",
      text: "Jared Goff's contract is restructured\nBears & Lions news."
    },
    {
      playerId: "3163",
      text: "Lions QB Jared Goff\u2014who sat out&#99999999;\u2014is back\nBears & Lions news."
    },
    {
      playerId: "12519",
      text: "Luther Burden III returns to practice\nBears & Lions news."
    }
  ]);
});

it("every source item handed to the writer has a player reference, date, text, link and source name, and all four sources are among them", async () => {
  setClock(TUESDAY);
  const outbound = fakeOutboundHttp(savedSources());

  await deliverTelegramUpdate(textMessage("/preview"));

  const items = outbound.writerCalls.flatMap(
    ({ material }) => material.sourceItems
  );
  for (const item of items) {
    expect(item).toEqual({
      id: expect.stringMatching(/^\d+$/),
      playerId: expect.stringMatching(/./),
      date: expect.stringMatching(/, 2026 at \d+:\d\d [AP]M PDT$/),
      text: expect.stringMatching(/\S/),
      link: expect.stringMatching(/^https:\/\//),
      source: expect.stringMatching(/^(ESPN|ProFootballTalk)$/)
    });
  }
  const linkedTo = (pattern: RegExp) =>
    items.filter(({ link }) => pattern.test(link)).length;
  expect(linkedTo(/espn\.com\/nfl\/player\//)).toBeGreaterThan(0);
  expect(linkedTo(/espn\.com\/.*\/story\//)).toBeGreaterThan(0);
  expect(linkedTo(/nbcsports\.com\/nfl\/profootballtalk\//)).toBeGreaterThan(0);
});

it("items from the new sources that are dated before the news window are not handed to the writer", async () => {
  // Monday 19 October 2026, 9:00 AM Pacific, so the window opens a week
  // before: after the article Jared Goff is tagged in, which is from 8:42 AM
  // that day, and before the one about Malik Willis from that afternoon.
  setClock("2026-10-19T16:00:00Z");
  const outbound = fakeOutboundHttp(savedSources());

  await deliverTelegramUpdate(textMessage("/preview"));

  const links = outbound.writerCalls.flatMap(({ material }) =>
    material.sourceItems.map(({ link }) => link)
  );
  expect(links).not.toContain(
    "https://www.espn.com/fantasy/football/story/_/page/FFSundayHighLows-50160964/nfl-week-5-fantasy-football-winners-losers-injuries-rankings-more"
  );
  expect(links).toContain(
    "https://www.espn.com/nfl/story/_/id/50168959/dolphins-hafley-says-not-mulling-qb-change-entering-bye"
  );
  expect(links).toContain(
    "https://www.nbcsports.com/nfl/profootballtalk/rumor-mill/news/dolphins-coach-jeff-hafley-isnt-considering-benching-qb-malik-willis"
  );

  // A week after the feed was read, nothing in it is inside the window.
  setClock("2026-10-21T16:00:00Z");
  await deliverTelegramUpdate(textMessage("/preview"));
  expect(
    outbound.writerCalls
      .slice(2)
      .flatMap(({ material }) => material.sourceItems)
      .filter(({ source }) => source === "ProFootballTalk")
  ).toEqual([]);
});

/**
 * The saved sources with every one of my 43 roster players resolved to an
 * ESPN record, so that each of them has a page of their own to read. The six
 * that ESPN has no report on are given an ESPN ID and an empty overview.
 */
function sourcesWithEveryPlayerMatched() {
  const sources = savedSources();
  const players = sources[URLS.players] as Record<
    string,
    Record<string, unknown>
  >;
  ["SEA", "DET", "10226", "12484", "12496", "13349"].forEach((id, index) => {
    const espnId = String(9000001 + index);
    players[id].espn_id = espnId;
    sources[overviewUrl(espnId)] = { news: [], rotowire: null };
  });
  return sources;
}

const isOverview = (url: string) => url.endsWith("/overview");

it("a run covering 43 roster players reads every player's overview without making more than 50 outbound requests in one invocation, and sends one league message per league", async () => {
  const outbound = fakeOutboundHttp(sourcesWithEveryPlayerMatched());

  // Saturday 19 October 2030, 6:00 PM Pacific.
  await triggerScheduledRun("2030-10-20T01:00:00Z");

  expect(new Set(outbound.requests.filter(isOverview)).size).toBe(43);
  expect(outbound.requests.filter(isOverview)).toHaveLength(43);
  expect(Math.max(...outbound.requestsPerInvocation)).toBeLessThanOrEqual(50);
  // The run did not fit in one invocation.
  expect(
    outbound.requestsPerInvocation.reduce((sum, count) => sum + count)
  ).toBeGreaterThan(50);
  expect(
    outbound.telegramMessages.map(
      (message) => (message as { text: string }).text.split("\n")[0]
    )
  ).toEqual(["<b>Duffy Redraft</b>", "<b>Joel is the GOAT</b>"]);
});

it("/preview covering 43 roster players stays within 50 outbound requests in one invocation too", async () => {
  setClock(TUESDAY);
  const outbound = fakeOutboundHttp(sourcesWithEveryPlayerMatched());

  await deliverTelegramUpdate(textMessage("/preview"));

  expect(outbound.requests.filter(isOverview)).toHaveLength(43);
  expect(Math.max(...outbound.requestsPerInvocation)).toBeLessThanOrEqual(50);
  expect(outbound.telegramMessages).toHaveLength(2);
});

it("/preview produces the same content as the automatic run at that moment, apart from its marker", async () => {
  const instant = "2026-10-18T01:00:00Z";
  const writer: WriterStandIn = (material) => ({
    needsDecision: [],
    stillUnresolved: [],
    // One entry per player with news, citing everything about them.
    otherNews: [...new Set(material.sourceItems.map((item) => item.playerId))]
      .slice(0, 5)
      .map((playerId) => ({
        playerId,
        status: "none",
        text: "Something happened.",
        sourceItemIds: material.sourceItems
          .filter((item) => item.playerId === playerId)
          .map((item) => item.id)
      }))
  });
  const outbound = fakeOutboundHttp(savedSources(), { writer });
  setClock(instant);
  await deliverTelegramUpdate(textMessage("/preview"));

  await triggerScheduledRun(instant);

  const [previewRedraft, previewDynasty, redraft, dynasty] =
    outbound.telegramMessages.map(
      (message) => (message as { text: string }).text
    );
  expect(previewRedraft).toMatch(/^<b>Preview · Duffy Redraft<\/b>/);
  expect(previewDynasty).toMatch(/^<b>Preview · Joel is the GOAT<\/b>/);
  expect(redraft).toBe(previewRedraft.replace("Preview · ", ""));
  expect(dynasty).toBe(previewDynasty.replace("Preview · ", ""));
  const materials = outbound.writerCalls.map(({ material }) => material);
  expect(materials.slice(2)).toEqual(materials.slice(0, 2));
});

it("an automatic run whose source fails once is taken up again, and still sends exactly one league message per league", async () => {
  const sources: Record<string, unknown> = savedSources();
  const overview = sources[overviewUrl("4242512")];
  let failures = 0;
  // Malik Willis's overview is unavailable the first time it is read.
  sources[overviewUrl("4242512")] = () =>
    failures++ === 0
      ? new Response("Service Unavailable", { status: 503 })
      : overview;
  const outbound = fakeOutboundHttp(sources);

  await triggerScheduledRun("2030-10-20T01:00:00Z");

  expect(failures).toBe(2);
  expect(
    outbound.telegramMessages.map(
      (message) => (message as { text: string }).text.split("\n")[0]
    )
  ).toEqual(["<b>Duffy Redraft</b>", "<b>Joel is the GOAT</b>"]);
  expect(Math.max(...outbound.requestsPerInvocation)).toBeLessThanOrEqual(50);
});

it("a player ESPN has no page for under the ESPN ID Sleeper gives is still covered by the other sources", async () => {
  setClock(TUESDAY);
  const sources = savedSources();
  // Sleeper has an ESPN ID for Malik Willis that ESPN no longer uses, and
  // ESPN has no injury report on him.
  (sources[URLS.players] as Record<string, Record<string, unknown>>)[
    "8161"
  ].espn_id = 1;
  const injuries = sources[URLS.injuries] as {
    injuries: { injuries: { athlete: { displayName: string } }[] }[];
  };
  for (const team of injuries.injuries) {
    team.injuries = team.injuries.filter(
      ({ athlete }) => athlete.displayName !== "Malik Willis"
    );
  }
  sources[overviewUrl("1")] = () => new Response("Not Found", { status: 404 });

  const dynasty = await previewMaterial("dynasty", sources);

  expect(
    dynasty.sourceItems
      .filter(({ playerId }) => playerId === "8161")
      .map(({ source }) => source)
  ).toEqual(["ProFootballTalk"]);
});
