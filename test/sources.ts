// Saved copies of what the agent reads on a run, keyed by the URL it reads
// them from. They are trimmed real responses for the user's two leagues in
// week 6 of 2026: three redraft starters are on bye, and in the dynasty league
// one starter is ruled out and the defense is on bye. The ESPN injuries were
// read on 13 October 2026 and hold one dated report per player. Four dynasty
// players without an ESPN ID in Sleeper have no report, so they cannot be
// matched, and neither can a team defense. The ESPN league news, the ESPN
// overview of each matched player and the ProFootballTalk feed were read the
// same day, and are trimmed to the fields the agent reads.
import { env } from "cloudflare:workers";
import injuries from "./fixtures/espn/injuries.json";
import leagueNews from "./fixtures/espn/news.json";
import overviews from "./fixtures/espn/overviews.json";
import scoreboard from "./fixtures/espn/scoreboard-2026-week-6.json";
import proFootballTalk from "./fixtures/pft/profootballtalk.rss?raw";
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
  // Read only once a league's playoffs have started.
  bracketRedraft: `${SLEEPER}/league/1364555323238551552/winners_bracket`,
  bracketDynasty: `${SLEEPER}/league/1353515683878559744/winners_bracket`,
  players: `${SLEEPER}/players/nfl`,
  injuries:
    "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries",
  scoreboard:
    "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=2026&seasontype=2&week=6",
  scoreboardWeek15:
    "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=2026&seasontype=2&week=15",
  leagueNews:
    "https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50",
  proFootballTalk: "https://www.nbcsports.com/profootballtalk.rss"
};

/** Where the agent reads ESPN's overview of one player, by ESPN ID. */
export function overviewUrl(espnId: string) {
  return `https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${espnId}/overview`;
}

/** The user's Sleeper user ID, which marks their roster in each league. */
export const MY_USER_ID = user.user_id;

/**
 * A fresh copy of every saved response, so a test can change one (set a
 * different lineup, mark a player) without affecting the others.
 */
export function savedSources(): Record<string, unknown> {
  return structuredClone({
    [URLS.nflState]: stateNfl,
    [URLS.user]: user,
    [URLS.leagues]: leagues,
    [URLS.rostersRedraft]: rostersRedraft,
    [URLS.rostersDynasty]: rostersDynasty,
    [URLS.players]: players as Record<string, Record<string, unknown>>,
    [URLS.scoreboard]: scoreboard,
    [URLS.injuries]: injuries,
    [URLS.leagueNews]: leagueNews,
    [URLS.proFootballTalk]: proFootballTalk,
    ...Object.fromEntries(
      Object.entries(overviews).map(([espnId, overview]) => [
        overviewUrl(espnId),
        overview
      ])
    )
  });
}
