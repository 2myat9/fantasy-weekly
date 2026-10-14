// The history: each automatic digest as it was sent, league by league, with
// the source items it was built from, so that a wrong line can be traced to
// its source. Beside it is the sent record, the leagues the automatic digest
// has gone out to per NFL week, which keeps an automatic run from delivering
// a week's league message twice, and where each league's next news window
// starts. Previews never touch any of them.
import type { SourceItem } from "./news";
import type { League, NflState } from "./sleeper";

function tables(storage: DurableObjectStorage) {
  // The season type is part of the key because Sleeper numbers the weeks of
  // the postseason from 1 again.
  storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS sent_digests (
      season TEXT NOT NULL,
      season_type TEXT NOT NULL,
      week INTEGER NOT NULL,
      league_id TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      PRIMARY KEY (season, season_type, week, league_id)
    )`
  );
  storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS news_windows (
      league_id TEXT PRIMARY KEY,
      starts_at INTEGER NOT NULL
    )`
  );
  // The IDs are in the order the digests were stored, oldest first.
  storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS digests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season TEXT NOT NULL,
      season_type TEXT NOT NULL,
      week INTEGER NOT NULL,
      league_id TEXT NOT NULL,
      league_name TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      messages TEXT NOT NULL,
      source_items TEXT NOT NULL
    )`
  );
  return storage.sql;
}

/** Whether the automatic digest of that week has gone out to the league. */
export function wasSent(
  storage: DurableObjectStorage,
  nfl: NflState,
  leagueId: string
) {
  const rows = tables(storage).exec(
    `SELECT 1 FROM sent_digests
    WHERE season = ? AND season_type = ? AND week = ? AND league_id = ?`,
    nfl.season,
    nfl.seasonType,
    nfl.week,
    leagueId
  );
  return rows.toArray().length > 0;
}

// The size the database is kept under. Cloudflare's limits page gives a
// Durable Object on the free plan both 1 GB and 10 GB, and this is safe
// under either: a database that is full takes no more writes, and the agent
// would stop working. Read on 2026-10-14; a gigabyte there is 10^9 bytes.
const DATABASE_LIMIT = 800_000_000;

// How far back news is considered for a league with no previous digest.
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Where the news window for the league starts: when the news of its previous
 * automatic digest was gathered, so that stories already told are not told
 * again, or seven days ago when it has had none.
 */
export function newsWindowStart(
  storage: DurableObjectStorage,
  leagueId: string,
  now: Date
) {
  const [previous] = tables(storage)
    .exec<{ starts_at: number }>(
      "SELECT starts_at FROM news_windows WHERE league_id = ?",
      leagueId
    )
    .toArray();
  return new Date(previous?.starts_at ?? now.getTime() - DEFAULT_WINDOW_MS);
}

/**
 * Records that the week's automatic digest has gone out to the league, moves
 * the league's news window on to `newsGatheredAt`, and stores the league
 * message: its texts as sent and the source items it was written from. The
 * window starts where the news was gathered, not where the message was sent,
 * so that what came out while the run was taking its steps is in the next.
 */
export function recordDigest(
  storage: DurableObjectStorage,
  {
    nfl,
    league,
    messages,
    items,
    newsGatheredAt
  }: {
    nfl: NflState;
    league: League;
    messages: string[];
    items: SourceItem[];
    newsGatheredAt: Date;
  }
) {
  const sentAt = Date.now();
  const sql = tables(storage);
  storage.transactionSync(() => {
    sql.exec(
      `INSERT OR IGNORE INTO sent_digests
        (season, season_type, week, league_id, sent_at)
      VALUES (?, ?, ?, ?, ?)`,
      nfl.season,
      nfl.seasonType,
      nfl.week,
      league.id,
      sentAt
    );
    sql.exec(
      "INSERT OR REPLACE INTO news_windows (league_id, starts_at) VALUES (?, ?)",
      league.id,
      newsGatheredAt.getTime()
    );
  });
  // Stored apart from the record, so that a history that cannot be written
  // does not leave a league that was sent to be sent again.
  try {
    sql.exec(
      `INSERT INTO digests (season, season_type, week, league_id,
        league_name, sent_at, messages, source_items)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      nfl.season,
      nfl.seasonType,
      nfl.week,
      league.id,
      league.name,
      sentAt,
      JSON.stringify(messages),
      JSON.stringify(items)
    );
    prune(storage);
  } catch (error) {
    console.error("The digest could not be stored in the history", error);
  }
}

// Deletes the oldest digests until the database is under its limit, or there
// is no history left to delete. The sent record is never deleted: it is
// small, and it is what keeps a week from being sent twice.
function prune(storage: DurableObjectStorage) {
  const sql = tables(storage);
  while (sql.databaseSize > DATABASE_LIMIT) {
    const deleted = sql
      .exec(
        `DELETE FROM digests
        WHERE id = (SELECT id FROM digests ORDER BY id LIMIT 1)
        RETURNING id`
      )
      .toArray();
    if (deleted.length === 0) return;
  }
}
