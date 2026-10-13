// The ESPN scoreboard: the schedule of one NFL week. ESPN's endpoints are
// unofficial, so only the fields read here are relied on.
import type { NflState } from "./sleeper";

const SCOREBOARD =
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

// ESPN numbers the parts of a season.
const SEASON_TYPES: Record<string, string> = {
  pre: "1",
  regular: "2",
  post: "3"
};

// Where ESPN abbreviates a team differently from Sleeper.
const SLEEPER_TEAM: Record<string, string> = { WSH: "WAS" };

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
