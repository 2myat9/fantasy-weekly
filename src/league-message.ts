// The digest composer: builds the Telegram message for one league.
import type { Finding } from "./lineup-check";
import type { SourceItem } from "./news";
import type { League, Player, RosterSpot } from "./sleeper";
import { layOutMessages } from "./telegram";
import { NO_SECTIONS, type Entry, type Sections, type Status } from "./writer";

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

/**
 * The short message for a run that could not send a league message: for the
 * named leagues, or with none named when it failed before reaching any.
 */
export function composeFailureMessage({
  leagues,
  preview
}: {
  leagues: string[];
  preview: boolean;
}) {
  const what = preview ? "preview" : "digest";
  const which =
    leagues.length > 0 ? ` for ${escapeHtml(leagues.join(", "))}` : "";
  return `The ${what} could not be built${which}. Send /preview to try again.`;
}

/**
 * A titled section as a paragraph of blocks, one per line, or nothing when it
 * has no lines. The title is part of the first block, so it is never left at
 * the foot of one message with its lines in the next.
 */
function section(title: string, [first, ...rest]: string[]) {
  return first === undefined ? [] : [[`<b>${title}</b>\n${first}`, ...rest]];
}

/**
 * The league message as Telegram HTML: one message, or several to be sent in
 * order when it is longer than Telegram takes, divided between sections or
 * between the lines of one, never within a player's entry.
 *
 * It opens with the lineup check, which is always present: with no findings
 * it states that the lineup is clear.
 * The news sections follow, each left out when it has nothing to report.
 * Every roster player is in one of them: the writer's sections, or the lists
 * of players it did not cover and of players that could not be checked. The
 * writer's note on this week's opponent, when it has one, comes last.
 *
 * A message with something missing is a reduced one. It says what is missing
 * under its title, so the user knows what to check themselves, and lists the
 * injury statuses Sleeper has for the roster after the lineup check, which
 * are then the news it is sure to have.
 */
export function composeLeagueMessage({
  league,
  week,
  findings,
  roster,
  players,
  sections,
  unmatched,
  missing,
  byesChecked,
  preview
}: {
  league: League;
  week: number;
  findings: Finding[];
  roster: RosterSpot[];
  players: Map<string, Player>;
  /** The model-written sections, or null when none could be written. */
  sections: Sections | null;
  /** The players that could not be resolved to a news source. */
  unmatched: Set<string>;
  /** What the message was built without, each named for the user. */
  missing: string[];
  /** False when the week's schedule is not known, so byes are not either. */
  byesChecked: boolean;
  preview: boolean;
}) {
  const title = escapeHtml(league.name);
  // A player Sleeper's directory does not know has no name to show.
  const name = (playerId: string) =>
    escapeHtml(players.get(playerId)?.name ?? `Player ${playerId}`);
  const entryLine = ({ playerId, status, text, sources }: Entry) =>
    `${MARKER[status]} <b>${name(playerId)}</b>: ${escapeHtml(text)} (${sources.map(citation).join(", ")})`;
  const { needsDecision, stillUnresolved, otherNews, opponentNote } =
    sections ?? NO_SECTIONS;
  const covered = new Set(
    [needsDecision, stillUnresolved, otherNews].flatMap((entries) =>
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
  const clear = byesChecked
    ? "✅ Lineup clear: no starter is on bye, ruled out or on IR, and every slot is filled."
    : "✅ No starter is ruled out or on IR, and every slot is filled.";
  const statuses = roster.flatMap(({ playerId }) => {
    const player = players.get(playerId);
    if (!player?.injuryStatus) return [];
    const where = player.team ? ` (${escapeHtml(player.team)})` : "";
    return `<b>${escapeHtml(player.name)}</b>${where}: ${escapeHtml(player.injuryStatus)}`;
  });
  return layOutMessages([
    [
      [
        `<b>${preview ? `Preview · ${title}` : title}</b>`,
        `${capitalise(league.format)} · Week ${week}`,
        ...(missing.length > 0
          ? [`⚠️ Missing from this message: ${escapeHtml(missing.join("; "))}.`]
          : [])
      ].join("\n")
    ],
    ...section("Lineup check", [
      ...(findings.length > 0 ? findings.map(findingLine) : [clear]),
      ...(byesChecked ? [] : ["⚠️ Byes could not be checked."])
    ]),
    ...(missing.length > 0
      ? section(
          "Injury statuses from Sleeper",
          statuses.length > 0
            ? statuses
            : ["None of your players has an injury status in Sleeper."]
        )
      : []),
    ...section("Needs a decision", needsDecision.map(entryLine)),
    ...section(
      "Still unresolved, check before kickoff",
      stillUnresolved.map(entryLine)
    ),
    ...section("Other news on your roster", otherNews.map(entryLine)),
    // Without the sections nobody was looked at, so nobody is said to have
    // no significant news.
    ...section(
      "No significant news",
      sections ? names(uncovered.filter(checkable)) : []
    ),
    ...section(
      "Couldn't check",
      names(uncovered.filter((playerId) => !checkable(playerId)))
    ),
    ...section(
      "Opponent note",
      opponentNote
        ? [
            `${escapeHtml(opponentNote.text)} (${opponentNote.sources.map(citation).join(", ")})`
          ]
        : []
    )
  ]);
}
