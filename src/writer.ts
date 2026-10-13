// The writer: one Claude call per league that turns the source items about a
// roster into the model-written sections of the league message. It returns
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

export type Sections = {
  needsDecision: Entry[];
  stillUnresolved: Entry[];
  otherNews: Entry[];
};

const SECTIONS = ["needsDecision", "stillUnresolved", "otherNews"] as const;

export const NO_SECTIONS: Sections = {
  needsDecision: [],
  stillUnresolved: [],
  otherNews: []
};

const INSTRUCTIONS = `You write the news sections of a weekly fantasy football digest for one manager's roster in one league. The manager reads it on their phone on Saturday evening to set their lineup for Sunday's NFL games.

You are given JSON with the league and its format, the NFL week, today's date, the manager's roster (each player with the slot they are placed in: a starting slot such as QB or FLEX, BN for the bench, IR, or TAXI for the taxi squad) and the source items gathered about those players.

Rules, which exist so that the manager can trust every line:
- Use only the supplied source items. They are the only news you know: do not add anything from your own memory about players, teams, injuries or schedules, even if you are confident of it. If the items say nothing notable about a player, leave the player out; they are then listed as having no significant news.
- Cite your sources. Every entry must list in sourceItemIds the ID of each source item it draws on. Each cited item is shown to the manager as a link with its date, so do not write links, dates of reports or source names into the text yourself. An entry that cites no supplied item may be discarded.
- Prefer the most recent report. When items about a player conflict, go by the latest one and do not repeat the older claim.
- Give advice only when the news triggers it, and only from the roster you were given: for example, when a starter is out or doubtful, name the manager's bench player at the same position who could replace them. Never rank players, project points or suggest a change the news does not call for.

Place each player you write about in at most one section:
- needsDecision: the news calls for the manager to act on this week's lineup, such as a starter who is out or doubtful, or a bench player who should now be considered because of news.
- stillUnresolved: the player's status for this week is still open, such as questionable or a game-time decision, and the manager should check again before kickoff.
- otherNews: anything else worth knowing that does not change this week's lineup, including longer-term items such as a changed role or a move to injured reserve.

A routine recap of a healthy player's last game is not significant news; leave that player out.

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
    otherNews: entries
  },
  required: [...SECTIONS],
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
 * about its roster. Entries come back only for roster players, each with at
 * least one of the given items as its source, and a player appears once.
 * Dates in the material are in Pacific time.
 */
export async function writeSections(
  apiKey: string,
  {
    league,
    week,
    roster,
    players,
    items
  }: {
    league: League;
    week: number;
    roster: RosterSpot[];
    players: Map<string, Player>;
    items: SourceItem[];
  }
): Promise<Sections> {
  const itemsById = new Map(
    items.map((item, index) => [String(index + 1), item])
  );
  const material = {
    league: { name: league.name, format: league.format },
    week,
    today: pacific.format(new Date()),
    roster: roster.flatMap(({ playerId, slot }) => {
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
    }),
    sourceItems: [...itemsById].map(([id, item]) => ({
      id,
      playerId: item.playerId,
      date: pacific.format(item.date),
      source: item.source,
      link: item.link,
      text: item.text
    }))
  };

  const client = new Anthropic({ apiKey });
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
  >;

  const onRoster = new Set(material.roster.map(({ playerId }) => playerId));
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
  return {
    needsDecision: kept(written.needsDecision),
    stillUnresolved: kept(written.stillUnresolved),
    otherNews: kept(written.otherNews)
  };
}
