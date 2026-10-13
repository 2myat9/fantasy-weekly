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
  roster_positions: string[];
  settings: { type?: number };
};

type SleeperRoster = {
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
};

type SleeperPlayer = {
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  team?: string | null;
  injury_status?: string | null;
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
    injuryStatus: player.injury_status || null
  }));
}
