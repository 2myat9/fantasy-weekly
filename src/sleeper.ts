// The Sleeper client: the NFL week, the user's leagues and rosters, this
// week's opponents and the player directory. It only reads Sleeper and shapes what it reads; it stores
// nothing and knows nothing about digests.
import { retried } from "./retry";

const SLEEPER = "https://api.sleeper.app/v1";

function read<T>(path: string) {
  return retried(async () => {
    const response = await fetch(`${SLEEPER}${path}`);
    if (!response.ok) {
      throw new Error(`Sleeper ${path} returned ${response.status}`);
    }
    return response.json<T>();
  });
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
  /**
   * The roster the user's team plays this week, without its taxi squad, which
   * cannot play. Empty in a week the team has no game.
   */
  opponent: RosterSpot[];
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
const TAXI_SLOT = "TAXI";
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

/** A roster as the league has it placed. */
type Placement = Pick<League, "lineup" | "bench" | "ir" | "taxi">;

function placement(slots: string[], roster: SleeperRoster): Placement {
  const starters = roster.starters ?? [];
  const lineup = slots
    .filter((slot) => slot !== BENCH_SLOT)
    .map((slot, index) => {
      const playerId = starters[index] ?? NO_PLAYER;
      return { slot, playerId: playerId === NO_PLAYER ? null : playerId };
    });
  const ir = roster.reserve ?? [];
  const taxi = roster.taxi ?? [];
  const placed = new Set([...starters, ...ir, ...taxi]);
  return {
    lineup,
    bench: (roster.players ?? []).filter((id) => !placed.has(id)),
    ir,
    taxi
  };
}

/** Every player on a roster: starters in slot order, then bench, IR and taxi squad. */
export function rosterSpots(roster: Placement): RosterSpot[] {
  const placed = (slot: string) => (playerId: string) => ({ playerId, slot });
  return [
    ...roster.lineup.flatMap(({ slot, playerId }) =>
      playerId === null ? [] : [{ playerId, slot }]
    ),
    ...roster.bench.map(placed(BENCH_SLOT)),
    ...roster.ir.map(placed("IR")),
    ...roster.taxi.map(placed(TAXI_SLOT))
  ];
}

type SleeperMatchup = {
  roster_id: number;
  /** Shared by the two rosters that play each other, or null without a game. */
  matchup_id: number | null;
};

/** A league whose rosters could not be read: what is known of it without them. */
export type UnreadLeague = Pick<League, "id" | "name" | "status">;

/**
 * The user's leagues for the NFL season, each with their roster as it is set
 * now and the roster it plays in the NFL week. The leagues are read
 * independently: one whose rosters cannot be read is returned in `unread`,
 * and the others are not lost over it.
 */
export async function fetchMyLeagues(
  username: string,
  { season, seasonType, week }: NflState
): Promise<{ leagues: League[]; unread: UnreadLeague[] }> {
  const user = await read<{ user_id: string } | null>(
    `/user/${encodeURIComponent(username)}`
  );
  if (!user) throw new Error(`Sleeper has no user named ${username}`);
  const leagues = await read<SleeperLeague[]>(
    `/user/${user.user_id}/leagues/nfl/${season}`
  );
  const unread: UnreadLeague[] = [];
  const mine = await Promise.all(
    leagues
      .map(async (league): Promise<League | null> => {
        const [rosters, matchups] = await Promise.all([
          read<SleeperRoster[]>(`/league/${league.league_id}/rosters`),
          // Leagues play in the weeks of the regular season: outside it the
          // NFL's week number is not one of theirs. The opponent only adds to
          // the message, so a league is not lost over failing to read it.
          seasonType === "regular"
            ? read<SleeperMatchup[] | null>(
                `/league/${league.league_id}/matchups/${week}`
              )
                .then((matchups) => matchups ?? [])
                .catch((error) => {
                  console.error("The matchups could not be read", error);
                  return [];
                })
            : []
        ]);
        const mine = rosters.find(
          (roster) =>
            roster.owner_id === user.user_id ||
            roster.co_owners?.includes(user.user_id)
        );
        // A league the user is in without a roster of their own, as its
        // commissioner can be, has no lineup to brief them on.
        if (!mine) return null;
        const game = matchups.find(
          (matchup) => matchup.roster_id === mine.roster_id
        )?.matchup_id;
        const opponentId = matchups.find(
          (matchup) =>
            game != null &&
            matchup.matchup_id === game &&
            matchup.roster_id !== mine.roster_id
        )?.roster_id;
        const opponent = rosters.find(
          (roster) => roster.roster_id === opponentId
        );
        return {
          id: league.league_id,
          name: league.name,
          format: FORMATS[league.settings.type ?? 0] ?? "redraft",
          status: league.status,
          rosterId: mine.roster_id,
          firstPlayoffWeek: league.settings.playoff_week_start ?? 0,
          ...placement(league.roster_positions, mine),
          opponent: opponent
            ? rosterSpots(placement(league.roster_positions, opponent)).filter(
                ({ slot }) => slot !== TAXI_SLOT
              )
            : []
        };
      })
      // Kept in Sleeper's order, which is the order the messages are sent in.
      .map((reading, index) =>
        reading.catch((error) => {
          const { league_id: id, name, status } = leagues[index];
          console.error(`League ${name} could not be read`, error);
          unread.push({ id, name, status });
          return null;
        })
      )
  );
  return { leagues: mine.filter((league) => league !== null), unread };
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
