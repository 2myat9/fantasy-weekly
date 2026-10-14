// The FantasyPros client: signs the agent in to FantasyPros' MCP server as the
// user, keeps the sign-in in the agent's storage, and calls the server's
// tools. FantasyPros accepts only an OAuth sign-in in a browser, so a person
// signs in once and every call after that refreshes the sign-in by itself.
//
// The Agents SDK's MCP client is not used: it reconnects to every server it
// has stored whenever the agent wakes, which spends outbound requests from
// whatever invocation woke it, and it answers a refused refresh by starting a
// new sign-in that nobody is there to finish. Every request here, the sign-in
// and the refresh included, is made only when a call needs it.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { retried } from "./retry";

const MCP = "https://api.fantasypros.com/mcp";
// Where FantasyPros names the service that signs users in to the MCP server.
const RESOURCE_METADATA =
  "https://api.fantasypros.com/.well-known/oauth-protected-resource/mcp";
// `offline_access` is what makes FantasyPros issue a refresh token.
const SCOPE = "user:read offline_access";

const PENDING = "fantasyPros:pendingSignIn";

/** A sign-in the agent has started and the user has yet to complete. */
type PendingSignIn = {
  state: string;
  codeVerifier: string;
  clientId: string;
  tokenEndpoint: string;
  redirectUri: string;
  /** In milliseconds since the epoch. */
  startedAt: number;
};

// How long the user has to complete a sign-in, so that an old link left in
// the chat cannot sign the agent in as whoever opens it.
const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;

async function readJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`FantasyPros ${url} returned ${response.status}`);
  }
  return response.json<T>();
}

/** Where an authorization server publishes its metadata, by RFC 8414. */
function serverMetadataUrl(issuer: string) {
  const { origin, pathname } = new URL(issuer);
  const path = pathname === "/" ? "" : pathname.replace(/\/$/, "");
  return `${origin}/.well-known/oauth-authorization-server${path}`;
}

/**
 * Starts a sign-in, and gives the link at FantasyPros where the user signs
 * in. FantasyPros then sends the browser to `redirectUri`, whose request is
 * handed to `completeSignIn`. A sign-in started before is replaced: only the
 * latest can be completed.
 */
export async function startSignIn(
  storage: DurableObjectStorage,
  redirectUri: string
) {
  const resource = await readJson<{ authorization_servers: string[] }>(
    RESOURCE_METADATA
  );
  const server = await readJson<{
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
  }>(serverMetadataUrl(resource.authorization_servers[0]));
  // The agent registers itself afresh for each sign-in, so it needs no
  // client of its own set up at FantasyPros. It has no secret to keep.
  const { client_id: clientId } = await readJson<{ client_id: string }>(
    server.registration_endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Fantasy Weekly",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: SCOPE
      })
    }
  );
  const pending: PendingSignIn = {
    state: randomBytes(32).toString("base64url"),
    codeVerifier: randomBytes(32).toString("base64url"),
    clientId,
    tokenEndpoint: server.token_endpoint,
    redirectUri,
    startedAt: Date.now()
  };
  storage.kv.put(PENDING, pending);
  const link = new URL(server.authorization_endpoint);
  link.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state: pending.state,
    code_challenge: createHash("sha256")
      .update(pending.codeVerifier)
      .digest("base64url"),
    code_challenge_method: "S256",
    resource: MCP
  }).toString();
  return link.toString();
}

const SIGN_IN = "fantasyPros:signIn";

/** A completed sign-in: what the agent calls FantasyPros with. */
type SignIn = {
  clientId: string;
  tokenEndpoint: string;
  accessToken: string;
  /** Null when FantasyPros issued none, and the sign-in cannot be renewed. */
  refreshToken: string | null;
  /** In milliseconds since the epoch. Null when FantasyPros did not say. */
  expiresAt: number | null;
};

/**
 * What is stored of the sign-in: the sign-in itself, or "lost" once
 * FantasyPros has refused to renew it.
 */
type Stored = SignIn | "lost";

/**
 * Whether the agent can call FantasyPros: it is connected, it has never been
 * signed in, or its sign-in was lost when FantasyPros refused to renew it.
 * Only `/connect` connects it again.
 */
export type Connection = "connected" | "not connected" | "lost";

export function connection(storage: DurableObjectStorage): Connection {
  const stored = storage.kv.get<Stored>(SIGN_IN);
  if (stored === undefined) return "not connected";
  return stored === "lost" ? "lost" : "connected";
}

type TokenResponse = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
};

// The OAuth errors that refuse the grant itself or the client it was made for,
// which asking again will not change. Any other error is thrown.
const REFUSALS = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client"
]);

// What FantasyPros' token endpoint answers a grant with. Null when it refuses
// the grant.
async function redeem(tokenEndpoint: string, grant: Record<string, string>) {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...grant, resource: MCP })
  });
  if (response.ok) return response.json<TokenResponse>();
  const body = await response.text();
  let error: unknown;
  try {
    error = (JSON.parse(body) as { error?: unknown }).error;
  } catch {
    error = undefined;
  }
  if (typeof error === "string" && REFUSALS.has(error)) {
    console.error("FantasyPros refused a grant", grant.grant_type, body);
    return null;
  }
  throw new Error(
    `FantasyPros' token endpoint answered ${grant.grant_type} with ${response.status}: ${body}`
  );
}

function signInFrom(
  tokens: TokenResponse,
  { clientId, tokenEndpoint }: { clientId: string; tokenEndpoint: string },
  previousRefreshToken: string | null = null
): SignIn {
  return {
    clientId,
    tokenEndpoint,
    accessToken: tokens.access_token,
    // A refresh that issues no new refresh token leaves the old one in use.
    refreshToken: tokens.refresh_token ?? previousRefreshToken,
    expiresAt:
      tokens.expires_in === undefined
        ? null
        : Date.now() + tokens.expires_in * 1000
  };
}

/** The address FantasyPros sent the browser back to, as the agent reads it. */
export type SignInCallback = {
  state: string | null;
  code: string | null;
  error: string | null;
};

/**
 * Completes the sign-in the agent started, from the address FantasyPros sent
 * the browser back to. "unknown" is a callback for no sign-in the agent
 * started, or for one already completed, and changes nothing. "failed" is a
 * sign-in the user declined, completed too late, or FantasyPros refused,
 * which leaves the agent signed in as it was.
 */
export async function completeSignIn(
  storage: DurableObjectStorage,
  callback: SignInCallback
): Promise<"connected" | "failed" | "unknown"> {
  const pending = storage.kv.get<PendingSignIn>(PENDING);
  if (!pending || !callback.state || !sameText(callback.state, pending.state)) {
    return "unknown";
  }
  // A sign-in is completed once, whatever comes of it.
  storage.kv.delete(PENDING);
  if (Date.now() - pending.startedAt > SIGN_IN_WINDOW_MS) {
    console.error("The sign-in to FantasyPros was completed too late");
    return "failed";
  }
  if (callback.error || !callback.code) {
    console.error("The sign-in to FantasyPros was declined", callback.error);
    return "failed";
  }
  const tokens = await redeem(pending.tokenEndpoint, {
    grant_type: "authorization_code",
    code: callback.code,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.codeVerifier
  }).catch((error) => {
    console.error("The sign-in code could not be redeemed", error);
    return null;
  });
  if (!tokens) return "failed";
  storage.kv.put<Stored>(SIGN_IN, signInFrom(tokens, pending));
  return "connected";
}

// Compared by digest, so the time taken says nothing of the stored state.
function sameText(given: string, expected: string) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

// How long before it expires an access token is renewed, so that it does not
// expire while a call is under way.
const RENEW_BEFORE_MS = 60 * 1000;

// The renewals under way, by the refresh token they use. Calls that find the
// sign-in expired together renew it once: FantasyPros replaces a refresh
// token when it is used, and would refuse it to the second.
const renewals = new Map<string, Promise<SignIn | null>>();

/**
 * Renews the sign-in with its refresh token. Null when FantasyPros refuses,
 * and the sign-in is then stored as lost.
 */
function renew(storage: DurableObjectStorage, signIn: SignIn) {
  const { refreshToken } = signIn;
  if (!refreshToken) return renewed(storage, signIn, null);
  let renewal = renewals.get(refreshToken);
  if (!renewal) {
    renewal = redeem(signIn.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: signIn.clientId
    })
      .then((tokens) => renewed(storage, signIn, tokens))
      .finally(() => renewals.delete(refreshToken));
    renewals.set(refreshToken, renewal);
  }
  return renewal;
}

// Stores what came of renewing a sign-in, unless a new sign-in was completed
// while the renewal was under way: that one stands.
function renewed(
  storage: DurableObjectStorage,
  signIn: SignIn,
  tokens: TokenResponse | null
) {
  const stored = storage.kv.get<Stored>(SIGN_IN);
  if (
    stored !== undefined &&
    stored !== "lost" &&
    stored.accessToken !== signIn.accessToken
  ) {
    return stored;
  }
  if (!tokens) {
    storage.kv.put<Stored>(SIGN_IN, "lost");
    return null;
  }
  const renewal = signInFrom(tokens, signIn, signIn.refreshToken);
  storage.kv.put<Stored>(SIGN_IN, renewal);
  return renewal;
}

/** A request FantasyPros' MCP server refused for its access token. */
class Unauthorized extends Error {
  constructor(method: string) {
    super(`FantasyPros' MCP server refused the access token for ${method}`);
  }
}

type RpcMessage = {
  id?: number;
  result?: unknown;
  error?: { message: string };
};

// FantasyPros' MCP session: the ID the server gave it and the version of the
// protocol agreed for it.
type Session = { id: string | null; version: string };

const PROTOCOL_VERSION = "2025-06-18";

async function post(
  accessToken: string,
  message: { id?: number; method: string; params?: unknown },
  session?: Session
) {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${accessToken}`
  });
  if (session?.id) headers.set("Mcp-Session-Id", session.id);
  if (session) headers.set("MCP-Protocol-Version", session.version);
  const response = await fetch(MCP, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", ...message })
  });
  if (response.status === 401) {
    // A body left unread keeps the connection open.
    await response.body?.cancel();
    throw new Unauthorized(message.method);
  }
  if (!response.ok) {
    throw new Error(
      `FantasyPros' MCP server answered ${message.method} with ${response.status}: ${await response.text()}`
    );
  }
  return response;
}

/**
 * The result of a request, from the server's answer: one JSON-RPC message,
 * or an event stream that carries it.
 */
async function resultOf(response: Response, id: number, method: string) {
  const type = response.headers.get("Content-Type") ?? "";
  let messages: RpcMessage[];
  if (type.includes("text/event-stream")) {
    messages = (await response.text())
      .split(/\r?\n\r?\n/)
      .map((event) =>
        event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n")
      )
      .filter((data) => data !== "")
      .map((data) => JSON.parse(data) as RpcMessage);
  } else {
    messages = [await response.json<RpcMessage>()];
  }
  const answer = messages.find((message) => message.id === id);
  if (!answer) throw new Error(`FantasyPros did not answer ${method}`);
  if (answer.error) {
    throw new Error(`FantasyPros answered ${method}: ${answer.error.message}`);
  }
  return answer.result;
}

// One tool call in a session of its own: three requests, the session's setup
// included. A session is not kept between calls, which are a run apart.
async function callWith(accessToken: string, name: string, args: unknown) {
  const initialize = await post(accessToken, {
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "fantasy-weekly", version: "1.0.0" }
    }
  });
  const { protocolVersion } = (await resultOf(initialize, 1, "initialize")) as {
    protocolVersion: string;
  };
  const session = {
    id: initialize.headers.get("Mcp-Session-Id"),
    version: protocolVersion
  };
  const initialized = await post(
    accessToken,
    { method: "notifications/initialized" },
    session
  );
  await initialized.body?.cancel();
  const call = await post(
    accessToken,
    { id: 2, method: "tools/call", params: { name, arguments: args } },
    session
  );
  return resultOf(call, 2, `tools/call ${name}`);
}

/** What came of calling a tool: its result, or why there is none. */
export type ToolOutcome =
  | { status: "connected"; result: unknown }
  | { status: "not connected" }
  | { status: "lost" };

/**
 * Calls one of FantasyPros' tools as the signed-in user, and gives the
 * server's result as it sent it. The sign-in is renewed first when its access
 * token has expired, or when the server refuses it. A sign-in that is missing,
 * or that FantasyPros refuses to renew, is reported rather than thrown; any
 * other failure is thrown.
 *
 * It makes three requests to FantasyPros, four when the access token has
 * expired, and up to seven when the server refuses a token that has not.
 */
export async function callTool(
  storage: DurableObjectStorage,
  name: string,
  args: unknown
): Promise<ToolOutcome> {
  const stored = storage.kv.get<Stored>(SIGN_IN);
  if (stored === undefined) return { status: "not connected" };
  if (stored === "lost") return { status: "lost" };
  let signIn: SignIn | null = stored;
  let renewed = false;
  if (
    signIn.expiresAt !== null &&
    signIn.expiresAt - RENEW_BEFORE_MS <= Date.now()
  ) {
    signIn = await renew(storage, signIn);
    if (!signIn) return { status: "lost" };
    renewed = true;
  }
  try {
    return {
      status: "connected",
      result: await callWith(signIn.accessToken, name, args)
    };
  } catch (error) {
    // A token just renewed that is refused will not do better renewed again.
    if (!(error instanceof Unauthorized) || renewed) throw error;
  }
  signIn = await renew(storage, signIn);
  if (!signIn) return { status: "lost" };
  return {
    status: "connected",
    result: await callWith(signIn.accessToken, name, args)
  };
}

/** A name FantasyPros matched to one of its players. */
export type ResolvedName = {
  /** The name as it was sent. */
  input: string;
  /** FantasyPros' name for the player, as its news items carry it. */
  name: string;
  /** As Sleeper abbreviates it. */
  team: string;
};

/** One of FantasyPros' news items. */
export type NewsItem = {
  /** FantasyPros' name for the player. */
  playerName: string;
  date: Date;
  text: string;
  /** The article at fantasypros.com, or null when the item has none. */
  link: string | null;
};

/** What FantasyPros has on a set of players, by name. */
export type PlayerNews = {
  resolved: ResolvedName[];
  /** The names FantasyPros could not match to a player. */
  unresolved: string[];
  /** The news of the last 14 days on the players it matched. */
  news: NewsItem[];
};

type InjuryStatus = {
  resolved_players?: { input: string; name: string; team_id: string }[];
  unresolved_names?: string[];
  player_news?: {
    player_name: string;
    published: string;
    news: string;
    url?: string | null;
  }[];
};

// Where FantasyPros abbreviates a team differently from Sleeper.
const SLEEPER_TEAM: Record<string, string> = { JAC: "JAX" };

// What a tool answered, from the JSON in its text. A tool that reports an
// error has answered nothing.
function answerOf(result: unknown, tool: string) {
  const { content = [], isError } = result as {
    content?: { type: string; text?: string }[];
    isError?: boolean;
  };
  const text = content.find((part) => part.type === "text")?.text;
  if (isError || text === undefined) {
    throw new Error(`FantasyPros' ${tool} failed: ${text}`);
  }
  return JSON.parse(text) as unknown;
}

// The time is written like `2026-10-12 05:23:26 UTC`.
function publishedAt(published: string) {
  return new Date(published.replace(" ", "T").replace(/ UTC$/, "Z"));
}

/** What came of reading FantasyPros' news: the news, or why there is none. */
export type PlayerNewsRead =
  | { status: "connected"; news: PlayerNews }
  | { status: "not connected" }
  | { status: "lost" };

/**
 * FantasyPros' news on the named players, from one call of its
 * `injury_status` tool. A call that fails is made again, like a read of any
 * other source; an answer that is not the news, such as an error or a notice
 * that the plan does not include the tool, is thrown, since asking again will
 * not change it. When the agent is not connected, or its sign-in was lost,
 * that is reported rather than thrown.
 */
export async function fetchPlayerNews(
  storage: DurableObjectStorage,
  names: string[]
): Promise<PlayerNewsRead> {
  const outcome = await retried(() =>
    callTool(storage, "injury_status", { player_names: names.join(", ") })
  );
  if (outcome.status !== "connected") return outcome;
  const answer = answerOf(outcome.result, "injury_status") as InjuryStatus;
  if (!Array.isArray(answer.resolved_players)) {
    throw new Error(
      `FantasyPros' injury_status did not answer with news: ${JSON.stringify(answer)}`
    );
  }
  return {
    status: "connected",
    news: {
      resolved: answer.resolved_players.map(({ input, name, team_id }) => ({
        input,
        name,
        team: SLEEPER_TEAM[team_id] ?? team_id
      })),
      unresolved: answer.unresolved_names ?? [],
      news: (answer.player_news ?? []).flatMap((item) => {
        const date = publishedAt(item.published);
        // An item that cannot be dated cannot be placed in the news window.
        if (isNaN(date.getTime()) || !item.news?.trim()) return [];
        return {
          playerName: item.player_name,
          date,
          text: item.news.trim(),
          link: item.url || null
        };
      })
    }
  };
}
