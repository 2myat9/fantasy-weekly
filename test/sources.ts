// Saved copies of what the agent reads on a run, keyed by the URL it reads
// them from. They are trimmed real responses for the user's two leagues in
// week 6 of 2026: three redraft starters are on bye, and in the dynasty league
// one starter is ruled out and the defense is on bye.
import { env } from "cloudflare:workers";
import scoreboard from "./fixtures/espn/scoreboard-2026-week-6.json";
import leagues from "./fixtures/sleeper/leagues.json";
import players from "./fixtures/sleeper/players.json";
import rostersDynasty from "./fixtures/sleeper/rosters-dynasty.json";
import rostersRedraft from "./fixtures/sleeper/rosters-redraft.json";
import stateNfl from "./fixtures/sleeper/state-nfl.json";
import user from "./fixtures/sleeper/user.json";

const SLEEPER = "https://api.sleeper.app/v1";

export const URLS = {
  nflState: `${SLEEPER}/state/nfl`,
  user: `${SLEEPER}/user/${env.SLEEPER_USERNAME}`,
  leagues: `${SLEEPER}/user/${user.user_id}/leagues/nfl/2026`,
  rostersRedraft: `${SLEEPER}/league/1364555323238551552/rosters`,
  rostersDynasty: `${SLEEPER}/league/1353515683878559744/rosters`,
  players: `${SLEEPER}/players/nfl`,
  scoreboard:
    "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=2026&seasontype=2&week=6"
};

/** The user's Sleeper user ID, which marks their roster in each league. */
export const MY_USER_ID = user.user_id;

/**
 * A fresh copy of every saved response, so a test can change one (set a
 * different lineup, mark a player) without affecting the others.
 */
export function savedSources() {
  return structuredClone({
    [URLS.nflState]: stateNfl,
    [URLS.user]: user,
    [URLS.leagues]: leagues,
    [URLS.rostersRedraft]: rostersRedraft,
    [URLS.rostersDynasty]: rostersDynasty,
    [URLS.players]: players as Record<string, Record<string, unknown>>,
    [URLS.scoreboard]: scoreboard
  });
}
