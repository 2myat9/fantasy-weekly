// When the automatic digest runs: Saturdays at 6:00 PM Pacific. Runs are
// scheduled as instants computed here, so the send time holds across both
// daylight-saving changes.
const ZONE = "America/Los_Angeles";
const SATURDAY = 6;
const SEND_HOUR = 18;

const pacific = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric"
});

// The Pacific wall time at an instant, as the UTC timestamp that reads the
// same. Its difference from the instant is the zone's offset then.
function pacificWallTime(instant: number) {
  const part: Record<string, number> = {};
  for (const { type, value } of pacific.formatToParts(instant)) {
    part[type] = Number(value);
  }
  return Date.UTC(
    part.year,
    part.month - 1,
    part.day,
    part.hour,
    part.minute,
    part.second
  );
}

/** The first Saturday 6:00 PM Pacific after the given instant. */
export function nextDigestTime(after: Date) {
  const today = new Date(pacificWallTime(after.getTime()));
  for (let daysAhead = 0; ; daysAhead++) {
    const wallTime = Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() + daysAhead,
      SEND_HOUR
    );
    if (new Date(wallTime).getUTCDay() !== SATURDAY) continue;
    // The offset is read on Saturday morning Pacific. It is the same that
    // evening, because the clocks only change early on a Sunday.
    const instant = wallTime - (pacificWallTime(wallTime) - wallTime);
    if (instant > after.getTime()) return new Date(instant);
  }
}
