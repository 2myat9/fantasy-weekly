// The lineup check: the mechanical check of the lineup currently set in
// Sleeper. It is computed without the model so that it is always correct.
import type { WeekSchedule } from "./espn";
import type { LineupSlot, Player } from "./sleeper";

/** One problem with a starting slot. */
export type Finding =
  | { kind: "empty"; slot: string }
  | { kind: "bye" | "out" | "ir"; slot: string; player: Player };

// Sleeper's designations for a player who will not play, other than IR.
const OUT = new Set(["Out", "Sus", "PUP", "NFI", "DNR", "COV"]);

/**
 * Checks a lineup against player statuses and the week's schedule. A slot gets
 * at most one finding, the longest-lasting reason first. A starter missing
 * from `players` cannot be checked and gets none.
 */
export function checkLineup(
  lineup: LineupSlot[],
  players: Map<string, Player>,
  schedule: WeekSchedule
): Finding[] {
  const findings: Finding[] = [];
  for (const { slot, playerId } of lineup) {
    if (playerId === null) {
      findings.push({ kind: "empty", slot });
      continue;
    }
    const player = players.get(playerId);
    if (!player) continue;
    if (player.injuryStatus === "IR") {
      findings.push({ kind: "ir", slot, player });
    } else if (player.injuryStatus && OUT.has(player.injuryStatus)) {
      findings.push({ kind: "out", slot, player });
    } else if (player.team && schedule.teamsOnBye.includes(player.team)) {
      findings.push({ kind: "bye", slot, player });
    }
  }
  return findings;
}
