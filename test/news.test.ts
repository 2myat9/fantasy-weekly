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

// The saved ESPN injuries were read that morning, so the week before it is the
// news window these tests run in.
const TUESDAY = "2026-10-13T16:00:00Z";

/** The texts of the Telegram messages sent, in order. */
function texts(messages: unknown[]) {
  return messages.map((message) => (message as { text: string }).text);
}

/** One player's record in the saved Sleeper player file. */
function sleeperPlayer(
  sources: ReturnType<typeof savedSources>,
  playerId: string
) {
  const players = sources[URLS.players] as Record<
    string,
    Record<string, unknown>
  >;
  return players[playerId];
}

/** The ID the writer was given for the source item about a player. */
function itemAbout(material: WriterMaterial, playerId: string) {
  return material.sourceItems.find((item) => item.playerId === playerId)!.id;
}

it("the writer's sections follow the lineup check under their headings, in order, ahead of the players it did not cover and those that could not be checked", async () => {
  setClock(TUESDAY);
  const writer: WriterStandIn = (material) =>
    material.league.format === "dynasty"
      ? {
          needsDecision: [
            {
              playerId: "12481",
              status: "questionable",
              text: "Limited in practice with a shoulder injury; Ray Davis is your bench option at RB.",
              sourceItemIds: [itemAbout(material, "12481")]
            }
          ],
          stillUnresolved: [
            {
              playerId: "7021",
              status: "out",
              text: "Ruled out <again> & not close.",
              sourceItemIds: [itemAbout(material, "7021")]
            }
          ],
          otherNews: [
            {
              playerId: "12641",
              status: "none",
              text: "Moved to injured reserve.",
              sourceItemIds: [itemAbout(material, "12641")]
            },
            {
              playerId: "8161",
              status: "cleared",
              text: "Started and finished the game.",
              sourceItemIds: [itemAbout(material, "8161")]
            }
          ]
        }
      : { needsDecision: [], stillUnresolved: [], otherNews: [] };
  const outbound = await fakeSavedSources(savedSources(), { writer });

  await deliverTelegramUpdate(textMessage("/preview"));

  expect(texts(outbound.telegramMessages)[1]).toBe(
    [
      "<b>Preview · Joel is the GOAT</b>",
      "Dynasty · Week 6",
      "",
      "<b>Lineup check</b>",
      "🔴 REC FLEX <b>KC Concepcion</b> (CLE) is ruled out",
      "🔴 DEF <b>Detroit Lions</b> (DET) is on bye",
      "",
      "<b>Needs a decision</b>",
      '🟡 <b>Cam Skattebo</b>: Limited in practice with a shoulder injury; Ray Davis is your bench option at RB. (<a href="https://www.fantasypros.com/nfl/news/613372/cam-skattebo-leads-backfield-week-5-tie.php">FantasyPros, Oct 11</a>)',
      "",
      "<b>Still unresolved, check before kickoff</b>",
      '🔴 <b>Rico Dowdle</b>: Ruled out &lt;again&gt; &amp; not close. (<a href="https://www.espn.com/nfl/player/_/id/4038815/rico-dowdle">ESPN, Oct 12</a>)',
      "",
      "<b>Other news on your roster</b>",
      '⚪ <b>Jaylin Lane</b>: Moved to injured reserve. (<a href="https://www.fantasypros.com/nfl/news/612506/jaylin-lane-ankle-placed-on-ir.php">FantasyPros, Oct 6</a>)',
      '🟢 <b>Malik Willis</b>: Started and finished the game. (<a href="https://www.nbcsports.com/nfl/profootballtalk/rumor-mill/news/dolphins-coach-jeff-hafley-isnt-considering-benching-qb-malik-willis">ProFootballTalk, Oct 12</a>)',
      "",
      "<b>No significant news</b>",
      "Jalen Hurts, Omarion Hampton, Garrett Wilson, Bhayshul Tuten, Parker Washington, Makai Lemon, Trevor Lawrence, Chris Boswell, Detroit Lions, Andrei Iosivas, Ray Davis, Theo Johnson, Brian Thomas, Terrance Ferguson, Eli Stowers, James Conner, Greg Dortch, Jake Ferguson, Marvin Mims, Kayshon Boutte, Jayden Higgins, Tai Felton, Kyle Williams",
      "",
      "<b>Couldn't check</b>",
      "KC Concepcion"
    ].join("\n")
  );
});

it("the writer is called once per league, with only that league's roster players and their opponent's, and only source items inside the news window", async () => {
  setClock(TUESDAY);
  const outbound = await fakeSavedSources(savedSources());

  await deliverTelegramUpdate(textMessage("/preview"));

  expect(outbound.writerCalls.map(({ model }) => model)).toEqual([
    "claude-sonnet-5-5",
    "claude-sonnet-5-5"
  ]);
  const [redraft, dynasty] = outbound.writerCalls
    .map(({ material }) => material)
    .sort((a, b) => b.league.format.localeCompare(a.league.format));
  expect(redraft.league).toEqual({ name: "Duffy Redraft", format: "redraft" });
  expect(redraft.week).toBe(6);
  const onRoster = ({ roster }: WriterMaterial) =>
    new Set(roster.map(({ playerId }) => playerId));
  for (const material of [redraft, dynasty]) {
    const inLeague = new Set([
      ...onRoster(material),
      ...material.opponent.map(({ playerId }) => playerId)
    ]);
    expect(
      material.sourceItems.filter((item) => !inLeague.has(item.playerId))
    ).toEqual([]);
  }
  // The roster players with an ESPN injury report inside the window, in
  // roster order: those Sleeper has the ESPN ID of. A kicker's report on a
  // game played is not handed over, and a defense's is on a player of the
  // offense it faces.
  const reportedOn = (material: WriterMaterial) =>
    material.sourceItems
      .filter(
        ({ link, playerId }) =>
          link.includes("espn.com/nfl/player/") &&
          onRoster(material).has(playerId)
      )
      .map((item) => item.playerId);
  expect(reportedOn(redraft)).toEqual(["3163", "SEA", "5947"]);
  // James Conner's and Greg Dortch's reports are older than a week.
  expect(reportedOn(dynasty)).toEqual(["6904", "7021"]);
  expect(dynasty.sourceItems).toContainEqual({
    id: expect.any(String),
    playerId: "7021",
    date: "Monday, October 12, 2026 at 1:07 PM PDT",
    source: "ESPN",
    link: "https://www.espn.com/nfl/player/_/id/4038815/rico-dowdle",
    text: expect.stringMatching(/^ESPN status: Out\. Steelers offensive /)
  });
});

it("the writer is handed the roster with each player's slot, including bench, IR and taxi-squad players", async () => {
  setClock(TUESDAY);
  const outbound = await fakeSavedSources(savedSources());

  await deliverTelegramUpdate(textMessage("/preview"));

  const dynasty = outbound.writerCalls.find(
    ({ material }) => material.league.format === "dynasty"
  )!.material;
  expect(dynasty.roster).toHaveLength(28);
  expect(dynasty.roster).toContainEqual({
    playerId: "13298",
    name: "KC Concepcion",
    position: "WR",
    team: "CLE",
    slot: "REC_FLEX",
    sleeperStatus: "Out",
    decisionCandidate: true,
    gameKickedOff: false
  });
  const slotOf = (playerId: string) =>
    dynasty.roster.find((spot) => spot.playerId === playerId)!.slot;
  expect(slotOf("7021")).toBe("BN");
  expect(slotOf("12484")).toBe("IR");
  expect(slotOf("12641")).toBe("TAXI");
});

it("the writer's instructions restrict it to the supplied material, require citations, prefer the most recent report and limit advice to what the news triggers", async () => {
  setClock(TUESDAY);
  const outbound = await fakeSavedSources(savedSources());

  await deliverTelegramUpdate(textMessage("/preview"));

  const { instructions } = outbound.writerCalls[0];
  expect(instructions).toContain("Use only the supplied source items.");
  expect(instructions).toContain("do not add anything from your own memory");
  expect(instructions).toContain(
    "Every entry must list in sourceItemIds the ID of each source item it draws on."
  );
  expect(instructions).toContain(
    "shown to the manager as a link with its date"
  );
  expect(instructions).toContain("Prefer the most recent report.");
  expect(instructions).toContain("Give advice only when the news triggers it");
  expect(instructions).toContain("Never rank players");
});

it("a player with an ESPN ID in Sleeper is matched by that ID, whatever name Sleeper has", async () => {
  setClock(TUESDAY);
  const sources = savedSources();
  sleeperPlayer(sources, "3163").full_name = "J. Goff";
  const outbound = await fakeSavedSources(sources);

  await deliverTelegramUpdate(textMessage("/preview"));

  const [redraft] = outbound.writerCalls
    .map(({ material }) => material)
    .filter(({ league }) => league.format === "redraft");
  expect(redraft.sourceItems[0]).toMatchObject({
    playerId: "3163",
    link: "https://www.espn.com/nfl/player/_/id/3046779/jared-goff"
  });
});

it("a player without an ESPN ID in Sleeper is not matched to ESPN's injury reports by name", async () => {
  setClock(TUESDAY);
  const outbound = await fakeSavedSources();

  await deliverTelegramUpdate(textMessage("/preview"));

  const [redraft] = outbound.writerCalls
    .map(({ material }) => material)
    .filter(({ league }) => league.format === "redraft");
  // ESPN reports on Luther Burden III, whom Sleeper has no ESPN ID for.
  expect(
    redraft.sourceItems.filter(
      (item) => item.playerId === "12519" && item.source === "ESPN"
    )
  ).toEqual([]);
  expect(
    redraft.sourceItems.filter(
      (item) => item.playerId === "3163" && item.source === "ESPN"
    )[0].link
  ).toBe("https://www.espn.com/nfl/player/_/id/3046779/jared-goff");
});

it("a player FantasyPros cannot resolve, or resolves to a player of another team, is unmatched and gets no FantasyPros items, and a player with no team in Sleeper is matched without the check", async () => {
  setClock(TUESDAY);
  const sources = savedSources();
  // Sleeper has Rashid Shaheed as a free agent.
  sleeperPlayer(sources, "8676").team = null;
  const injuryStatus = savedInjuryStatus();
  // FantasyPros resolves the name Drake Maye to a player of another team. It
  // writes Jacksonville, Jakobi Meyers' team, as JAC, where Sleeper has JAX.
  injuryStatus.resolved_players.find(
    ({ input }) => input === "Drake Maye"
  )!.team_id = "BUF";
  const outbound = await fakeSavedSources(sources, { injuryStatus });

  await deliverTelegramUpdate(textMessage("/preview"));

  const [redraft] = outbound.writerCalls
    .map(({ material }) => material)
    .filter(({ league }) => league.format === "redraft");
  const fromFantasyPros = (playerId: string) =>
    redraft.sourceItems.filter(
      (item) => item.playerId === playerId && item.source === "FantasyPros"
    );
  expect(fromFantasyPros("11564")).toEqual([]);
  expect(fromFantasyPros("5947")).toHaveLength(1);
  expect(fromFantasyPros("8676")).toHaveLength(1);
  // The unmatched players are not reported as having no news. FantasyPros
  // could not resolve KC Concepcion, on the dynasty roster.
  const [redraftText, dynastyText] = texts(outbound.telegramMessages);
  expect(redraftText).toMatch(/<b>Couldn't check<\/b>\nDrake Maye$/);
  expect(redraftText).not.toMatch(/No significant news<\/b>\n.*Drake Maye/);
  expect(dynastyText).toMatch(/<b>Couldn't check<\/b>\nKC Concepcion$/);
});

it("an entry about a player with no source item, or about a player who is not on the roster, is left out, and a player appears once", async () => {
  setClock(TUESDAY);
  const writer: WriterStandIn = (material) => {
    if (material.league.format !== "redraft") {
      return { needsDecision: [], stillUnresolved: [], otherNews: [] };
    }
    const goff = itemAbout(material, "3163");
    return {
      needsDecision: [
        {
          // Alec Pierce has no source item inside the news window.
          playerId: "8142",
          status: "out",
          text: "Nothing to verify this against.",
          sourceItemIds: ["999"]
        },
        {
          playerId: "6904", // Jalen Hurts, on my dynasty roster only
          status: "out",
          text: "Not my player here.",
          sourceItemIds: [goff]
        },
        {
          playerId: "3163",
          status: "cleared",
          text: "Good to go.",
          sourceItemIds: [goff, "999"]
        }
      ],
      stillUnresolved: [
        {
          playerId: "3163",
          status: "questionable",
          text: "Said twice.",
          sourceItemIds: [goff]
        }
      ],
      otherNews: [
        {
          // The citation is not one of the items handed over.
          playerId: "9509",
          status: "questionable",
          text: "Limited in practice.",
          sourceItemIds: ["999"]
        }
      ]
    };
  };
  const outbound = await fakeSavedSources(savedSources(), { writer });

  await deliverTelegramUpdate(textMessage("/preview"));

  expect(texts(outbound.telegramMessages)[0].split("\n").slice(7)).toEqual([
    "",
    "<b>Needs a decision</b>",
    '🟢 <b>Jared Goff</b>: Good to go. (<a href="https://www.espn.com/nfl/player/_/id/3046779/jared-goff">ESPN, Oct 11</a>)',
    "",
    "<b>Other news on your roster</b>",
    // Shown with the items about the player in place of the bad citation.
    '🟡 <b>Bijan Robinson</b>: Limited in practice. (<a href="https://www.fantasypros.com/nfl/news/613465/bijan-robinson-totals-118-yards-on-21-touches-week-5.php">FantasyPros, Oct 12</a>)',
    "",
    "<b>No significant news</b>",
    "Jeremiyah Love, Denzel Boston, Matthew Golden, Trey McBride, Sam LaPorta, Bucky Irving, Jake Bates, Seattle Seahawks, Drake Maye, Luther Burden, Jakobi Meyers, Alec Pierce, Rashid Shaheed"
  ]);
});

it("with no source items inside the news window the writer is not called, and every player is still listed", async () => {
  // Years after the saved reports were written.
  setClock("2030-10-13T16:00:00Z");
  const outbound = await fakeSavedSources(savedSources());

  await deliverTelegramUpdate(textMessage("/preview"));

  expect(outbound.writerCalls).toEqual([]);
  expect(texts(outbound.telegramMessages)[0].split("\n").slice(7)).toEqual([
    "",
    "<b>No significant news</b>",
    "Jared Goff, Bijan Robinson, Jeremiyah Love, Denzel Boston, Matthew Golden, Trey McBride, Sam LaPorta, Bucky Irving, Jake Bates, Seattle Seahawks, Drake Maye, Luther Burden, Jakobi Meyers, Alec Pierce, Rashid Shaheed"
  ]);
});

it("the automatic digest carries the news sections too", async () => {
  const writer: WriterStandIn = (material) => ({
    needsDecision: [],
    stillUnresolved: [],
    otherNews: [
      {
        playerId: material.sourceItems[0].playerId,
        status: "none",
        text: "Something happened.",
        sourceItemIds: [material.sourceItems[0].id]
      }
    ]
  });
  const outbound = await fakeSavedSources(savedSourcesAhead(), { writer });

  // Saturday 19 October 2030, 6:00 PM Pacific, the Saturday after the saved
  // ESPN injuries as they are moved forward.
  await triggerScheduledRun("2030-10-20T01:00:00Z");

  expect(outbound.writerCalls).toHaveLength(2);
  expect(texts(outbound.telegramMessages)[0]).toContain(
    [
      "<b>Other news on your roster</b>",
      '⚪ <b>Jared Goff</b>: Something happened. (<a href="https://www.espn.com/nfl/player/_/id/3046779/jared-goff">ESPN, Oct 13</a>)'
    ].join("\n")
  );
});
