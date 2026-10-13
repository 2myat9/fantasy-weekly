// The news about a set of players: source items gathered from the news
// sources, each tied to the Sleeper player it is about. The sources shared by
// all players are read first, then the own page at ESPN of each player on the
// user's rosters, a batch at a time, because there are more players than one
// invocation may make requests.
import {
  gameOf,
  fetchInjuryReports,
  fetchLeagueNews,
  fetchPlayerOverview,
  type InjuryReport,
  type WeekSchedule
} from "./espn";
import { fetchProFootballTalk } from "./pft";
import type { Player } from "./sleeper";

/** One dated piece of material about a player, with its link. */
export type SourceItem = {
  /** The Sleeper ID of the player the item is about. */
  playerId: string;
  date: Date;
  text: string;
  link: string;
  /** The name of the source, as cited in the digest. */
  source: string;
};

/** A player whose own page at ESPN is still to be read. */
export type Lookup = { playerId: string; espnId: string };

/** The news gathered so far, and what is left to gather. */
export type Gathering = {
  /** The items dated at or after the start of the news window. */
  items: SourceItem[];
  /**
   * The players that could not be resolved to an ESPN record. Nothing is
   * known about them, which is not the same as their having no news.
   */
  unmatched: Set<string>;
  /** Empty once the news is complete. */
  lookups: Lookup[];
};

// Where a player's page at ESPN is, before the ID.
const PLAYER_PAGE = "https://www.espn.com/nfl/player/_/id";

// Sleeper's position for a team defense.
const DEFENSE = "DEF";
// The positions of an offense, as ESPN abbreviates them.
const OFFENSE = new Set(["QB", "RB", "FB", "WR", "TE", "OT", "G", "C", "OL"]);
// ESPN's designation for a player who is fit to play.
const ACTIVE = "Active";

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

// A name as both sources would write it: no accents, punctuation or
// generational suffix, so "Luther Burden III" and "Luther Burden" agree.
function normaliseName(name: string) {
  return name
    .normalize("NFD")
    .toLowerCase()
    .replaceAll("-", " ")
    .replaceAll(/[^a-z ]/g, "")
    .split(" ")
    .filter((word) => word && !SUFFIXES.has(word))
    .join(" ");
}

function nameKey(name: string, team: string | null, position: string | null) {
  return `${normaliseName(name)}|${team}|${position}`;
}

// Whether a text names the player. ProFootballTalk does not tag its entries
// with players, so the full name is all there is to go by. A team defense is
// left out, because its name is the team's and would claim all the team's
// news.
function names(text: string, player: Player) {
  const name = normaliseName(player.name);
  if (player.position === DEFENSE || !name.includes(" ")) return false;
  // Without the possessive, so "Goff's" reads as "Goff", and with anything
  // that separates words turned into a space, so that they are not joined.
  const words = normaliseName(
    text.replaceAll(/['’]s\b/g, "").replaceAll(/[^\p{L}'’.\- ]/gu, " ")
  );
  return ` ${words} `.includes(` ${name} `);
}

// Adds to the items the articles about a player that are inside the news
// window. The same article can come from more than one source, and is kept
// once.
function addArticles(
  items: SourceItem[],
  windowStart: Date,
  playerId: string,
  source: string,
  articles: { date: Date; text: string; link: string }[]
) {
  for (const { date, text, link } of articles) {
    if (date < windowStart) continue;
    const have = items.some(
      (item) => item.playerId === playerId && item.link === link
    );
    if (!have) items.push({ playerId, date, text, link, source });
  }
}

/**
 * Gathers the news on the given players since the start of the news window
 * from the sources shared by all players. A player is resolved to an ESPN
 * record by ESPN ID when Sleeper has one, otherwise by normalised name, team
 * and position. A team defense has no record of its own: one on the user's
 * rosters is covered by ESPN's reports on the absent players of the offense
 * it faces this week, and is unmatched when its game is not on the schedule.
 * Only the players in `ownPages` are left with their own page at ESPN to read:
 * the rest, the opponents' players, are covered by the shared sources alone,
 * which keeps a run to the same number of requests.
 */
export async function gatherSharedNews({
  players,
  ownPages,
  schedule,
  windowStart
}: {
  players: Player[];
  ownPages: Set<string>;
  schedule: WeekSchedule;
  windowStart: Date;
}): Promise<Gathering> {
  const [reports, leagueNews, feed] = await Promise.all([
    fetchInjuryReports(),
    fetchLeagueNews(),
    fetchProFootballTalk()
  ]);
  const byEspnId = new Map<string, InjuryReport[]>();
  const byName = new Map<string, InjuryReport[]>();
  const add = (
    index: Map<string, InjuryReport[]>,
    key: string,
    report: InjuryReport
  ) => index.set(key, [...(index.get(key) ?? []), report]);
  for (const report of reports) {
    add(byEspnId, report.espnId, report);
    add(byName, nameKey(report.name, report.team, report.position), report);
  }

  const items: SourceItem[] = [];
  const unmatched = new Set<string>();
  // The resolved players by their ESPN ID.
  const resolved = new Map<string, string>();
  const lookups: Lookup[] = [];
  for (const player of players) {
    if (player.position === DEFENSE) {
      // An opponent's defense is not covered: the offense it faces is not on
      // the opponent's roster.
      if (!ownPages.has(player.id)) continue;
      const facing = gameOf(schedule, player.team)?.teams.find(
        (team) => team !== player.team
      );
      // On bye there is no offense to check. Otherwise a defense whose game
      // is missing from the schedule could not be checked.
      if (!facing && !schedule.teamsOnBye.includes(player.team ?? "")) {
        unmatched.add(player.id);
      }
      for (const report of reports) {
        if (
          !facing ||
          report.team !== facing ||
          // A report without a designation is a note, not an absence.
          !report.status ||
          report.status === ACTIVE ||
          !OFFENSE.has(report.position ?? "") ||
          report.date < windowStart
        ) {
          continue;
        }
        items.push({
          playerId: player.id,
          date: report.date,
          text: `Opposing offense: ${report.name} (${report.position}, ${report.team}). ESPN status: ${report.status}. ${report.text}`,
          link: report.link,
          source: "ESPN"
        });
      }
      continue;
    }
    // With an ESPN ID the player is resolved even when ESPN has no report on
    // them. Without one, a report found by name is the only ESPN record
    // there is, so a player with none cannot be told from a failed match.
    // The name is also tried when the ID finds nothing, in case Sleeper's
    // ID is out of date.
    const found =
      (player.espnId ? byEspnId.get(player.espnId) : undefined) ??
      byName.get(nameKey(player.name, player.team, player.position)) ??
      (player.espnId ? [] : undefined);
    if (!found) {
      unmatched.add(player.id);
      continue;
    }
    // A report carries the ID ESPN uses now.
    const espnId = found[0]?.espnId ?? player.espnId;
    if (espnId) {
      resolved.set(espnId, player.id);
      if (ownPages.has(player.id)) {
        lookups.push({ playerId: player.id, espnId });
      }
    }
    for (const report of found) {
      if (report.date < windowStart) continue;
      items.push({
        playerId: player.id,
        date: report.date,
        text: report.status
          ? `ESPN status: ${report.status}. ${report.text}`
          : report.text,
        link: report.link,
        source: "ESPN"
      });
    }
  }

  for (const { espnIds, ...article } of leagueNews) {
    for (const espnId of espnIds) {
      const playerId = resolved.get(espnId);
      if (playerId)
        addArticles(items, windowStart, playerId, "ESPN", [article]);
    }
  }
  for (const { title, summary, date, link } of feed) {
    const text = summary ? `${title}\n${summary}` : title;
    for (const player of players) {
      if (!names(`${title} ${summary}`, player)) continue;
      addArticles(items, windowStart, player.id, "ProFootballTalk", [
        { date, text, link }
      ]);
    }
  }
  return { items, unmatched, lookups };
}

/**
 * Reads the own pages of the next players waiting for it, at most `limit` of
 * them with one request each, and returns the gathering with their news added.
 */
export async function gatherPlayerNews(
  gathering: Gathering,
  windowStart: Date,
  limit: number
): Promise<Gathering> {
  const lookups = gathering.lookups.slice(0, limit);
  const overviews = await Promise.all(
    lookups.map(({ espnId }) => fetchPlayerOverview(espnId))
  );
  const items = [...gathering.items];
  lookups.forEach(({ playerId, espnId }, index) => {
    const { articles, note } = overviews[index];
    addArticles(items, windowStart, playerId, "ESPN", articles);
    // ESPN's injury report on a player is usually this same note.
    const reported =
      note &&
      items.some(
        (item) => item.playerId === playerId && item.text.includes(note.text)
      );
    if (note && !reported && note.date >= windowStart) {
      items.push({
        playerId,
        date: note.date,
        text: note.text,
        link: `${PLAYER_PAGE}/${espnId}`,
        source: "Rotowire"
      });
    }
  });
  return { ...gathering, items, lookups: gathering.lookups.slice(limit) };
}
