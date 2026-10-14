import { expect, it } from "vitest";
import {
  deliverTelegramUpdate,
  setClock,
  textMessage,
  triggerScheduledRun,
  type WriterMaterial,
  type WriterStandIn
} from "./harness";
import {
  fakeSavedSources,
  savedInjuryStatus,
  savedSources,
  savedSourcesAhead,
  URLS
} from "./sources";

// The saved sources were read that morning, so the week before it is the news
// window these tests run in unless they say otherwise.
const TUESDAY = "2026-10-13T16:00:00Z";

/**
 * The saved sources, with the ESPN ID of Malik Willis, whom Sleeper has none
 * for, so that ESPN's news can be matched to him.
 */
function sourcesWithWillisEspnId() {
  const sources = savedSources();
  (sources[URLS.players] as Record<string, Record<string, unknown>>)[
    "8161"
  ].espn_id = 4242512;
  return sources;
}

/** What the writer was handed for the league of the given format on a preview. */
async function previewMaterial(
  format: "redraft" | "dynasty",
  sources: Record<string, unknown> = savedSources()
): Promise<WriterMaterial> {
  const outbound = await fakeSavedSources(sources);
  await deliverTelegramUpdate(textMessage("/preview"));
  return outbound.writerCalls
    .map(({ material }) => material)
    .find(({ league }) => league.format === format)!;
}

it("FantasyPros' news on a roster player reaches the writer as source items about that player, also when FantasyPros writes the name with a suffix", async () => {
  setClock(TUESDAY);
  const outbound = await fakeSavedSources();

  await deliverTelegramUpdate(textMessage("/preview"));

  const redraft = outbound.writerCalls
    .map(({ material }) => material)
    .find(({ league }) => league.format === "redraft")!;
  const fromFantasyPros = (playerId: string) =>
    redraft.sourceItems.filter(
      (item) => item.playerId === playerId && item.source === "FantasyPros"
    );
  // FantasyPros calls him Luther Burden III. His item from 4 October is
  // before the news window.
  expect(fromFantasyPros("12519")).toEqual([
    {
      id: expect.any(String),
      playerId: "12519",
      date: "Sunday, October 11, 2026 at 3:04 PM PDT",
      source: "FantasyPros",
      link: "https://www.fantasypros.com/nfl/news/613281/luther-burden-iii-leads-underwhelming-passing-offense-week-5-loss.php",
      text: expect.stringMatching(/^Luther Burden III .*\n\S/s)
    }
  ]);
  expect(fromFantasyPros("3163").map(({ link }) => link)).toEqual([
    "https://www.fantasypros.com/nfl/news/613494/jared-goff-scores-four-touchdowns-win-sunday.php"
  ]);
});

it("FantasyPros news items without their own link are each linked to the player's news page at fantasypros.com", async () => {
  setClock(TUESDAY);
  const injuryStatus = savedInjuryStatus();
  for (const item of injuryStatus.player_news) {
    if (["Luther Burden III", "Cam Skattebo"].includes(item.player_name)) {
      (item as { url: string | null }).url = null;
    }
  }
  const outbound = await fakeSavedSources(savedSources(), { injuryStatus });

  await deliverTelegramUpdate(textMessage("/preview"));

  const items = outbound.writerCalls.flatMap(
    ({ material }) => material.sourceItems
  );
  const fromFantasyPros = (playerId: string) =>
    items.filter(
      (item) => item.playerId === playerId && item.source === "FantasyPros"
    );
  expect(fromFantasyPros("12519").map(({ link }) => link)).toEqual([
    "https://www.fantasypros.com/nfl/news/luther-burden-iii.php"
  ]);
  // Cam Skattebo has four items inside the news window.
  expect(
    fromFantasyPros("12481").map(({ link, date }) => [link, date])
  ).toEqual([
    [
      "https://www.fantasypros.com/nfl/news/cam-skattebo.php",
      "Sunday, October 11, 2026 at 7:04 PM PDT"
    ],
    [
      "https://www.fantasypros.com/nfl/news/cam-skattebo.php",
      "Friday, October 9, 2026 at 10:43 AM PDT"
    ],
    [
      "https://www.fantasypros.com/nfl/news/cam-skattebo.php",
      "Thursday, October 8, 2026 at 1:26 PM PDT"
    ],
    [
      "https://www.fantasypros.com/nfl/news/cam-skattebo.php",
      "Wednesday, October 7, 2026 at 1:46 PM PDT"
    ]
  ]);
});

it("a run makes one call to FantasyPros, with the names of my roster players as Sleeper writes them and none of the team defenses or opponents' players, and no request for a player's own page at ESPN", async () => {
  const outbound = await fakeSavedSources();

  // Saturday 19 October 2030, 6:00 PM Pacific.
  await triggerScheduledRun("2030-10-20T01:00:00Z");

  expect(outbound.fantasyPros.toolCalls).toEqual([
    {
      name: "injury_status",
      arguments: {
        // The players on both rosters, in the order the run reads them.
        player_names: expect.any(String)
      },
      accessToken: expect.any(String)
    }
  ]);
  const names = (
    outbound.fantasyPros.toolCalls[0].arguments as { player_names: string }
  ).player_names.split(", ");
  expect(names).toHaveLength(41);
  expect(names).toEqual(
    expect.arrayContaining(["Luther Burden", "KC Concepcion", "Jared Goff"])
  );
  // A team defense, and players on the opponents' rosters only.
  expect(names).not.toContain("Seattle Seahawks");
  expect(names).not.toContain("Detroit Lions");
  expect(names).not.toContain("Chris Rodriguez");
  expect(names).not.toContain("Kirk Cousins");
  expect(outbound.requests.filter((url) => url.includes("/athletes/"))).toEqual(
    []
  );
  expect(outbound.telegramMessages).toHaveLength(2);
  expect(Math.max(...outbound.requestsPerInvocation)).toBeLessThanOrEqual(50);
});

it("an ESPN league news article tagged with a roster player Sleeper has the ESPN ID of reaches the writer as a source item about that player", async () => {
  setClock(TUESDAY);

  const dynasty = await previewMaterial("dynasty", sourcesWithWillisEspnId());

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

it("a ProFootballTalk entry that names a roster player reaches the writer as a source item about that player", async () => {
  setClock(TUESDAY);

  const dynasty = await previewMaterial("dynasty");

  const onRoster = new Set(dynasty.roster.map(({ playerId }) => playerId));
  expect(
    dynasty.sourceItems.filter(
      ({ source, playerId }) =>
        source === "ProFootballTalk" && onRoster.has(playerId)
    )
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

it("every source item handed to the writer has a player reference, date, text, link and source name, and all the sources are among them", async () => {
  setClock(TUESDAY);
  const outbound = await fakeSavedSources(savedSources());

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
      source: expect.stringMatching(/^(ESPN|ProFootballTalk|FantasyPros)$/)
    });
  }
  const linkedTo = (pattern: RegExp) =>
    items.filter(({ link }) => pattern.test(link)).length;
  expect(linkedTo(/espn\.com\/nfl\/player\//)).toBeGreaterThan(0);
  expect(linkedTo(/espn\.com\/.*\/story\//)).toBeGreaterThan(0);
  expect(linkedTo(/nbcsports\.com\/nfl\/profootballtalk\//)).toBeGreaterThan(0);
  expect(
    linkedTo(/^https:\/\/www\.fantasypros\.com\/nfl\/news\//)
  ).toBeGreaterThan(0);
});

it("items from the news sources that are dated before the news window are not handed to the writer", async () => {
  // Monday 19 October 2026, 9:00 AM Pacific, so the window opens a week
  // before: after FantasyPros' item on Malik Willis from 7:34 AM that day, and
  // before its next one, ESPN's article and ProFootballTalk's entry on him,
  // all from later that day.
  setClock("2026-10-19T16:00:00Z");
  const outbound = await fakeSavedSources(sourcesWithWillisEspnId());

  await deliverTelegramUpdate(textMessage("/preview"));

  const links = outbound.writerCalls.flatMap(({ material }) =>
    material.sourceItems.map(({ link }) => link)
  );
  expect(links).not.toContain(
    "https://www.fantasypros.com/nfl/news/613469/malik-willis-loses-three-turnovers-loss-sunday.php"
  );
  expect(links).toContain(
    "https://www.fantasypros.com/nfl/news/613546/malik-willis-dolphins-not-considering-benching-qb.php"
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

it("/preview produces the same content as the automatic run at that moment, apart from its marker", async () => {
  // Saturday 19 October 2030, 6:00 PM Pacific, with the saved ESPN injuries
  // moved forward to the week before.
  const instant = "2030-10-20T01:00:00Z";
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
  const outbound = await fakeSavedSources(savedSourcesAhead(), { writer });
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
