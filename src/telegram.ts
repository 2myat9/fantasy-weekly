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

/**
 * Lays a text out as messages within the limit, in order, each filled before
 * the next is begun. The text is given as paragraphs, each a list of blocks:
 * a block is never divided, so one whose HTML is complete keeps every message
 * valid on its own. Blocks are set on lines of their own, with a blank line
 * between paragraphs.
 *
 * A single block over the limit is left as a message Telegram will refuse.
 */
export function layOutMessages(paragraphs: string[][]) {
  const messages: string[] = [];
  let message = "";
  for (const blocks of paragraphs) {
    blocks.forEach((block, index) => {
      const extended = message + (index === 0 ? "\n\n" : "\n") + block;
      if (message === "") message = block;
      else if (extended.length <= MESSAGE_LIMIT) message = extended;
      else {
        messages.push(message);
        message = block;
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
