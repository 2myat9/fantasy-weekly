// The digest composer: builds the Telegram message for one league.
import type { Finding } from "./lineup-check";
import type { League } from "./sleeper";

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

/**
 * The league message as Telegram HTML. It opens with the lineup check, which
 * is always present: with no findings it states that the lineup is clear.
 */
export function composeLeagueMessage({
  league,
  week,
  findings,
  preview
}: {
  league: League;
  week: number;
  findings: Finding[];
  preview: boolean;
}) {
  const title = escapeHtml(league.name);
  return [
    `<b>${preview ? `Preview · ${title}` : title}</b>`,
    `${capitalise(league.format)} · Week ${week}`,
    "",
    "<b>Lineup check</b>",
    ...(findings.length > 0
      ? findings.map(findingLine)
      : [
          "✅ Lineup clear: no starter is on bye, ruled out or on IR, and every slot is filled."
        ])
  ].join("\n");
}
