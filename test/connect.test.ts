import { expect, it } from "vitest";
import { FANTASYPROS, fakeFantasyPros } from "./fantasypros";
import {
  callFantasyPros,
  deliverTelegramUpdate,
  fakeOutboundHttp,
  fantasyProsConnection,
  MY_CHAT_ID,
  openInBrowser,
  setClock,
  signInLink,
  textMessage
} from "./harness";

/** The texts of the Telegram messages sent, in order. */
function texts(messages: unknown[]) {
  return messages.map((message) => (message as { text: string }).text);
}

it("/connect from my chat is answered with a link to sign in to FantasyPros", async () => {
  const fantasyPros = fakeFantasyPros();
  const outbound = fakeOutboundHttp(fantasyPros.responses);

  await deliverTelegramUpdate(textMessage("/connect"));

  expect(outbound.telegramMessages).toEqual([
    {
      chat_id: String(MY_CHAT_ID),
      text: expect.stringMatching(
        /^Sign in to FantasyPros to connect it: <a href="[^"]+">sign in<\/a>$/
      ),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true }
    }
  ]);
  const link = new URL(signInLink(outbound.telegramMessages[0]));
  expect(`${link.origin}${link.pathname}`).toBe(FANTASYPROS.authorize);
  expect(Object.fromEntries(link.searchParams)).toEqual({
    response_type: "code",
    client_id: expect.any(String),
    redirect_uri: "https://fantasy-weekly.example/fantasypros/callback",
    scope: "user:read offline_access",
    state: expect.any(String),
    code_challenge: expect.any(String),
    code_challenge_method: "S256",
    resource: FANTASYPROS.mcp
  });
});

/** Sends /connect and gives the sign-in link the bot replied with. */
async function connect(outbound: ReturnType<typeof fakeOutboundHttp>) {
  await deliverTelegramUpdate(textMessage("/connect"));
  return signInLink(outbound.telegramMessages.at(-1));
}

const INJURY_STATUS_ARGS = { players: ["Drake Maye", "Chris Boswell"] };

it("completing the sign-in confirms it in my chat, and the agent can then call injury_status", async () => {
  const injuries = { content: [{ type: "text", text: "Drake Maye: healthy" }] };
  const fantasyPros = fakeFantasyPros({
    tools: { injury_status: () => injuries }
  });
  const outbound = fakeOutboundHttp(fantasyPros.responses);
  expect(await fantasyProsConnection()).toBe("not connected");

  const link = await connect(outbound);
  const callback = await openInBrowser(fantasyPros.signIn(link));

  expect(callback.status).toBe(200);
  expect(callback.page).toContain("FantasyPros is connected");
  expect(texts(outbound.telegramMessages).at(-1)).toBe(
    "FantasyPros is connected."
  );
  expect(await fantasyProsConnection()).toBe("connected");
  expect(await callFantasyPros("injury_status", INJURY_STATUS_ARGS)).toEqual({
    status: "connected",
    result: injuries
  });
  expect(fantasyPros.toolCalls).toEqual([
    {
      name: "injury_status",
      arguments: INJURY_STATUS_ARGS,
      accessToken: expect.any(String)
    }
  ]);
});

it("declining to sign in at FantasyPros tells my chat the sign-in failed", async () => {
  const fantasyPros = fakeFantasyPros();
  const outbound = fakeOutboundHttp(fantasyPros.responses);

  const link = await connect(outbound);
  const callback = await openInBrowser(fantasyPros.decline(link));

  expect(callback.status).toBe(200);
  expect(callback.page).toContain("The sign-in to FantasyPros failed");
  expect(texts(outbound.telegramMessages).at(-1)).toBe(
    "The sign-in to FantasyPros failed. Send /connect to try again."
  );
  expect(await fantasyProsConnection()).toBe("not connected");
  expect(await callFantasyPros("injury_status", INJURY_STATUS_ARGS)).toEqual({
    status: "not connected"
  });
});

const CALLBACK = "https://fantasy-weekly.example/fantasypros/callback";

/** The address FantasyPros sends the browser back to, with another state. */
function withState(address: string, state: string) {
  const forged = new URL(address);
  forged.searchParams.set("state", state);
  return forged.toString();
}

it("a callback for a sign-in the agent did not start is refused and changes nothing", async () => {
  const fantasyPros = fakeFantasyPros();
  const outbound = fakeOutboundHttp(fantasyPros.responses);

  const before = await openInBrowser(`${CALLBACK}?code=code-1&state=made-up`);
  const link = await connect(outbound);
  const sentAfterConnect = outbound.telegramMessages.length;
  const back = fantasyPros.signIn(link);
  const forged = await openInBrowser(withState(back, "made-up"));
  const stateless = await openInBrowser(`${CALLBACK}?code=code-1`);

  for (const refused of [before, forged, stateless]) {
    expect(refused.status).toBe(400);
    expect(refused.page).toBe("This is not a sign-in the bot started.");
  }
  expect(outbound.telegramMessages).toHaveLength(sentAfterConnect);
  expect(fantasyPros.grants).toEqual([]);
  expect(await fantasyProsConnection()).toBe("not connected");
  // The sign-in the agent did start can still be completed.
  expect((await openInBrowser(back)).status).toBe(200);
  expect(await fantasyProsConnection()).toBe("connected");
});

it("a sign-in already completed cannot be completed again", async () => {
  const fantasyPros = fakeFantasyPros();
  const outbound = fakeOutboundHttp(fantasyPros.responses);

  const back = fantasyPros.signIn(await connect(outbound));
  await openInBrowser(back);
  const sent = outbound.telegramMessages.length;
  const replayed = await openInBrowser(back);

  expect(replayed.status).toBe(400);
  expect(outbound.telegramMessages).toHaveLength(sent);
  expect(fantasyPros.grants).toEqual(["authorization_code"]);
});

it("after the access token expires, a call with nobody present renews the sign-in and reaches FantasyPros", async () => {
  setClock("2026-10-14T12:00:00Z");
  const fantasyPros = fakeFantasyPros({ accessTokenSeconds: 3600 });
  const outbound = fakeOutboundHttp(fantasyPros.responses);
  await openInBrowser(fantasyPros.signIn(await connect(outbound)));
  await callFantasyPros("injury_status", INJURY_STATUS_ARGS);

  setClock("2026-10-17T18:00:00Z");
  const later = await callFantasyPros("injury_status", INJURY_STATUS_ARGS);
  setClock("2026-10-24T18:00:00Z");
  const weekAfter = await callFantasyPros("injury_status", INJURY_STATUS_ARGS);

  expect(later.status).toBe("connected");
  expect(weekAfter.status).toBe("connected");
  // FantasyPros replaces the refresh token on each renewal, so the second
  // renewal works only with the token the first one was given.
  expect(fantasyPros.grants).toEqual([
    "authorization_code",
    "refresh_token",
    "refresh_token"
  ]);
  const tokensUsed = fantasyPros.toolCalls.map((call) => call.accessToken);
  expect(new Set(tokensUsed).size).toBe(3);
  expect(await fantasyProsConnection()).toBe("connected");
});

it("when FantasyPros refuses to renew the sign-in, the agent reports it lost and does not throw", async () => {
  setClock("2026-10-14T12:00:00Z");
  const fantasyPros = fakeFantasyPros({ accessTokenSeconds: 3600 });
  const outbound = fakeOutboundHttp(fantasyPros.responses);
  await openInBrowser(fantasyPros.signIn(await connect(outbound)));

  fantasyPros.revoke();
  setClock("2026-10-17T18:00:00Z");

  expect(await callFantasyPros("injury_status", INJURY_STATUS_ARGS)).toEqual({
    status: "lost"
  });
  expect(await fantasyProsConnection()).toBe("lost");
  // Nothing more is asked of FantasyPros once the sign-in is lost.
  expect(await callFantasyPros("injury_status", INJURY_STATUS_ARGS)).toEqual({
    status: "lost"
  });
  expect(fantasyPros.grants).toEqual(["authorization_code", "refresh_token"]);
  expect(fantasyPros.toolCalls).toEqual([]);
});

it("two calls that both find the access token expired leave the agent connected", async () => {
  setClock("2026-10-14T12:00:00Z");
  const fantasyPros = fakeFantasyPros({ accessTokenSeconds: 3600 });
  const outbound = fakeOutboundHttp(fantasyPros.responses);
  await openInBrowser(fantasyPros.signIn(await connect(outbound)));

  fantasyPros.answerRenewalsAfter(50);
  setClock("2026-10-17T18:00:00Z");
  const outcomes = await Promise.all([
    callFantasyPros("injury_status", INJURY_STATUS_ARGS),
    callFantasyPros("injury_status", INJURY_STATUS_ARGS)
  ]);

  expect(outcomes.map(({ status }) => status)).toEqual([
    "connected",
    "connected"
  ]);
  expect(await fantasyProsConnection()).toBe("connected");
  expect(
    (await callFantasyPros("injury_status", INJURY_STATUS_ARGS)).status
  ).toBe("connected");
});

it("a renewal FantasyPros refuses for a reason other than the sign-in is thrown, and the sign-in is kept", async () => {
  setClock("2026-10-14T12:00:00Z");
  const fantasyPros = fakeFantasyPros({ accessTokenSeconds: 3600 });
  const token = fantasyPros.responses[FANTASYPROS.token] as (
    request: Request
  ) => Promise<Response>;
  let malformed = false;
  const outbound = fakeOutboundHttp({
    ...fantasyPros.responses,
    [FANTASYPROS.token]: (request: Request) =>
      malformed
        ? Response.json({ error: "invalid_request" }, { status: 400 })
        : token(request)
  });
  await openInBrowser(fantasyPros.signIn(await connect(outbound)));

  malformed = true;
  setClock("2026-10-17T18:00:00Z");

  await expect(
    callFantasyPros("injury_status", INJURY_STATUS_ARGS)
  ).rejects.toThrow();
  expect(await fantasyProsConnection()).toBe("connected");
  malformed = false;
  expect(
    (await callFantasyPros("injury_status", INJURY_STATUS_ARGS)).status
  ).toBe("connected");
});

it("a sign-in completed more than 15 minutes after /connect fails and says so", async () => {
  setClock("2026-10-14T12:00:00Z");
  const fantasyPros = fakeFantasyPros();
  const outbound = fakeOutboundHttp(fantasyPros.responses);
  const back = fantasyPros.signIn(await connect(outbound));

  setClock("2026-10-14T12:16:00Z");
  const callback = await openInBrowser(back);

  expect(callback.page).toContain("The sign-in to FantasyPros failed");
  expect(texts(outbound.telegramMessages).at(-1)).toBe(
    "The sign-in to FantasyPros failed. Send /connect to try again."
  );
  expect(fantasyPros.grants).toEqual([]);
  expect(await fantasyProsConnection()).toBe("not connected");
});

it("/connect when already connected signs in again and replaces the old sign-in", async () => {
  const fantasyPros = fakeFantasyPros();
  const outbound = fakeOutboundHttp(fantasyPros.responses);
  await openInBrowser(fantasyPros.signIn(await connect(outbound)));
  await callFantasyPros("injury_status", INJURY_STATUS_ARGS);

  const second = await connect(outbound);
  // Until the new sign-in is completed, the old one is still used.
  await callFantasyPros("injury_status", INJURY_STATUS_ARGS);
  await openInBrowser(fantasyPros.signIn(second));
  await callFantasyPros("injury_status", INJURY_STATUS_ARGS);

  const [first, beforeSecond, afterSecond] = fantasyPros.toolCalls.map(
    (call) => call.accessToken
  );
  expect(beforeSecond).toBe(first);
  expect(afterSecond).not.toBe(first);
  expect(texts(outbound.telegramMessages).at(-1)).toBe(
    "FantasyPros is connected."
  );
});

it("/connect after the sign-in was lost connects the agent again", async () => {
  setClock("2026-10-14T12:00:00Z");
  const fantasyPros = fakeFantasyPros({ accessTokenSeconds: 3600 });
  const outbound = fakeOutboundHttp(fantasyPros.responses);
  await openInBrowser(fantasyPros.signIn(await connect(outbound)));
  fantasyPros.revoke();
  setClock("2026-10-17T18:00:00Z");
  await callFantasyPros("injury_status", INJURY_STATUS_ARGS);

  await openInBrowser(fantasyPros.signIn(await connect(outbound)));

  expect(await fantasyProsConnection()).toBe("connected");
  expect(
    (await callFantasyPros("injury_status", INJURY_STATUS_ARGS)).status
  ).toBe("connected");
});

it("/connect from another chat is ignored", async () => {
  const fantasyPros = fakeFantasyPros();
  const outbound = fakeOutboundHttp(fantasyPros.responses);

  await deliverTelegramUpdate(textMessage("/connect", MY_CHAT_ID + 1));

  expect(outbound.telegramMessages).toEqual([]);
  expect(outbound.requests).toEqual([]);
});

it("/connect when FantasyPros cannot be reached says the sign-in could not be started", async () => {
  const outbound = fakeOutboundHttp({
    [FANTASYPROS.resourceMetadata]: new Response("Bad Gateway", {
      status: 502
    })
  });

  await deliverTelegramUpdate(textMessage("/connect"));

  expect(texts(outbound.telegramMessages)).toEqual([
    "The sign-in to FantasyPros could not be started. Send /connect to try again."
  ]);
});
