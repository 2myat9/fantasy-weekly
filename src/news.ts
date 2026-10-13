// The news about a set of players: source items gathered from the news
// sources, each tied to the Sleeper player it is about. ESPN's injury reports
// are the only source so far.
import { fetchInjuryReports, type InjuryReport } from "./espn";
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

export type News = {
  /** The items dated at or after the start of the news window. */
  items: SourceItem[];
  /**
   * The players that could not be resolved to an ESPN record. Nothing is
   * known about them, which is not the same as their having no news.
   */
  unmatched: Set<string>;
};

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

/**
 * Gathers the news on the given players since the start of the news window.
 * A player is resolved to an ESPN record by ESPN ID when Sleeper has one,
 * otherwise by normalised name, team and position.
 */
export async function gatherNews(
  players: Player[],
  windowStart: Date
): Promise<News> {
  const reports = await fetchInjuryReports();
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
  for (const player of players) {
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
  return { items, unmatched };
}
