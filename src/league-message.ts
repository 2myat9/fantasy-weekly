// The digest composer: builds the Telegram message for one league.
import type { Finding } from "./lineup-check";
import type { SourceItem } from "./news";
import type { League, Player, RosterSpot } from "./sleeper";
import type { Entry, Sections, Status } from "./writer";

const PROBLEM: Record<Exclude<Finding["kind"], "empty">, string> = {
  bye: "is on bye",
  out: "is ruled out",
  ir: "is on IR"
};

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function capitalise(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function findingLine(finding: Finding) {
  // Sleeper names slots like REC_FLEX.
  const slot = escapeHtml(finding.slot.replaceAll("_", " "));
  if (finding.kind === "empty") return `🔴 ${slot} slot is empty`;
  const { name, team } = finding.player;
  const where = team ? ` (${escapeHtml(team)})` : "";
  return `🔴 ${slot} <b>${escapeHtml(name)}</b>${where} ${PROBLEM[finding.kind]}`;
}

const MARKER: Record<Status, string> = {
  out: "🔴",
  questionable: "🟡",
  cleared: "🟢",
  none: "⚪"
};

// Dates are shown as the user reads them, in Pacific time.
const day = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "short",
  day: "numeric"
});

function citation({ link, source, date }: SourceItem) {
  const label = escapeHtml(`${source}, ${day.format(date)}`);
  return `<a href="${escapeHtml(link).replaceAll('"', "&quot;")}">${label}</a>`;
}

/** A titled section, or nothing when it has no lines. */
function section(title: string, lines: string[]) {
  return lines.length > 0 ? ["", `<b>${title}</b>`, ...lines] : [];
}

/**
 * The league message as Telegram HTML. It opens with the lineup check, which
 * is always present: with no findings it states that the lineup is clear.
 * The news sections follow, each left out when it has nothing to report.
 * Every roster player is in one of them: the writer's sections, or the lists
 * of players it did not cover and of players that could not be checked.
 */
export function composeLeagueMessage({
  league,
  week,
  findings,
  roster,
  players,
  sections,
  unmatched,
  preview
}: {
  league: League;
  week: number;
  findings: Finding[];
  roster: RosterSpot[];
  players: Map<string, Player>;
  /** The model-written sections. */
  sections: Sections;
  /** The players that could not be resolved to a news source. */
  unmatched: Set<string>;
  preview: boolean;
}) {
  const title = escapeHtml(league.name);
  // A player Sleeper's directory does not know has no name to show.
  const name = (playerId: string) =>
    escapeHtml(players.get(playerId)?.name ?? `Player ${playerId}`);
  const entryLine = ({ playerId, status, text, sources }: Entry) =>
    `${MARKER[status]} <b>${name(playerId)}</b>: ${escapeHtml(text)} (${sources.map(citation).join(", ")})`;
  const covered = new Set(
    Object.values(sections).flatMap((entries) =>
      entries.map(({ playerId }) => playerId)
    )
  );
  const uncovered = roster
    .map(({ playerId }) => playerId)
    .filter((playerId) => !covered.has(playerId));
  const names = (playerIds: string[]) =>
    playerIds.length > 0 ? [playerIds.map(name).join(", ")] : [];
  const checkable = (playerId: string) =>
    players.has(playerId) && !unmatched.has(playerId);
  return [
    `<b>${preview ? `Preview · ${title}` : title}</b>`,
    `${capitalise(league.format)} · Week ${week}`,
    "",
    "<b>Lineup check</b>",
    ...(findings.length > 0
      ? findings.map(findingLine)
      : [
          "✅ Lineup clear: no starter is on bye, ruled out or on IR, and every slot is filled."
        ]),
    ...section("Needs a decision", sections.needsDecision.map(entryLine)),
    ...section(
      "Still unresolved, check before kickoff",
      sections.stillUnresolved.map(entryLine)
    ),
    ...section("Other news on your roster", sections.otherNews.map(entryLine)),
    ...section("No significant news", names(uncovered.filter(checkable))),
    ...section(
      "Couldn't check",
      names(uncovered.filter((playerId) => !checkable(playerId)))
    )
  ].join("\n");
}
