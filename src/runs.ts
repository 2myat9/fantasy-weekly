// The stored runs: each run in progress and what it has gathered so far. A run
// is too large for one invocation on the free plan, which allows 50 outbound
// requests, so it is taken a step at a time and kept here in between.
import type { WeekSchedule } from "./espn";
import type { Gathering } from "./news";
import type { League, NflState, Player } from "./sleeper";

/** What a run holds once the shared sources have been read. */
export type Gathered = {
  nfl: NflState;
  /** The leagues still owed a league message, in the order they are sent. */
  leagues: League[];
  schedule: WeekSchedule;
  /** The players on those leagues' rosters and their opponents', by Sleeper ID. */
  players: Map<string, Player>;
  news: Gathering;
};

export type Run = {
  id: number;
  preview: boolean;
  /** Source items dated before this are outside the news window. */
  windowStart: Date;
  /** How many times the step the run is at has failed. */
  failures: number;
  /** Absent until the first step has read the shared sources. */
  gathered?: Gathered;
};

const SEQUENCE = "runSequence";
const PREFIX = "run:";

// Padded so that the keys sort in the order the runs were started.
function key(id: number) {
  return `${PREFIX}${String(id).padStart(12, "0")}`;
}

/** Records a run that is yet to take its first step. */
export function startRun(
  storage: DurableObjectStorage,
  { preview, windowStart }: { preview: boolean; windowStart: Date }
) {
  const id = (storage.kv.get<number>(SEQUENCE) ?? 0) + 1;
  storage.kv.put(SEQUENCE, id);
  saveRun(storage, { id, preview, windowStart, failures: 0 });
}

/** The run that was started first of those still in progress, if any. */
export function oldestRun(storage: DurableObjectStorage): Run | undefined {
  // Read to the end, because a listing left open keeps the database locked
  // against replacing the player directory.
  const [oldest] = [...storage.kv.list<Run>({ prefix: PREFIX, limit: 1 })];
  return oldest?.[1];
}

// Stored as a structured clone, so dates, maps and sets come back as such.
export function saveRun(storage: DurableObjectStorage, run: Run) {
  storage.kv.put(key(run.id), run);
}

export function endRun(storage: DurableObjectStorage, run: Run) {
  storage.kv.delete(key(run.id));
}
