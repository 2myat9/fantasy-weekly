// The Telegram client: sends messages to the user's chat. It knows nothing
// about digests, so anything that needs to deliver a message can reuse it.
import { createHash, timingSafeEqual } from "node:crypto";

export type TelegramConfig = {
  botToken: string;
  chatId: string;
};

/** Sends one HTML-formatted message to the user's chat. */
export async function sendMessage(config: TelegramConfig, html: string) {
  const response = await fetch(
    `https://api.telegram.org/bot${config.botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true }
      })
    }
  );
  if (!response.ok) {
    throw new Error(
      `Telegram sendMessage returned ${response.status}: ${await response.text()}`
    );
  }
}

// The most characters Telegram takes in one message. It counts them after
// the formatting is read, so a text that fits with its tags always fits.
const MESSAGE_LIMIT = 4096;

// What a block is made of for dividing it: a tag, an entity, a run of white
// space, or any other single character. None of them is ever cut.
const ATOM = /<[^>]*>|&#?\w+;|\s+|[^]/gu;

/** The tags open after an atom, given those open before it. */
function openAfter(open: string[], atom: string) {
  if (!atom.startsWith("<")) return open;
  return atom.startsWith("</") ? open.slice(0, -1) : [...open, atom];
}

/** The closing tags for the open ones, innermost first. */
function closing(open: string[]) {
  return open
    .map((tag) => `</${/[\w-]+/.exec(tag)?.[0] ?? ""}>`)
    .reverse()
    .join("");
}

/**
 * Divides a block over the limit into parts within it, each valid HTML on its
 * own: tags open where a part ends are closed there and opened again in the
 * next. A block within the limit is returned as it is.
 *
 * A part ends at the best place to divide that leaves it at least half full:
 * the last line break; failing one, the last white space after a comma and
 * outside any tag pair, which is between the names of a list or between
 * links; failing that, the last white space outside any tag pair; then the
 * last inside one. With none of those, it ends at the last white space there
 * is, and only without any between two characters. The white space divided
 * at is left out, and nothing else is.
 *
 * Only a tag that is itself over the limit, or nearly, leaves a part over it.
 */
function divideBlock(block: string, limit: number) {
  if (block.length <= limit) return [block];
  const atoms = block.match(ATOM) ?? [];
  const parts: string[] = [];
  // Where the part being filled starts, and the tags open there.
  let start = 0;
  let opened: string[] = [];
  while (start < atoms.length) {
    let open = opened;
    let length = opened.join("").length;
    let closingLength = closing(open).length;
    // The best place to divide so far: the part ends before `end`, with the
    // tags `open` to close, and the next starts at `next`.
    let best = { rank: -1, end: start, next: start, open };
    let index = start;
    for (; index < atoms.length; index++) {
      const atom = atoms[index];
      if (/^\s/.test(atom) && index > start) {
        let rank = 0;
        if (length >= limit / 2) {
          if (atom.includes("\n")) rank = 4;
          else if (open.length > 0) rank = 1;
          else rank = atoms[index - 1] === "," ? 3 : 2;
        }
        if (rank >= best.rank) {
          best = { rank, end: index, next: index + 1, open };
        }
      }
      const after = openAfter(open, atom);
      const afterClosingLength =
        after === open ? closingLength : closing(after).length;
      if (length + atom.length + afterClosingLength > limit) break;
      open = after;
      length += atom.length;
      closingLength = afterClosingLength;
    }
    if (index === atoms.length) {
      best = { rank: 0, end: index, next: index, open };
    } else if (best.rank < 0) {
      // An atom that fits no part is given one anyway, so nothing is dropped.
      const end = Math.max(index, start + 1);
      best = {
        rank: 0,
        end,
        next: end,
        open: end > index ? openAfter(open, atoms[index]) : open
      };
    }
    parts.push(
      opened.join("") +
        atoms.slice(start, best.end).join("") +
        closing(best.open)
    );
    start = best.next;
    opened = best.open;
  }
  return parts;
}

/**
 * Lays a text out as messages within the limit, in order, each filled before
 * the next is begun. The text is given as paragraphs, each a list of blocks:
 * a block within the limit is never divided, so one whose HTML is complete
 * keeps every message valid on its own. Blocks are set on lines of their own,
 * with a blank line between paragraphs.
 *
 * A single block over the limit is divided into parts within it, each valid
 * HTML on its own, and each after the first begins a message.
 */
export function layOutMessages(paragraphs: string[][]) {
  const messages: string[] = [];
  let message = "";
  for (const blocks of paragraphs) {
    blocks.forEach((block, index) => {
      const [first, ...rest] = divideBlock(block, MESSAGE_LIMIT);
      const extended = message + (index === 0 ? "\n\n" : "\n") + first;
      if (message === "") message = first;
      else if (extended.length <= MESSAGE_LIMIT) message = extended;
      else {
        messages.push(message);
        message = first;
      }
      for (const part of rest) {
        messages.push(message);
        message = part;
      }
    });
  }
  if (message !== "") messages.push(message);
  return messages;
}

type Update = {
  message?: { chat?: { id?: number }; text?: string };
};

/**
 * The text of the message an update carries, if it is a message from the
 * user's chat. Null for anything else, which the caller must drop. A message
 * without text (a photo, a sticker) reads as empty text.
 */
export function textFromMyChat(update: unknown, chatId: string) {
  const message = (update as Update | null)?.message;
  if (!message || String(message.chat?.id) !== chatId.trim()) return null;
  return message.text ?? "";
}

/** Whether a message is the `/preview` command, the only one the bot has. */
export function isPreviewCommand(text: string) {
  // Telegram appends the bot's name to a command picked from its menu.
  return /^\/preview(@\w+)?$/.test(text.trim());
}

/**
 * Whether a webhook request carries the secret the webhook was registered
 * with. Telegram sends it in a header on every update.
 */
export function hasWebhookSecret(request: Request, secret: string) {
  // An unset secret must not match a request that sends none.
  if (secret === "") return false;
  const given = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  // Comparing digests keeps the comparison constant-time whatever the lengths.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(secret));
}
