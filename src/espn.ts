// The ESPN client: the schedule of one NFL week and the league's injury
// reports. ESPN's endpoints are unofficial, so only the fields read here are
// relied on.
import type { NflState } from "./sleeper";

const NFL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const SCOREBOARD = `${NFL}/scoreboard`;
const INJURIES = `${NFL}/injuries`;

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

export type WeekSchedule = {
  /** The teams with no game this week, as Sleeper abbreviates them. */
  teamsOnBye: string[];
};

type Scoreboard = {
  week?: { teamsOnBye?: { abbreviation: string }[] };
};

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
  const response = await fetch(`${SCOREBOARD}?${query}`);
  if (!response.ok) {
    throw new Error(`ESPN scoreboard returned ${response.status}`);
  }
  const scoreboard = await response.json<Scoreboard>();
  return {
    // ESPN leaves the list out in a week without byes.
    teamsOnBye: (scoreboard.week?.teamsOnBye ?? []).map(
      ({ abbreviation }) => SLEEPER_TEAM[abbreviation] ?? abbreviation
    )
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
  const response = await fetch(INJURIES);
  if (!response.ok) {
    throw new Error(`ESPN injuries returned ${response.status}`);
  }
  const { injuries: teams = [] } = await response.json<Injuries>();
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
