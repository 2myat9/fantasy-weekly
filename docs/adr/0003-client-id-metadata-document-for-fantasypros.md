# A client ID metadata document for the FantasyPros sign-in, not dynamic client registration

`/connect` registered the agent at FantasyPros afresh for each sign-in, through the registration endpoint FantasyPros publishes. FantasyPros registers a client only for redirect addresses it allows, such as a loopback address or `https://claude.ai/api/mcp/auth_callback`, and answers any other, a `workers.dev` callback included, with `400 {"error": "invalid_redirect_uri"}` (checked on 14 October 2026). So `/connect` never got as far as a sign-in link. The Worker now serves a client metadata document at `GET /fantasypros/client.json`, and the sign-in link gives that address as its client ID. FantasyPros advertises `client_id_metadata_document_supported`, reads the document when the user opens the link, and sends the browser only to an address the document names.

## Considered Options

- **Sign in on a local machine, with a loopback callback that registration accepts, and hand the tokens to the deployed agent.** Rejected: the sign-in would need a step outside the bot every time it is lost, and the registration FantasyPros returned for a loopback client listed only `user:read`, dropping the `offline_access` that makes it issue a refresh token.
- **Ask FantasyPros to allow the Worker's callback address for registration.** Kept as the fallback if FantasyPros turns out to apply the same allow-list to metadata documents, which could not be checked without signing in.

## Consequences

- The client ID is on the Worker's URL, like the callback. A sign-in made through one URL is renewed with that client ID, so after the URL changes the old sign-in can stop renewing, and `/connect` is needed again.
- The Worker has a third route. It is public, and gives only what any sign-in link already shows.
- `/connect` makes two requests to FantasyPros, the metadata of the MCP server and of its sign-in service, where it made three.
