// The sent record: the leagues the automatic digest has gone out to, per NFL
// week. It is what keeps an automatic run from delivering a week's league
// message twice. Previews never touch it.
import type { NflState } from "./sleeper";

function table(storage: DurableObjectStorage) {
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
  return storage.sql;
}

/** Whether the automatic digest of that week has gone out to the league. */
export function wasSent(
  storage: DurableObjectStorage,
  nfl: NflState,
  leagueId: string
) {
  const rows = table(storage).exec(
    `SELECT 1 FROM sent_digests
    WHERE season = ? AND season_type = ? AND week = ? AND league_id = ?`,
    nfl.season,
    nfl.seasonType,
    nfl.week,
    leagueId
  );
  return rows.toArray().length > 0;
}

export function recordSent(
  storage: DurableObjectStorage,
  nfl: NflState,
  leagueId: string
) {
  table(storage).exec(
    `INSERT OR IGNORE INTO sent_digests
      (season, season_type, week, league_id, sent_at)
    VALUES (?, ?, ?, ?, ?)`,
    nfl.season,
    nfl.seasonType,
    nfl.week,
    leagueId,
    Date.now()
  );
}
