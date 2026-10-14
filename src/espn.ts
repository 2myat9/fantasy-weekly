// The ESPN client: the schedule of one NFL week, the league's injury reports
// and the league's news. ESPN's endpoints are unofficial, so only the fields
// read here are relied on.
import { retried } from "./retry";
import type { NflState } from "./sleeper";

const NFL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const SCOREBOARD = `${NFL}/scoreboard`;
const INJURIES = `${NFL}/injuries`;
// The most ESPN returns, which is about a day of articles.
const NEWS = `${NFL}/news?limit=50`;

// ESPN numbers the parts of a season.
const SEASON_TYPES: Record<string, string> = {
  pre: "1",
  regular: "2",
  post: "3"
};

// Where ESPN abbreviates a team differently from Sleeper.
const SLEEPER_TEAM: Record<string, string> = { WSH: "WAS" };
// Where ESPN abbreviates a position differently from Sleeper.
const SLEEPER_POSITION: Record<string, string> = { PK: "K" };

// What ESPN answers a read with, as JSON. `what` names the read in the error.
async function readJson<T>(url: string, what: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`ESPN ${what} returned ${response.status}`);
  }
  return response.json<T>();
}

/** One game of an NFL week. */
export type Game = {
  /** The two teams, as Sleeper abbreviates them. */
  teams: string[];
  kickoff: Date;
};

export type WeekSchedule = {
  /** The teams with no game this week, as Sleeper abbreviates them. */
  teamsOnBye: string[];
  games: Game[];
};

type Scoreboard = {
  week?: { teamsOnBye?: { abbreviation: string }[] };
  events?: {
    date?: string;
    competitions?: {
      competitors?: { team?: { abbreviation?: string } }[];
    }[];
  }[];
};

/** What is known of a week whose schedule could not be read: nothing. */
export const NO_SCHEDULE: WeekSchedule = { teamsOnBye: [], games: [] };

/** The game a team plays in the week, if it has one. */
export function gameOf(schedule: WeekSchedule, team: string | null) {
  return team === null
    ? undefined
    : schedule.games.find((game) => game.teams.includes(team));
}

export async function fetchWeekSchedule(nfl: NflState): Promise<WeekSchedule> {
  const seasonType = SEASON_TYPES[nfl.seasonType];
  if (!seasonType) {
    throw new Error(`No NFL schedule for season type ${nfl.seasonType}`);
  }
  const query = new URLSearchParams({
    dates: nfl.season,
    seasontype: seasonType,
    week: String(nfl.week)
  });
  const scoreboard = await retried(() =>
    readJson<Scoreboard>(`${SCOREBOARD}?${query}`, "scoreboard")
  );
  const sleeperTeam = (abbreviation: string) =>
    SLEEPER_TEAM[abbreviation] ?? abbreviation;
  return {
    // ESPN leaves the list out in a week without byes.
    teamsOnBye: (scoreboard.week?.teamsOnBye ?? []).map(({ abbreviation }) =>
      sleeperTeam(abbreviation)
    ),
    games: (scoreboard.events ?? []).flatMap((event) => {
      const kickoff = new Date(event.date ?? "");
      const teams = (event.competitions?.[0]?.competitors ?? []).flatMap(
        ({ team }) => (team?.abbreviation ? sleeperTeam(team.abbreviation) : [])
      );
      // A game without a time or its two teams says nothing usable.
      return isNaN(kickoff.getTime()) || teams.length !== 2
        ? []
        : { teams, kickoff };
    })
  };
}

/**
 * ESPN's latest report on one player. Despite the endpoint's name, most
 * reports are about healthy players: each is a dated note on the player's
 * last game or current status.
 */
export type InjuryReport = {
  espnId: string;
  name: string;
  // As Sleeper abbreviates them.
  team: string | null;
  position: string | null;
  /** ESPN's designation, such as `Active`, `Questionable` or `Out`. */
  status: string;
  date: Date;
  text: string;
  /** The player's page at ESPN. */
  link: string;
};

type Injuries = {
  injuries?: {
    injuries?: {
      status?: string;
      date?: string;
      shortComment?: string;
      longComment?: string;
      athlete?: {
        displayName?: string;
        links?: { rel?: string[]; href?: string }[];
        position?: { abbreviation?: string };
        team?: { abbreviation?: string };
      };
    }[];
  }[];
};

/** The latest report on every player ESPN has one for, across all teams. */
export async function fetchInjuryReports(): Promise<InjuryReport[]> {
  const { injuries: teams = [] } = await retried(() =>
    readJson<Injuries>(INJURIES, "injuries")
  );
  const reports: InjuryReport[] = [];
  for (const report of teams.flatMap((team) => team.injuries ?? [])) {
    const athlete = report.athlete;
    const link = athlete?.links?.find((link) =>
      link.rel?.includes("playercard")
    )?.href;
    // The report carries the player's ESPN ID only inside the link.
    const espnId = link?.match(/\/id\/(\d+)/)?.[1];
    const date = new Date(report.date ?? "");
    // A report that cannot be dated or linked cannot be cited.
    if (!athlete?.displayName || !link || !espnId || isNaN(date.getTime())) {
      continue;
    }
    const team = athlete.team?.abbreviation;
    const position = athlete.position?.abbreviation;
    reports.push({
      espnId,
      name: athlete.displayName,
      team: team ? (SLEEPER_TEAM[team] ?? team) : null,
      position: position ? (SLEEPER_POSITION[position] ?? position) : null,
      status: report.status ?? "",
      date,
      text: [report.shortComment, report.longComment].filter(Boolean).join(" "),
      link
    });
  }
  return reports;
}

/** One article at ESPN. */
export type Article = {
  date: Date;
  /** The headline, and the summary under it when there is one. */
  text: string;
  link: string;
};

type EspnArticle = {
  type?: string;
  headline?: string;
  description?: string;
  published?: string;
  links?: { web?: { href?: string } };
  categories?: { type?: string; athleteId?: number }[];
};

function article(raw: EspnArticle): Article | null {
  // A video clip has a caption and nothing to read.
  if (raw.type === "Media") return null;
  const date = new Date(raw.published ?? "");
  const link = raw.links?.web?.href;
  // An article that cannot be dated or linked cannot be cited.
  if (!raw.headline || !link || isNaN(date.getTime())) return null;
  const summary = raw.description?.trim();
  return {
    date,
    text:
      summary && summary !== raw.headline
        ? `${raw.headline}\n${summary}`
        : raw.headline,
    link
  };
}

/** The league's latest articles, each with the ESPN IDs of the players it is tagged with. */
export async function fetchLeagueNews(): Promise<
  (Article & { espnIds: string[] })[]
> {
  const { articles = [] } = await retried(() =>
    readJson<{ articles?: EspnArticle[] }>(NEWS, "news")
  );
  return articles.flatMap((raw) => {
    const read = article(raw);
    if (!read) return [];
    const espnIds = (raw.categories ?? []).flatMap(({ type, athleteId }) =>
      type === "athlete" && athleteId ? [String(athleteId)] : []
    );
    return { ...read, espnIds };
  });
}
