import { expect, it } from "vitest";
import {
  deliverTelegramUpdate,
  fakeOutboundHttp,
  setClock,
  textMessage,
  type WriterMaterial,
  type WriterStandIn
} from "./harness";
import { savedSources, URLS } from "./sources";

// The saved ESPN injuries were read that morning, before any game of week 6.
const TUESDAY = "2026-10-13T16:00:00Z";

/** The material the writer was handed for each league of one preview. */
async function previewMaterial(
  sources = savedSources(),
  writer?: WriterStandIn
) {
  const outbound = fakeOutboundHttp(sources, { writer });
  await deliverTelegramUpdate(textMessage("/preview"));
  const material = (format: string) =>
    outbound.writerCalls.find(
      ({ material }) => material.league.format === format
    )!.material;
  return {
    redraft: material("redraft"),
    dynasty: material("dynasty"),
    messages: outbound.telegramMessages.map(
      (message) => (message as { text: string }).text
    )
  };
}

/** The texts of the source items the writer was handed about one player. */
function itemsAbout(material: WriterMaterial, playerId: string) {
  return material.sourceItems
    .filter((item) => item.playerId === playerId)
    .map(({ text }) => text);
}

it("the writer is handed this week's opponent roster in each league, without its taxi squad, and the source items about those players", async () => {
  setClock(TUESDAY);

  const { redraft, dynasty } = await previewMaterial();

  // Roster 10 is matched up with the user's roster 9 in the redraft league.
  expect(redraft.opponent.map(({ name, slot }) => `${slot} ${name}`)).toEqual([
    "QB Tyler Shough",
    "RB Jacory Croskey-Merritt",
    "RB Bhayshul Tuten",
    "WR CeeDee Lamb",
    "WR Devaughn Vele",
    "TE Tucker Kraft",
    "FLEX Zay Flowers",
    "FLEX Kalif Raymond",
    "K Cam Little",
    "DEF Philadelphia Eagles",
    "BN Chris Rodriguez",
    "BN Woody Marks",
    "BN Jordan Love",
    "BN Breece Hall",
    "BN Quentin Johnston",
    "IR A.J. Brown"
  ]);
  expect(itemsAbout(redraft, "8155")).toEqual([
    expect.stringMatching(/^ESPN status: Out\. /)
  ]);
  // Roster 1 in the dynasty league, whose taxi squad is 13275 and 13380.
  const opponentIds = dynasty.opponent.map(({ playerId }) => playerId);
  expect(opponentIds).toHaveLength(28);
  expect(opponentIds).toContain("9756");
  expect(opponentIds).not.toContain("13275");
  expect(opponentIds).not.toContain("13380");
  expect(itemsAbout(dynasty, "9756")).toEqual([
    expect.stringMatching(/^ESPN status: Out\. /)
  ]);
});

it("the opponent note the writer returns closes the league message, with its sources, and a league without one has no such section", async () => {
  setClock(TUESDAY);
  const writer: WriterStandIn = (material) => ({
    needsDecision: [],
    stillUnresolved: [],
    otherNews: [],
    ...(material.league.format === "redraft" && {
      opponentNote: {
        text: "Breece Hall is out & CeeDee Lamb is questionable.\nQuentin Johnston is out too.",
        sourceItemIds: [
          material.sourceItems.find((item) => item.playerId === "8155")!.id,
          material.sourceItems.find((item) => item.playerId === "6786")!.id
        ]
      }
    })
  });

  const { messages } = await previewMaterial(savedSources(), writer);

  const [redraft, dynasty] = messages;
  expect(redraft.split("\n").slice(-4)).toEqual([
    "",
    "<b>Opponent note</b>",
    "Breece Hall is out &amp; CeeDee Lamb is questionable.",
    'Quentin Johnston is out too. (<a href="https://www.espn.com/nfl/player/_/id/4427366/breece-hall">ESPN, Oct 12</a>, <a href="https://www.espn.com/nfl/player/_/id/4241389/ceedee-lamb">ESPN, Oct 9</a>)'
  ]);
  expect(dynasty).not.toContain("Opponent note");
});

// The digest's hour in week 6: Seattle at Denver kicked off on Thursday
// evening, at 00:15 UTC on the 16th, and every other game is still to come.
const SATURDAY = "2026-10-18T01:00:00Z";

/** ESPN's saved injury report on one player. */
function injuryReport(sources: ReturnType<typeof savedSources>, name: string) {
  const { injuries: teams } = sources[
    "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries"
  ] as {
    injuries: {
      injuries: {
        status: string;
        date: string;
        shortComment: string;
        longComment: string;
        athlete: { displayName: string };
      }[];
    }[];
  };
  return teams
    .flatMap((team) => team.injuries)
    .find((report) => report.athlete.displayName === name)!;
}

it("a player whose game has kicked off is not a decision candidate, and the writer is handed nothing reported about them before kickoff", async () => {
  setClock(SATURDAY);

  const { redraft } = await previewMaterial();

  const spot = (playerId: string) => {
    const { decisionCandidate, gameKickedOff } = redraft.roster.find(
      (player) => player.playerId === playerId
    )!;
    return { decisionCandidate, gameKickedOff };
  };
  // Rashid Shaheed plays for Seattle. ESPN's report on him is from Monday.
  expect(spot("8676")).toEqual({
    decisionCandidate: false,
    gameKickedOff: true
  });
  expect(itemsAbout(redraft, "8676")).toEqual([]);
  // Drake Maye plays on Sunday.
  expect(spot("11564")).toEqual({
    decisionCandidate: true,
    gameKickedOff: false
  });
  expect(itemsAbout(redraft, "11564")).not.toEqual([]);
});

it("a player hurt in a game already played is handed to the writer with what was reported since kickoff, and is placed under other news whatever section the writer chose", async () => {
  setClock(SATURDAY);
  const sources = savedSources();
  Object.assign(injuryReport(sources, "Rashid Shaheed"), {
    status: "Questionable",
    date: "2026-10-16T04:30Z",
    shortComment: "Shaheed (ankle) left Thursday's game against the Broncos.",
    longComment: ""
  });
  const writer: WriterStandIn = (material) => ({
    needsDecision: material.sourceItems
      .filter((item) => item.playerId === "8676")
      .map((item) => ({
        playerId: "8676",
        status: "questionable" as const,
        text: "Left Thursday's game with an ankle injury.",
        sourceItemIds: [item.id]
      })),
    stillUnresolved: [],
    otherNews: []
  });

  const { redraft, messages } = await previewMaterial(sources, writer);

  expect(itemsAbout(redraft, "8676")).toEqual([
    "ESPN status: Questionable. Shaheed (ankle) left Thursday's game against the Broncos."
  ]);
  expect(messages[0]).not.toContain("Needs a decision");
  expect(messages[0]).toContain(
    [
      "<b>Other news on your roster</b>",
      '🟡 <b>Rashid Shaheed</b>: Left Thursday\'s game with an ankle injury. (<a href="https://www.espn.com/nfl/player/_/id/4032473/rashid-shaheed">ESPN, Oct 15</a>)'
    ].join("\n")
  );
});

it("taxi-squad and IR players are not decision candidates, and what the writer puts in a decision section about them is placed under other news", async () => {
  setClock(TUESDAY);
  const sources = savedSources();
  // Terrance Ferguson moves to an IR slot. Jaylin Lane is on the taxi squad.
  const [mine] = sources[URLS.rostersDynasty] as { reserve: string[] }[];
  mine.reserve.push("12487");
  const entry = (material: WriterMaterial, playerId: string) => ({
    playerId,
    status: "out" as const,
    text: "Will not play.",
    sourceItemIds: [
      material.sourceItems.find((item) => item.playerId === playerId)!.id
    ]
  });
  const writer: WriterStandIn = (material) =>
    material.league.format === "dynasty"
      ? {
          needsDecision: [entry(material, "12487")],
          stillUnresolved: [entry(material, "12641")],
          otherNews: []
        }
      : { needsDecision: [], stillUnresolved: [], otherNews: [] };

  const { dynasty, messages } = await previewMaterial(sources, writer);

  expect(
    dynasty.roster
      .filter(({ decisionCandidate }) => !decisionCandidate)
      .map(({ slot, name }) => `${slot} ${name}`)
  ).toEqual([
    "IR Jayden Higgins",
    "IR Terrance Ferguson",
    "TAXI Tai Felton",
    "TAXI Kyle Williams",
    "TAXI Jaylin Lane"
  ]);
  expect(messages[1]).not.toContain("Needs a decision");
  expect(messages[1]).not.toContain("Still unresolved");
  expect(messages[1]).toContain(
    [
      "<b>Other news on your roster</b>",
      '🔴 <b>Terrance Ferguson</b>: Will not play. (<a href="https://www.espn.com/nfl/player/_/id/4570037/terrance-ferguson">ESPN, Oct 7</a>)',
      '🔴 <b>Jaylin Lane</b>: Will not play. (<a href="https://www.espn.com/nfl/player/_/id/4602667/jaylin-lane">ESPN, Oct 6</a>)'
    ].join("\n")
  );
});

it("the writer is handed, for the user's team defense, ESPN's reports on the absent players of the offense it faces, and the defense counts as checked", async () => {
  setClock(TUESDAY);

  const { redraft, messages } = await previewMaterial();

  // Seattle plays at Denver. ESPN also reports four Denver defenders as out
  // or questionable, and three healthy Denver backs and receivers.
  expect(itemsAbout(redraft, "SEA")).toEqual([
    expect.stringMatching(
      /^Opposing offense: Pat Bryant \(WR, DEN\)\. ESPN status: Injured Reserve\. Bryant \(ankle\) was placed on the Broncos' injured reserve Friday\. /
    )
  ]);
  expect(messages[0]).toContain("Jake Bates, Seattle Seahawks, ");
  expect(messages[0]).not.toContain("Couldn't check");
});

it("the writer is handed, for the user's kicker, only material on an injury or on the kicker's job", async () => {
  setClock(TUESDAY);
  const sources = savedSources();
  // Chris Boswell, the dynasty kicker, is healthy: ESPN's report and
  // Rotowire's note on him recap his last game. Jake Bates, the redraft
  // kicker, is given an injury, and the league news an article on his job and
  // one that only mentions him.
  Object.assign(injuryReport(sources, "Jake Bates"), {
    status: "Questionable",
    shortComment: "Bates (groin) did not practice Monday.",
    longComment: ""
  });
  const article = (headline: string, slug: string) => ({
    type: "HeadlineNews",
    headline,
    description: headline,
    published: "2026-10-13T12:00:00Z",
    links: { web: { href: `https://www.espn.com/nfl/story/${slug}` } },
    categories: [{ type: "athlete", athleteId: 4689936 }]
  });
  (sources[URLS.leagueNews] as { articles: unknown[] }).articles.push(
    article("Lions sign kicker to practice squad behind Jake Bates", "job"),
    article("Lions' Jake Bates leads the NFL in extra points", "recap")
  );

  const { redraft, dynasty } = await previewMaterial(sources);

  expect(itemsAbout(dynasty, "1945")).toEqual([]);
  expect(itemsAbout(redraft, "11539")).toEqual([
    "ESPN status: Questionable. Bates (groin) did not practice Monday.",
    "Lions sign kicker to practice squad behind Jake Bates"
  ]);
});

it("the writer's instructions send longer-term items to other news, cover a defense through the offense it faces and a kicker through injury or job news, and ask for an opponent note only when something is notable", async () => {
  setClock(TUESDAY);
  const outbound = fakeOutboundHttp(savedSources());

  await deliverTelegramUpdate(textMessage("/preview"));

  const { instructions } = outbound.writerCalls[0];
  expect(instructions).toContain(
    "longer-term items go, such as a depth-chart change, a rookie's growing role"
  );
  expect(instructions).toContain(
    "it is the only section for a player with decisionCandidate false"
  );
  expect(instructions).toContain(
    "Write about them only if they were hurt in that game"
  );
  expect(instructions).toContain(
    "absent players of the offense it faces this week"
  );
  expect(instructions).toContain(
    "write only about an injury to the kicker or a threat to the kicker's job"
  );
  expect(instructions).toContain(
    "When nothing about the opponent is notable, set its text to an empty string"
  );
});

it("a league whose matchups cannot be read still gets its message, with no opponent handed to the writer", async () => {
  setClock(TUESDAY);
  const sources = savedSources();
  sources[URLS.matchupsRedraft] = new Response("Unavailable", { status: 503 });

  const { redraft, dynasty, messages } = await previewMaterial(sources);

  expect(redraft.opponent).toEqual([]);
  expect(dynasty.opponent).toHaveLength(28);
  expect(messages[0]).toContain("<b>Preview · Duffy Redraft</b>");
});
