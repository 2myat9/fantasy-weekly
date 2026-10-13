// The stored copy of the Sleeper player directory. Sleeper asks that the file
// be fetched no more than once a day, and it is far larger than what the agent
// needs, so only the reduced records are kept, one row per player.
import { fetchPlayerDirectory, type Player } from "./sleeper";

const DAY_MS = 24 * 60 * 60 * 1000;
// The key names the stored shape. A copy stored in an earlier shape is under
// another key, so it reads as absent and is replaced.
const FETCHED_AT = "playerDirectoryWithEspnIdFetchedAt";
// Rows per insert, to stay well under the size limit of one statement.
const BATCH = 1000;

/**
 * The given players by ID, from the stored directory. The directory is fetched
 * first when there is no copy or the copy is a day old. An ID that Sleeper
 * does not know is absent from the result. When the directory cannot be
 * fetched, the players are those of the old copy and `stale` is set; with no
 * copy at all there is nothing to give, and the error is thrown.
 */
export async function playersById(
  storage: DurableObjectStorage,
  ids: string[]
): Promise<{ players: Map<string, Player>; stale: boolean }> {
  const fetchedAt = storage.kv.get<number>(FETCHED_AT);
  let stale = false;
  if (fetchedAt === undefined || Date.now() - fetchedAt >= DAY_MS) {
    const directory = await fetchPlayerDirectory().catch((error) => {
      if (fetchedAt === undefined) throw error;
      console.error("The player directory could not be fetched", error);
      return null;
    });
    if (directory) store(storage, directory);
    else stale = true;
  }
  const rows = storage.sql.exec<{
    id: string;
    name: string;
    position: string | null;
    team: string | null;
    injury_status: string | null;
    espn_id: string | null;
  }>(
    "SELECT * FROM players WHERE id IN (SELECT value FROM json_each(?))",
    JSON.stringify(ids)
  );
  const players = new Map<string, Player>();
  for (const row of rows) {
    players.set(row.id, {
      id: row.id,
      name: row.name,
      position: row.position,
      team: row.team,
      injuryStatus: row.injury_status,
      espnId: row.espn_id
    });
  }
  return { players, stale };
}

// Replaces the stored directory in one transaction, so a run never reads half
// of one.
function store(storage: DurableObjectStorage, players: Player[]) {
  storage.transactionSync(() => {
    storage.sql.exec("DROP TABLE IF EXISTS players");
    storage.sql.exec(
      `CREATE TABLE players (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        position TEXT,
        team TEXT,
        injury_status TEXT,
        espn_id TEXT
      )`
    );
    for (let start = 0; start < players.length; start += BATCH) {
      storage.sql.exec(
        `INSERT INTO players
          (id, name, position, team, injury_status, espn_id)
        SELECT value ->> 'id', value ->> 'name', value ->> 'position',
          value ->> 'team', value ->> 'injuryStatus', value ->> 'espnId'
        FROM json_each(?)`,
        JSON.stringify(players.slice(start, start + BATCH))
      );
    }
    storage.kv.put(FETCHED_AT, Date.now());
  });
}
