// The Sleeper client: the NFL week, the user's leagues and rosters, and the
// player directory. It only reads Sleeper and shapes what it reads; it stores
// nothing and knows nothing about digests.
const SLEEPER = "https://api.sleeper.app/v1";

async function read<T>(path: string) {
  const response = await fetch(`${SLEEPER}${path}`);
  if (!response.ok) {
    throw new Error(`Sleeper ${path} returned ${response.status}`);
  }
  return response.json<T>();
}

export type NflState = {
  season: string;
  /** `pre`, `regular`, `post` or `off`. */
  seasonType: string;
  week: number;
};

export async function fetchNflState(): Promise<NflState> {
  const nfl = await read<{ season: string; season_type: string; week: number }>(
    "/state/nfl"
  );
  return { season: nfl.season, seasonType: nfl.season_type, week: nfl.week };
}

export type LeagueFormat = "redraft" | "keeper" | "dynasty";

/** One starting slot and the player set in it, or null when it is empty. */
export type LineupSlot = { slot: string; playerId: string | null };

export type League = {
  id: string;
  name: string;
  format: LeagueFormat;
  /** `pre_draft`, `drafting`, `in_season` or `complete`. */
  status: string;
  /** The user's roster in the league, as Sleeper numbers it. */
  rosterId: number;
  /** The NFL week the league's playoffs start in, or 0 if it has none. */
  firstPlayoffWeek: number;
  /** The current lineup, one entry per starting slot in the league's order. */
  lineup: LineupSlot[];
  // The rest of the user's roster, as player IDs.
  bench: string[];
  ir: string[];
  taxi: string[];
};

type SleeperLeague = {
  league_id: string;
  name: string;
  status: string;
  roster_positions: string[];
  settings: { type?: number; playoff_week_start?: number };
};

type SleeperRoster = {
  roster_id: number;
  owner_id: string | null;
  co_owners: string[] | null;
  players: string[] | null;
  starters: string[] | null;
  reserve: string[] | null;
  taxi: string[] | null;
};

// Sleeper numbers its league types.
const FORMATS: LeagueFormat[] = ["redraft", "keeper", "dynasty"];
// Sleeper lists bench places among a league's roster positions.
const BENCH_SLOT = "BN";
// Sleeper fills an empty starting slot with this ID.
const NO_PLAYER = "0";

/** One game of a league's playoff bracket. */
type SleeperBracketGame = {
  // Roster IDs, or null until the game that decides the team is played.
  t1: number | null;
  t2: number | null;
  /** The winner's roster ID once the game is played. */
  w: number | null;
  /** The final place the game decides. Only the title game and placement games have it. */
  p?: number;
};

/**
 * Whether the user's team is out of a league's playoffs: they have started and
 * it has no game left to play towards the title. Meant for the regular season
 * and postseason; at other times the bracket says nothing.
 */
export async function isEliminated(league: League, nfl: NflState) {
  if (league.firstPlayoffWeek === 0) return false;
  // Before the playoffs Sleeper fills the bracket with the projected seeds,
  // so it says nothing about who is out until they start.
  if (nfl.seasonType === "regular" && nfl.week < league.firstPlayoffWeek) {
    return false;
  }
  const bracket = await read<SleeperBracketGame[] | null>(
    `/league/${league.id}/winners_bracket`
  );
  // Without a bracket there is nothing to show the team is out.
  if (!bracket || bracket.length === 0) return false;
  // A team with a bye is already placed in its second-round game. Placement
  // games, such as the one for third place, are not on the way to the title.
  return !bracket.some(
    (game) =>
      game.w === null &&
      (game.p ?? 1) === 1 &&
      (game.t1 === league.rosterId || game.t2 === league.rosterId)
  );
}

/** A player on the user's roster and where the league has them placed. */
export type RosterSpot = {
  playerId: string;
  /** The starting slot, such as `QB` or `REC_FLEX`, or `BN`, `IR` or `TAXI`. */
  slot: string;
};

/** Every player on the user's roster: starters in slot order, then bench, IR and taxi squad. */
export function rosterSpots(league: League): RosterSpot[] {
  const placed = (slot: string) => (playerId: string) => ({ playerId, slot });
  return [
    ...league.lineup.flatMap(({ slot, playerId }) =>
      playerId === null ? [] : [{ playerId, slot }]
    ),
    ...league.bench.map(placed(BENCH_SLOT)),
    ...league.ir.map(placed("IR")),
    ...league.taxi.map(placed("TAXI"))
  ];
}

/** The user's leagues for a season, each with their roster as it is set now. */
export async function fetchMyLeagues(
  username: string,
  season: string
): Promise<League[]> {
  const user = await read<{ user_id: string } | null>(
    `/user/${encodeURIComponent(username)}`
  );
  if (!user) throw new Error(`Sleeper has no user named ${username}`);
  const leagues = await read<SleeperLeague[]>(
    `/user/${user.user_id}/leagues/nfl/${season}`
  );
  return Promise.all(
    leagues.map(async (league) => {
      const rosters = await read<SleeperRoster[]>(
        `/league/${league.league_id}/rosters`
      );
      const mine = rosters.find(
        (roster) =>
          roster.owner_id === user.user_id ||
          roster.co_owners?.includes(user.user_id)
      );
      if (!mine) throw new Error(`No roster of mine in league ${league.name}`);
      const starters = mine.starters ?? [];
      const lineup = league.roster_positions
        .filter((slot) => slot !== BENCH_SLOT)
        .map((slot, index) => {
          const playerId = starters[index] ?? NO_PLAYER;
          return { slot, playerId: playerId === NO_PLAYER ? null : playerId };
        });
      const ir = mine.reserve ?? [];
      const taxi = mine.taxi ?? [];
      const placed = new Set([...starters, ...ir, ...taxi]);
      return {
        id: league.league_id,
        name: league.name,
        format: FORMATS[league.settings.type ?? 0] ?? "redraft",
        status: league.status,
        rosterId: mine.roster_id,
        firstPlayoffWeek: league.settings.playoff_week_start ?? 0,
        lineup,
        bench: (mine.players ?? []).filter((id) => !placed.has(id)),
        ir,
        taxi
      };
    })
  );
}

/** The fields of a Sleeper player record that the agent uses. */
export type Player = {
  id: string;
  name: string;
  position: string | null;
  /** The player's NFL team, or null for a free agent. */
  team: string | null;
  /** Sleeper's injury designation, such as `Out` or `IR`, or null. */
  injuryStatus: string | null;
  /** The player's ID at ESPN. Sleeper has one for a minority of players. */
  espnId: string | null;
};

type SleeperPlayer = {
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  team?: string | null;
  injury_status?: string | null;
  espn_id?: number | string | null;
};

/**
 * Every NFL player Sleeper knows, reduced to the fields the agent uses. The
 * file is large, and Sleeper asks that it be fetched no more than once a day.
 */
export async function fetchPlayerDirectory(): Promise<Player[]> {
  const players = await read<Record<string, SleeperPlayer>>("/players/nfl");
  return Object.entries(players).map(([id, player]) => ({
    id,
    // Team defenses have no full name.
    name:
      player.full_name ??
      `${player.first_name ?? ""} ${player.last_name ?? ""}`.trim(),
    position: player.position ?? null,
    team: player.team ?? null,
    injuryStatus: player.injury_status || null,
    espnId: player.espn_id ? String(player.espn_id) : null
  }));
}
