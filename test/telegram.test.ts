import { expect, it } from "vitest";
import {
  deliverTelegramUpdate,
  fakeOutboundHttp,
  MY_CHAT_ID,
  textMessage
} from "./harness";

it("/preview from my chat is answered with one message marked as a preview", async () => {
  const outbound = fakeOutboundHttp();

  await deliverTelegramUpdate(textMessage("/preview"));

  expect(outbound.telegramMessages).toEqual([
    {
      chat_id: String(MY_CHAT_ID),
      text: "<b>Preview</b>\nThe league messages are not written yet.",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true }
    }
  ]);
});

it("any other text from my chat is answered with a one-line hint naming /preview", async () => {
  const outbound = fakeOutboundHttp();

  await deliverTelegramUpdate(textMessage("who should I start?"));

  expect(outbound.telegramMessages).toEqual([
    {
      chat_id: String(MY_CHAT_ID),
      text: "Send /preview to see the digest as it would be written now.",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true }
    }
  ]);
});

it("an update from another chat sends nothing", async () => {
  const outbound = fakeOutboundHttp();

  await deliverTelegramUpdate(textMessage("/preview", MY_CHAT_ID + 1));

  expect(outbound.telegramMessages).toEqual([]);
});

it("a webhook request without the correct secret is rejected and sends nothing", async () => {
  const outbound = fakeOutboundHttp();

  const wrong = await deliverTelegramUpdate(textMessage("/preview"), {
    secret: "not-the-secret"
  });
  const missing = await deliverTelegramUpdate(textMessage("/preview"), {
    secret: null
  });

  expect(wrong.status).toBe(403);
  expect(missing.status).toBe(403);
  expect(outbound.telegramMessages).toEqual([]);
});

it("the webhook answers Telegram before the reply is sent", async () => {
  const outbound = fakeOutboundHttp();

  const delivery = await deliverTelegramUpdate(textMessage("/preview"));

  expect(delivery.status).toBe(200);
  expect(delivery.sentWhenAcknowledged).toBe(0);
  expect(outbound.telegramMessages).toHaveLength(1);
});
