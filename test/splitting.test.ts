import { expect, it } from "vitest";
import {
  deliverTelegramUpdate,
  fakeOutboundHttp,
  setClock,
  textMessage,
  triggerScheduledRun,
  type WriterStandIn
} from "./harness";
import { savedSources } from "./sources";

// The saved ESPN injuries were read that morning, before any game of week 6.
const TUESDAY = "2026-10-13T16:00:00Z";

// The most characters Telegram takes in one message.
const TELEGRAM_LIMIT = 4096;

/** What the writer says about one player: two lines, some 400 characters. */
function longText(playerId: string) {
  return `Report on ${playerId} opens. ${"He was limited in practice again. ".repeat(10)}\nReport on ${playerId} closes.`;
}

// Writes a long entry about every dynasty player there is an item about, far
// more than one message holds, and nothing for the redraft league.
const writesAtLength: WriterStandIn = (material) => ({
  needsDecision: [],
  stillUnresolved: [],
  otherNews:
    material.league.format === "dynasty"
      ? [...new Set(material.sourceItems.map(({ playerId }) => playerId))]
          .filter((playerId) =>
            material.roster.some((player) => player.playerId === playerId)
          )
          .map((playerId) => ({
            playerId,
            status: "questionable" as const,
            text: longText(playerId),
            sourceItemIds: []
          }))
      : []
});

/**
 * One preview with the long dynasty league message: the texts sent for that
 * league, in order, and the players the writer wrote about.
 */
async function previewAtLength() {
  setClock(TUESDAY);
  const outbound = fakeOutboundHttp(savedSources(), { writer: writesAtLength });
  await deliverTelegramUpdate(textMessage("/preview"));
  const [redraft, ...dynasty] = outbound.telegramMessages.map(
    (message) => (message as { text: string }).text
  );
  const written = writesAtLength(
    outbound.writerCalls.find(
      ({ material }) => material.league.format === "dynasty"
    )!.material
  ).otherNews.map(({ playerId }) => playerId);
  return { redraft, dynasty, written };
}

/** Whether every tag of a text is closed, in order, within it. */
function isBalancedHtml(text: string) {
  const open: string[] = [];
  for (const [, closing, tag] of text.matchAll(/<(\/?)(\w+)[^>]*>/g)) {
    if (!closing) open.push(tag);
    else if (open.pop() !== tag) return false;
  }
  return open.length === 0;
}

it("a league message over Telegram's limit is sent as several messages, each within the limit, in order", async () => {
  const { redraft, dynasty, written } = await previewAtLength();

  expect(redraft).toMatch(/^<b>Preview · Duffy Redraft<\/b>\n/);
  expect(written.length).toBeGreaterThan(10);
  expect(dynasty.length).toBeGreaterThan(1);
  for (const part of dynasty) {
    expect(part.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
  }
  expect(dynasty[0]).toMatch(
    /^<b>Preview · Joel is the GOAT<\/b>\nDynasty · Week 6\n\n<b>Lineup check<\/b>\n/
  );
  // The entries arrive in the order the writer gave them.
  const order = Array.from(
    dynasty.join("\n").matchAll(/Report on (\w+) opens\./g),
    ([, playerId]) => playerId
  );
  expect(order).toEqual(written);
});

it("no player's entry is divided across two messages, and each part is valid Telegram HTML on its own", async () => {
  const { dynasty, written } = await previewAtLength();

  for (const playerId of written) {
    // The whole entry: its marker and name, both lines of text, its citation.
    const whole = dynasty.filter((part) =>
      part
        .split(/\n(?=🟡)/)
        .some(
          (entry) =>
            /^🟡 <b>[^<]+<\/b>: /.test(entry) &&
            entry.includes(longText(playerId)) &&
            /Report on \w+ closes\. \(<a href="[^"]+">[^<]+<\/a>/.test(entry)
        )
    );
    expect(whole, `the entry on ${playerId}`).toHaveLength(1);
  }
  for (const part of dynasty) {
    expect(isBalancedHtml(part), part).toBe(true);
    expect(part).toBe(part.trim());
  }
});

it("the parts together hold everything the league message has: its headings once each, in order, and what follows the entries", async () => {
  const { dynasty } = await previewAtLength();

  const headings = dynasty
    .join("\n")
    .split("\n")
    .filter((line) => /^<b>[^<]+<\/b>$/.test(line));
  expect(headings).toEqual([
    "<b>Preview · Joel is the GOAT</b>",
    "<b>Lineup check</b>",
    "<b>Other news on your roster</b>",
    "<b>No significant news</b>",
    "<b>Couldn't check</b>"
  ]);
  // The four dynasty players that cannot be matched to a news source.
  const last = dynasty.at(-1)!.split("\n");
  expect(last.at(-2)).toBe("<b>Couldn't check</b>");
  expect(last.at(-1)!.split(", ")).toHaveLength(4);
});

// The digest's hour in week 6.
const SATURDAY = "2026-10-18T01:00:00Z";

it("when a part of the automatic digest fails to send, the step taken again sends only the parts that had not gone out", async () => {
  let refused = false;
  const outbound = fakeOutboundHttp(savedSources(), {
    writer: writesAtLength,
    // Telegram refuses the first part after the opening one, once.
    rejectTelegram: (text) => {
      if (refused || !text.startsWith("🟡")) return false;
      refused = true;
      return true;
    }
  });

  await triggerScheduledRun(SATURDAY);

  const sent = outbound.telegramMessages.map(
    (message) => (message as { text: string }).text
  );
  expect(refused).toBe(true);
  expect(
    sent.filter((text) => text.startsWith("<b>Joel is the GOAT</b>"))
  ).toHaveLength(1);
  const written = writesAtLength(
    outbound.writerCalls.find(
      ({ material }) => material.league.format === "dynasty"
    )!.material
  ).otherNews.map(({ playerId }) => playerId);
  const reported = Array.from(
    sent.join("\n").matchAll(/Report on (\w+) opens\./g),
    ([, playerId]) => playerId
  );
  expect(reported).toEqual(written);
  expect(sent.join("\n")).not.toContain("could not be built");
});
