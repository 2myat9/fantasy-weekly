// A stand-in for FantasyPros: its sign-in service and its MCP server, served
// through `fakeOutboundHttp` at the URLs the real ones have. The metadata is
// what FantasyPros published on 14 October 2026. It checks what the real ones
// would: that a sign-in link names a client metadata document the Worker
// serves, with the link's redirect address in it, that a code is redeemed by
// the client it was issued to, with the verifier of its challenge and its
// redirect address, that a refresh token is one it issued and has not
// replaced, and that every MCP request carries an access token that is live.
import { createHash } from "node:crypto";
import { fetchFromWorker } from "./harness";

const API = "https://api.fantasypros.com";
const SECURE = "https://secure.fantasypros.com";

export const FANTASYPROS = {
  mcp: `${API}/mcp`,
  resourceMetadata: `${API}/.well-known/oauth-protected-resource/mcp`,
  serverMetadata: `${SECURE}/.well-known/oauth-authorization-server`,
  authorize: `${SECURE}/oauth/authorize/`,
  token: `${SECURE}/oauth/token/`,
  register: `${SECURE}/oauth/register/`
};

/** One call of a tool, as FantasyPros' MCP server received it. */
export type ToolCall = {
  name: string;
  arguments: unknown;
  accessToken: string;
};

const SESSION_ID = "fake-session";

let issued = 0;

/** A token or code FantasyPros has not issued before. */
function fresh(kind: string) {
  issued++;
  return `${kind}-${issued}`;
}

function challengeOf(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function invalidGrant() {
  return Response.json({ error: "invalid_grant" }, { status: 400 });
}

/**
 * A FantasyPros that issues access tokens lasting `accessTokenSeconds`. Each
 * tool answers with the result `tools` gives for its arguments.
 */
export function fakeFantasyPros({
  accessTokenSeconds = 3600,
  tools = {
    injury_status: () => ({ content: [{ type: "text", text: "{}" }] })
  }
}: {
  accessTokenSeconds?: number;
  tools?: Record<string, (args: unknown) => unknown>;
} = {}) {
  const codes = new Map<
    string,
    { clientId: string; challenge: string; redirectUri: string }
  >();
  const accessTokens = new Map<string, { expiresAt: number }>();
  const refreshTokens = new Map<string, { clientId: string }>();
  // Every grant redeemed at the token endpoint, refused ones included.
  const grants: string[] = [];
  const toolCalls: ToolCall[] = [];

  function tokens(clientId: string) {
    const accessToken = fresh("access");
    const refreshToken = fresh("refresh");
    accessTokens.set(accessToken, {
      expiresAt: Date.now() + accessTokenSeconds * 1000
    });
    refreshTokens.set(refreshToken, { clientId });
    return Response.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: accessTokenSeconds,
      refresh_token: refreshToken,
      scope: "user:read offline_access"
    });
  }

  // How long FantasyPros takes to answer a renewal.
  let renewalMs = 0;

  async function token(request: Request) {
    const form = new URLSearchParams(await request.text());
    const grant = form.get("grant_type") ?? "";
    grants.push(grant);
    if (grant === "refresh_token" && renewalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, renewalMs));
    }
    const clientId = form.get("client_id") ?? "";
    if (grant === "authorization_code") {
      const code = codes.get(form.get("code") ?? "");
      if (
        !code ||
        code.clientId !== clientId ||
        code.redirectUri !== form.get("redirect_uri") ||
        code.challenge !== challengeOf(form.get("code_verifier") ?? "")
      ) {
        return invalidGrant();
      }
      codes.delete(form.get("code")!);
      return tokens(clientId);
    }
    if (grant === "refresh_token") {
      const refreshToken = form.get("refresh_token") ?? "";
      if (refreshTokens.get(refreshToken)?.clientId !== clientId) {
        return invalidGrant();
      }
      // FantasyPros replaces the refresh token each time it is used.
      refreshTokens.delete(refreshToken);
      return tokens(clientId);
    }
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }

  // FantasyPros registers a client only for redirect addresses it allows,
  // such as a loopback one, and a Worker's is not among them.
  function register() {
    return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
  }

  function unauthorized() {
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32001, message: "Missing Authentication Token" }
      },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${FANTASYPROS.resourceMetadata}", scope="user:read"`
        }
      }
    );
  }

  async function mcp(request: Request) {
    const accessToken = /^Bearer (.+)$/.exec(
      request.headers.get("Authorization") ?? ""
    )?.[1];
    const live = accessToken && accessTokens.get(accessToken);
    if (!live || live.expiresAt <= Date.now()) return unauthorized();
    const message = await request.json<{
      id?: number;
      method: string;
      params?: { name: string; arguments: unknown };
    }>();
    if (message.method === "initialize") {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fantasypros", version: "1.0.0" }
          }
        },
        { headers: { "Mcp-Session-Id": SESSION_ID } }
      );
    }
    if (request.headers.get("Mcp-Session-Id") !== SESSION_ID) {
      return new Response("Bad Request: no valid session", { status: 400 });
    }
    if (message.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (message.method === "tools/call") {
      const { name, arguments: args } = message.params!;
      toolCalls.push({ name, arguments: args, accessToken });
      // A tool's result comes as an event stream, as servers may send it.
      const result = {
        jsonrpc: "2.0",
        id: message.id,
        result: tools[name](args)
      };
      return new Response(
        `event: message\ndata: ${JSON.stringify(result)}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } }
      );
    }
    return Response.json({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" }
    });
  }

  /**
   * The user, in a browser, opening a sign-in link and signing in. FantasyPros
   * reads the client metadata document the link's client ID is the address
   * of, from the Worker. Gives the address FantasyPros sends the browser back
   * to.
   */
  async function signIn(link: string) {
    const query = new URL(link).searchParams;
    const clientId = query.get("client_id")!;
    const redirectUri = query.get("redirect_uri")!;
    const document = await fetchFromWorker(clientId);
    const metadata =
      document.status === 200 &&
      document.contentType?.startsWith("application/json")
        ? (JSON.parse(document.body) as {
            client_id?: string;
            redirect_uris?: string[];
          })
        : null;
    if (
      metadata?.client_id !== clientId ||
      !metadata.redirect_uris?.includes(redirectUri)
    ) {
      throw new Error(`FantasyPros does not know the sign-in link ${link}`);
    }
    const code = fresh("code");
    codes.set(code, {
      clientId,
      challenge: query.get("code_challenge")!,
      redirectUri
    });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", query.get("state")!);
    return back.toString();
  }

  /** The user opening a sign-in link and declining to sign in. */
  function decline(link: string) {
    const query = new URL(link).searchParams;
    const back = new URL(query.get("redirect_uri")!);
    back.searchParams.set("error", "access_denied");
    back.searchParams.set("state", query.get("state")!);
    return back.toString();
  }

  /**
   * Makes FantasyPros slow to answer a renewal, so that calls made at about
   * the same time are all under way before the first renewal is answered.
   */
  function answerRenewalsAfter(ms: number) {
    renewalMs = ms;
  }

  /** FantasyPros ending the sign-in: its refresh tokens stop working. */
  function revoke() {
    refreshTokens.clear();
  }

  return {
    /** The saved responses for `fakeOutboundHttp`. */
    responses: {
      [FANTASYPROS.resourceMetadata]: {
        authorization_servers: [SECURE],
        resource: FANTASYPROS.mcp
      },
      [FANTASYPROS.serverMetadata]: {
        issuer: SECURE,
        authorization_endpoint: FANTASYPROS.authorize,
        token_endpoint: FANTASYPROS.token,
        registration_endpoint: FANTASYPROS.register,
        client_id_metadata_document_supported: true,
        scopes_supported: ["user:read", "offline_access"],
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: [
          "client_secret_post",
          "client_secret_basic",
          "none"
        ],
        code_challenge_methods_supported: ["plain", "S256"],
        grant_types_supported: ["authorization_code", "refresh_token"]
      },
      [FANTASYPROS.register]: register,
      [FANTASYPROS.token]: token,
      [FANTASYPROS.mcp]: mcp
    },
    signIn,
    decline,
    revoke,
    answerRenewalsAfter,
    grants,
    toolCalls
  };
}
