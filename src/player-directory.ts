// The stored copy of the Sleeper player directory. Sleeper asks that the file
// be fetched no more than once a day, and it is far larger than what the agent
// needs, so only the reduced records are kept, one row per player.
import { fetchPlayerDirectory, type Player } from "./sleeper";

const DAY_MS = 24 * 60 * 60 * 1000;
const FETCHED_AT = "playerDirectoryFetchedAt";
// Rows per insert, to stay well under the size limit of one statement.
const BATCH = 1000;

/**
 * The given players by ID, from the stored directory. The directory is fetched
 * first when there is no copy or the copy is a day old. An ID that Sleeper
 * does not know is absent from the result.
 */
export async function playersById(
  storage: DurableObjectStorage,
  ids: string[]
): Promise<Map<string, Player>> {
  const fetchedAt = storage.kv.get<number>(FETCHED_AT);
  if (fetchedAt === undefined || Date.now() - fetchedAt >= DAY_MS) {
    store(storage, await fetchPlayerDirectory());
  }
  const rows = storage.sql.exec<{
    id: string;
    name: string;
    position: string | null;
    team: string | null;
    injury_status: string | null;
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
      injuryStatus: row.injury_status
    });
  }
  return players;
}

// Replaces the stored directory in one transaction, so a run never reads half
// of one.
function store(storage: DurableObjectStorage, players: Player[]) {
  storage.transactionSync(() => {
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        position TEXT,
        team TEXT,
        injury_status TEXT
      )`
    );
    storage.sql.exec("DELETE FROM players");
    for (let start = 0; start < players.length; start += BATCH) {
      storage.sql.exec(
        `INSERT INTO players (id, name, position, team, injury_status)
        SELECT value ->> 'id', value ->> 'name', value ->> 'position',
          value ->> 'team', value ->> 'injuryStatus'
        FROM json_each(?)`,
        JSON.stringify(players.slice(start, start + BATCH))
      );
    }
    storage.kv.put(FETCHED_AT, Date.now());
  });
}
