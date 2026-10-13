// The writer: one Claude call per league that turns the source items about a
// roster and its opponent into the model-written sections of the league
// message. It returns
// structured entries, not message text, so that the composer controls the
// formatting and every citation is a link the writer was actually handed.
import Anthropic from "@anthropic-ai/sdk";
import type { SourceItem } from "./news";
import type { League, Player, RosterSpot } from "./sleeper";

const MODEL = "claude-sonnet-5-5";

/** How a player stands for this week, shown as the entry's marker. */
export type Status = "out" | "questionable" | "cleared" | "none";

/** What the writer says about one player. */
export type Entry = {
  playerId: string;
  status: Status;
  text: string;
  /** The source items the text draws on, from those handed to the writer. */
  sources: SourceItem[];
};

/** What the writer says about this week's opponent. */
export type OpponentNote = {
  text: string;
  /** The source items the text draws on, from those about the opponent's players. */
  sources: SourceItem[];
};

export type Sections = {
  needsDecision: Entry[];
  stillUnresolved: Entry[];
  otherNews: Entry[];
  /** Null when nothing about the opponent is notable. */
  opponentNote: OpponentNote | null;
};

const SECTIONS = ["needsDecision", "stillUnresolved", "otherNews"] as const;

export const NO_SECTIONS: Sections = {
  needsDecision: [],
  stillUnresolved: [],
  otherNews: [],
  opponentNote: null
};

// The slots a player cannot be started from.
const NOT_STARTABLE = new Set(["IR", "TAXI"]);

const INSTRUCTIONS = `You write the news sections of a weekly fantasy football digest for one manager's roster in one league. The manager reads it on their phone on Saturday evening to set their lineup for Sunday's NFL games.

You are given JSON with the league and its format, the NFL week, today's date, the manager's roster, the roster of this week's opponent and the source items gathered about the players on both. Each player has the slot they are placed in: a starting slot such as QB or FLEX, BN for the bench, IR, or TAXI for the taxi squad. Each player on the manager's roster also has decisionCandidate, which is false when the manager cannot act on them this week: their game has already kicked off (gameKickedOff), or they are on IR or the taxi squad.

Rules, which exist so that the manager can trust every line:
- Use only the supplied source items. They are the only news you know: do not add anything from your own memory about players, teams, injuries or schedules, even if you are confident of it. If the items say nothing notable about a player, leave the player out; they are then listed as having no significant news.
- Cite your sources. Every entry must list in sourceItemIds the ID of each source item it draws on. Each cited item is shown to the manager as a link with its date, so do not write links, dates of reports or source names into the text yourself. An entry that cites no supplied item may be discarded.
- Prefer the most recent report. When items about a player conflict, go by the latest one and do not repeat the older claim.
- Give advice only when the news triggers it, and only from the roster you were given: for example, when a starter is out or doubtful, name the manager's bench player at the same position who could replace them. Never rank players, project points or suggest a change the news does not call for.

Place each player on the manager's roster that you write about in at most one section:
- needsDecision: the news calls for the manager to act on this week's lineup, such as a starter who is out or doubtful, or a bench player who should now be considered because of news. Only for players with decisionCandidate true.
- stillUnresolved: the player's status for this week is still open, such as questionable or a game-time decision, and the manager should check again before kickoff. Only for players with decisionCandidate true.
- otherNews: anything else worth knowing that does not change this week's lineup. This is where longer-term items go, such as a depth-chart change, a rookie's growing role or a move to injured reserve, and it is the only section for a player with decisionCandidate false.

A routine recap of a healthy player's last game is not significant news; leave that player out.

Some players are covered in a particular way:
- A player whose game has kicked off: the items you are given about them are from kickoff onwards. Write about them only if they were hurt in that game, so that the manager knows for next week.
- A team defense: its items are reports on absent players of the offense it faces this week, each starting with "Opposing offense". Write about the defense only when an absence is notable enough to make the matchup clearly easier or harder, such as a starting quarterback or a leading back or receiver, and name who is missing.
- A kicker: write only about an injury to the kicker or a threat to the kicker's job. Leave the kicker out otherwise.

Do not write entries about the opponent's players. Instead, set opponentNote: two or three short lines, separated by line breaks, on notable injuries or absences among the players the opponent is starting or would be expected to start, each naming the player. Draw only on the source items about the opponent's players and list their IDs in its sourceItemIds. When nothing about the opponent is notable, set its text to an empty string and its sourceItemIds to an empty list.

For each entry set status to "out" (will not play), "questionable" (may not play), "cleared" (was in doubt and is now set to play) or "none" (no injury designation is involved). Write text as plain text without markup, in one or two short sentences. Do not start it with the player's name, which is shown in front of it.`;

// Times are given to the writer as the manager reads them, in Pacific time,
// so that "today" and the day of a report agree with the manager's.
const pacific = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short"
});

const entries = {
  type: "array",
  items: {
    type: "object",
    properties: {
      playerId: { type: "string" },
      status: {
        type: "string",
        enum: ["out", "questionable", "cleared", "none"]
      },
      text: { type: "string" },
      sourceItemIds: { type: "array", items: { type: "string" } }
    },
    required: ["playerId", "status", "text", "sourceItemIds"],
    additionalProperties: false
  }
};

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    needsDecision: entries,
    stillUnresolved: entries,
    otherNews: entries,
    opponentNote: {
      type: "object",
      properties: {
        text: { type: "string" },
        sourceItemIds: { type: "array", items: { type: "string" } }
      },
      required: ["text", "sourceItemIds"],
      additionalProperties: false
    }
  },
  required: [...SECTIONS, "opponentNote"],
  additionalProperties: false
};

type WrittenEntry = {
  playerId: string;
  status: Status;
  text: string;
  sourceItemIds: string[];
};

/**
 * Writes the model-written sections for one league from the source items
 * about its roster and its opponent's. Entries come back only for roster
 * players, each with at least one of the given items as its source, and a
 * player appears once. A player whose game has kicked off, or who is on IR or
 * the taxi squad, comes back only under other news. Dates in the material are
 * in Pacific time.
 */
export async function writeSections(
  apiKey: string,
  {
    league,
    week,
    roster,
    kickedOff,
    opponent,
    players,
    items
  }: {
    league: League;
    week: number;
    roster: RosterSpot[];
    /** The roster players whose game this week has kicked off. */
    kickedOff: Set<string>;
    /** This week's opponent roster. */
    opponent: RosterSpot[];
    players: Map<string, Player>;
    items: SourceItem[];
  }
): Promise<Sections> {
  const itemsById = new Map(
    items.map((item, index) => [String(index + 1), item])
  );
  // A player Sleeper's directory does not know cannot be described.
  const described = (spots: RosterSpot[]) =>
    spots.flatMap(({ playerId, slot }) => {
      const player = players.get(playerId);
      if (!player) return [];
      return {
        playerId,
        name: player.name,
        position: player.position,
        team: player.team,
        slot,
        sleeperStatus: player.injuryStatus
      };
    });
  const material = {
    league: { name: league.name, format: league.format },
    week,
    today: pacific.format(new Date()),
    roster: described(roster).map((player) => {
      const gameKickedOff = kickedOff.has(player.playerId);
      return {
        ...player,
        gameKickedOff,
        decisionCandidate: !gameKickedOff && !NOT_STARTABLE.has(player.slot)
      };
    }),
    opponent: described(opponent),
    sourceItems: [...itemsById].map(([id, item]) => ({
      id,
      playerId: item.playerId,
      date: pacific.format(item.date),
      source: item.source,
      link: item.link,
      text: item.text
    }))
  };

  // The SDK takes a failed call again itself, after a pause: a connection
  // error, a rate limit or a server error, this many times.
  // Each attempt is given up after a few minutes, so that all of them end
  // within the 15 minutes an invocation may last and a model that does not
  // answer leaves time for the message to go out without the sections.
  const client = new Anthropic({
    apiKey,
    maxRetries: 2,
    timeout: 4 * 60 * 1000
  });
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: OUTPUT_SCHEMA }
    },
    // If a safety classifier declines the request by mistake, it is run
    // again on the model Anthropic recommends for that case.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: INSTRUCTIONS,
    messages: [{ role: "user", content: JSON.stringify(material) }]
  });
  if (response.stop_reason !== "end_turn") {
    throw new Error(`The writer stopped with ${response.stop_reason}`);
  }
  const text = response.content.find((block) => block.type === "text");
  if (!text) throw new Error("The writer returned no text");
  const written = JSON.parse(text.text) as Record<
    (typeof SECTIONS)[number],
    WrittenEntry[]
  > & { opponentNote?: { text: string; sourceItemIds: string[] } | null };

  const onRoster = new Set(material.roster.map(({ playerId }) => playerId));
  const candidates = new Set(
    material.roster.flatMap(({ playerId, decisionCandidate }) =>
      decisionCandidate ? playerId : []
    )
  );
  // The placement rules are not left to the model: what it wrote in a
  // decision section about a player the user cannot decide on is other news.
  const decisions = (entries: WrittenEntry[]) =>
    entries.filter(({ playerId }) => candidates.has(playerId));
  const misplaced = [
    ...written.needsDecision,
    ...written.stillUnresolved
  ].filter(({ playerId }) => !candidates.has(playerId));
  const covered = new Set<string>();
  const kept = (entries: WrittenEntry[]) =>
    entries.flatMap(({ playerId, status, text, sourceItemIds }) => {
      if (!onRoster.has(playerId) || covered.has(playerId)) return [];
      let sources = sourceItemIds.flatMap((id) => itemsById.get(id) ?? []);
      // An entry whose citations are not among the items is shown with the
      // items about its player, so that a flagged player is not then listed
      // as having no news.
      if (sources.length === 0) {
        sources = items.filter((item) => item.playerId === playerId);
      }
      // With no item to verify it against, the entry is not shown.
      if (sources.length === 0) return [];
      covered.add(playerId);
      return { playerId, status, text, sources };
    });
  // The note stands on items about the opponent's players, like an entry on
  // items about its own, and is not shown without one.
  const onOpponent = new Set(material.opponent.map(({ playerId }) => playerId));
  // The note is optional, so a response without one still gives the sections.
  const noteText = written.opponentNote?.text.trim() ?? "";
  const noteSources = [...new Set(written.opponentNote?.sourceItemIds)]
    .flatMap((id) => itemsById.get(id) ?? [])
    .filter((item) => onOpponent.has(item.playerId));
  return {
    needsDecision: kept(decisions(written.needsDecision)),
    stillUnresolved: kept(decisions(written.stillUnresolved)),
    // After the model's own, so what it wrote for other news is preferred.
    otherNews: kept([...written.otherNews, ...misplaced]),
    opponentNote:
      noteText && noteSources.length > 0
        ? { text: noteText, sources: noteSources }
        : null
  };
}
