// The news about a set of players: source items gathered from the news
// sources, each tied to the Sleeper player it is about. The sources shared by
// all players are read first, then FantasyPros' news on the players on the
// user's rosters, in a step of its own: a call to FantasyPros can take up to
// seven requests, each attempt.
import {
  gameOf,
  fetchInjuryReports,
  fetchLeagueNews,
  type InjuryReport,
  type WeekSchedule
} from "./espn";
import type { PlayerNewsRead } from "./fantasypros";
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

/** The news gathered so far, and what is left to gather. */
export type Gathering = {
  /** The items dated at or after the start of the news window. */
  items: SourceItem[];
  /**
   * The players that could not be matched to their news source. Nothing is
   * known about them, which is not the same as their having no news.
   */
  unmatched: Set<string>;
  /**
   * The players on the user's rosters whose news at FantasyPros is still to
   * be read. Empty once the news is complete.
   */
  toLookUp: string[];
  /**
   * The sources that could not be read, as the league message names them.
   * The news was gathered without them.
   */
  missing: string[];
};

// Where FantasyPros has a player's news, before the player's name.
const PLAYER_NEWS = "https://www.fantasypros.com/nfl/news";

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

// What a source returned, or null when it could not be read: the news is then
// gathered without it, so that one source does not cost the whole digest.
async function orNull<T>(read: () => Promise<T>) {
  try {
    return await read();
  } catch (error) {
    console.error("A news source could not be read", error);
    return null;
  }
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
 * from the sources shared by all players. A player is resolved to ESPN's
 * reports and news by the ESPN ID Sleeper has for them, and has none from
 * ESPN without one. A team defense has no record of its own: one on the
 * user's rosters is covered by ESPN's reports on the absent players of the
 * offense it faces this week, and is unmatched when its game is not on the
 * schedule. The players in `mine`, those on the user's rosters, are left to
 * be looked up at FantasyPros, team defenses aside; the opponents' players
 * are covered by the shared sources alone. A source that cannot be read is
 * named in `missing` and the news is gathered from the others.
 */
export async function gatherSharedNews({
  players,
  mine,
  schedule,
  windowStart
}: {
  players: Player[];
  mine: Set<string>;
  schedule: WeekSchedule;
  windowStart: Date;
}): Promise<Gathering> {
  const sources = await Promise.all([
    orNull(fetchInjuryReports),
    orNull(fetchLeagueNews),
    orNull(fetchProFootballTalk)
  ]);
  const [reports, leagueNews, feed] = sources.map((read) => read ?? []) as [
    InjuryReport[],
    Awaited<ReturnType<typeof fetchLeagueNews>>,
    Awaited<ReturnType<typeof fetchProFootballTalk>>
  ];
  const missing = ["ESPN's injury reports", "ESPN's news", "ProFootballTalk"];
  const byEspnId = new Map<string, InjuryReport[]>();
  for (const report of reports) {
    byEspnId.set(report.espnId, [
      ...(byEspnId.get(report.espnId) ?? []),
      report
    ]);
  }

  const items: SourceItem[] = [];
  const unmatched = new Set<string>();
  // The players with an ESPN ID, by that ID.
  const resolved = new Map<string, string>();
  const toLookUp: string[] = [];
  for (const player of players) {
    if (player.position === DEFENSE) {
      // An opponent's defense is not covered: the offense it faces is not on
      // the opponent's roster.
      if (!mine.has(player.id)) continue;
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
    if (mine.has(player.id)) toLookUp.push(player.id);
    if (!player.espnId) continue;
    resolved.set(player.espnId, player.id);
    for (const report of byEspnId.get(player.espnId) ?? []) {
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
  return {
    items,
    unmatched,
    toLookUp,
    missing: missing.filter((_, index) => sources[index] === null)
  };
}

// The player's news page at fantasypros.com, for an item without its own
// link. FantasyPros names the page after the player.
function playerNewsPage(name: string) {
  const slug = name
    .normalize("NFD")
    .toLowerCase()
    .replaceAll(/[^a-z0-9 -]/g, "")
    .trim()
    .replaceAll(/\s+/g, "-");
  return `${PLAYER_NEWS}/${slug}.php`;
}

/**
 * Reads FantasyPros' news on the players still to be looked up there, in
 * one call made by `read` with their names as Sleeper writes them, and
 * returns the gathering with their news added. A player is unmatched when FantasyPros
 * cannot resolve their name, or resolves it to a player of another team: a
 * name two players share resolves to the better known of them. A player with
 * no team in Sleeper is matched without the check. When FantasyPros cannot be
 * read, it is named in `missing`, and the news is complete without it.
 */
export async function gatherPlayerNews(
  gathering: Gathering,
  players: Map<string, Player>,
  windowStart: Date,
  read: (names: string[]) => Promise<PlayerNewsRead>
): Promise<Gathering> {
  const lookedUp = gathering.toLookUp.flatMap(
    (playerId) => players.get(playerId) ?? []
  );
  const done = { ...gathering, toLookUp: [] };
  const outcome = await orNull(() =>
    read([...new Set(lookedUp.map(({ name }) => name))])
  );
  const unmatched = new Set(gathering.unmatched);
  if (outcome?.status !== "connected") {
    // Without FantasyPros, a player ESPN cannot reach by ID was looked up
    // nowhere.
    for (const player of lookedUp) {
      if (!player.espnId) unmatched.add(player.id);
    }
    const why =
      outcome === null
        ? ""
        : outcome.status === "lost"
          ? " (the sign-in was lost, send /connect)"
          : " (not connected, send /connect)";
    return {
      ...done,
      unmatched,
      missing: [...done.missing, `FantasyPros' news${why}`]
    };
  }
  const { resolved, unresolved, news } = outcome.news;
  // FantasyPros echoes each name as it was sent, but is not relied on to
  // keep its case or spacing.
  const key = (name: string) => name.trim().toLowerCase();
  const unresolvedKeys = new Set(unresolved.map(key));
  // The Sleeper players each of FantasyPros' names stands for.
  const byName = new Map<string, string[]>();
  for (const player of lookedUp) {
    const match = resolved.find(({ input }) => key(input) === key(player.name));
    if (
      !match ||
      unresolvedKeys.has(key(player.name)) ||
      (player.team !== null && match.team !== player.team)
    ) {
      unmatched.add(player.id);
      continue;
    }
    byName.set(match.name, [...(byName.get(match.name) ?? []), player.id]);
  }
  const items = [...gathering.items];
  for (const { playerName, date, text, link } of news) {
    for (const playerId of byName.get(playerName) ?? []) {
      if (link) {
        addArticles(items, windowStart, playerId, "FantasyPros", [
          { date, text, link }
        ]);
      } else if (date >= windowStart) {
        // Every item without a link of its own shares the player's page, so
        // it is not taken for an article already added.
        items.push({
          playerId,
          date,
          text,
          link: playerNewsPage(playerName),
          source: "FantasyPros"
        });
      }
    }
  }
  return { ...done, items, unmatched };
}
