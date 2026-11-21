# AI search API and MCP server

## Architecture

```text
Web UI ─ Cognito ID token ─ /api/ai/* ─ Lambda ─┐
                                                 ├─ DynamoDB messages and token index
MCP client ─ Cognito access token ─ /mcp ─ Lambda ┘
```

The AI API and MCP tools use the same bounded search and message/thread functions. Before returning archived messages, both verify their channel IDs against Slack's current public-channel list; this also excludes channels whose IDs do not encode their current visibility. The MCP endpoint uses the official `@modelcontextprotocol/sdk` Streamable HTTP transport in stateless JSON-response mode. It creates no session table, container, Gateway, or always-on service.

Cognito is the OAuth authorization server. MCP uses a separate public app client; it does not accept the Web UI's ID token. The MCP Lambda validates the Cognito access token, requires the exact `/mcp` resource audience and the resource-specific `<McpResourceUrl>/read` scope, then calls Cognito UserInfo and uses its Slack team claim as the only workspace scope. Tool arguments never include a trusted `team_id`.

## AI API

All routes require the current Web UI Cognito **ID token** in `Authorization: Bearer ...`. They use the signed-in Slack workspace claim and the optional `AllowedSlackTeamIds` allowlist.

### `POST /api/ai/search`

```json
{
  "query": "lambda timeout",
  "mode": "and",
  "channel_id": "C0123456789",
  "after": "2026-01-01T00:00:00Z",
  "before": "2026-06-01T00:00:00Z",
  "limit": 20,
  "cursor": null
}
```

- `mode` is `phrase` (default) or `and`. Dates are inclusive ISO 8601 timestamps.
- `limit` is 1–50; omitted defaults to 20. Only public-channel human messages are returned.
- The response contains `results` and `next_cursor`. A page may contain fewer results than requested when index candidates fail filters. Continue while `next_cursor` is non-null.
- Cursors are encrypted with the dedicated `/slack-archiver/ai-cursor-encryption-key` SecureString and bound to the authenticated workspace and query/filter values. Treat them as opaque; rotating this key invalidates existing cursors.
- Phrase mode matches normalized text as a substring after candidate lookup. Candidate lookup requires the longest query token to exactly match an indexed token, so partial words or punctuation variants can miss; use n-gram indexing if those searches become a requirement. AND mode requires every normalized query token.
- The current index sorts channel before timestamp. The API scans that token partition with a cursor and sorts each page newest-first; it does not promise global relevance or newest-first ordering across pages.

Each result contains `message_id`, authenticated `team_id`, `channel_id`/`channel_name`, `user_id`/`user_name`, `ts`, `thread_ts`, raw Slack `text`, ISO `time`, and `archive_url`.

### `GET /api/ai/messages/{channel_id}/{ts}`

Returns one non-deleted public-channel message or `404`. The query is always scoped to the authenticated workspace.

### `GET /api/ai/threads/{channel_id}/{root_ts}`

Returns the archived root, when available, and up to 50 replies in timestamp order, plus `next_cursor`. A deleted root is `null`; its replies remain retrievable. The root is repeated on every page when available. Replies are paginated by querying the channel's timestamp partition after the root; no unbounded table scan or new GSI is required. A page can contain fewer replies if intervening channel messages do not belong to the thread.

### `GET /api/ai/channels`

Lists public channels visible to the installed archiver bot in that workspace, using the existing Slack `conversations.list` integration.

### Authenticated archive links

`archive_url` opens `/web?channel_id=...&ts=...`. The Web UI requests the message with its own authenticated ID token. A deleted message or a message outside the signed-in workspace is unavailable; the link itself does not grant access.

## MCP tools

Endpoint: `POST /mcp` (Streamable HTTP). The server is stateless and returns JSON responses. It does not support SSE streams or MCP session IDs; `GET` and other methods return `405`.

The protected-resource metadata is served at:

```text
GET /.well-known/oauth-protected-resource/mcp
```

It advertises the Cognito User Pool issuer, the `openid profile email` scopes used for UserInfo, and the resource-specific `<McpResourceUrl>/read` scope. An unauthenticated request to `/mcp` returns a `401` Bearer challenge referencing this metadata.

| Tool | Inputs | Result |
|---|---|---|
| `search_messages` | `query`, optional `mode`, `channel_id`, `after`, `before`, `limit`, `cursor` | Results with authenticated archive links and a continuation cursor. |
| `get_message` | `channel_id`, `ts` | One non-deleted message with an archive link. |
| `get_thread` | `channel_id`, `root_ts`, optional `limit`, `cursor` | Root, one page of replies, and a continuation cursor. |
| `list_channels` | None | Public channels visible to the archiver bot. |

The MCP tools return both JSON text content and `structuredContent`. Limits match the API (maximum 50 per page). Errors are bounded machine-readable codes; no AWS/SSM values are returned. Archived Slack text is untrusted user-generated content and is described that way to clients. No Slack write tools are exposed.

## OAuth and deployment

The stack creates a separate Cognito public app client and a `read` scope on the resource server whose identifier is the exact MCP endpoint URL. It enables refresh-token rotation for the public client and uses Slack OIDC through the existing Cognito User Pool. Do not configure an app-client secret, enable dynamic client registration, or reuse the Web UI client.

Cognito resource binding requires Managed Login v2 and the Essentials or Plus feature plan. The stack pins the User Pool to Essentials, enables Managed Login v2, and applies Cognito-provided branding to both app clients. Upgrading an existing Lite pool may increase Cognito charges; confirm pricing before deployment. Switching the domain version invalidates existing Hosted UI sessions, so users may need to sign in again.

1. Add each MCP client's exact OAuth callback URL to `McpOAuthCallbackUrls`. The defaults include Claude's `https://claude.ai/api/mcp/auth_callback` and Hermes CLI's `http://localhost:27890/callback`; for ChatGPT, use the exact callback URL shown for the connection. These callbacks belong in Cognito's app-client callback list, **not** in Slack's redirect URL list. The Slack redirect URL remains Cognito's `/oauth2/idpresponse`.
2. If a client sends an `Origin` header, it must match the MCP endpoint origin or an entry in `McpAllowedOrigins`. Set that parameter to the browser origins used by the client.
3. Deploy and read `McpOAuthClientId`, `McpResourceUrl`, and `McpOAuthDiscoveryUrl` from stack outputs. Configure the client with the public client ID and no client secret.
4. The client must use authorization-code flow with PKCE S256, request `openid email profile <McpResourceUrl>/read`, select Slack as the identity provider, and send the exact `McpResourceUrl` as the OAuth resource indicator.
5. The client discovers Cognito's authorization and token endpoints from the User Pool OIDC document. The MCP protected-resource metadata advertises the User Pool issuer, not the Hosted UI hostname.

### Hermes Agent CLI v0.23.1

Hermes supports remote Streamable HTTP MCP servers with OAuth 2.1 PKCE. Configure the CLI with the public client ID from `McpOAuthClientId` and the pre-registered callback:

```yaml
mcp_servers:
  slack_archiver:
    url: "<McpResourceUrl>"
    auth: oauth
    oauth:
      client_id: "<McpOAuthClientId>"
      redirect_host: localhost
      redirect_port: 27890
```

Do not set a client secret. On a remote TrueNAS host, run `hermes mcp login slack_archiver` in the same profile used by the web app or gateway. Open the authorization URL in a browser. If the loopback callback cannot reach the container, copy the full redirect URL from the browser and paste it into the Hermes CLI prompt; do not send it through chat. Verify the connection with `hermes mcp test slack_archiver`. Persist the active Hermes home so its OAuth tokens survive container restarts. Hermes CLI calls do not need an additional `McpAllowedOrigins` entry because they do not send a browser `Origin` header.

The MCP Lambda accepts only access tokens with `token_use=access`, the dedicated MCP `client_id`, a matching `aud` resource, an unexpired `exp`, and the resource-specific `<McpResourceUrl>/read` scope. It then calls Cognito's `/oauth2/userInfo`, requires the returned `sub` to match the token, validates the Slack workspace claim, and applies the optional allowlist. An ID token, Web UI client token, wrong audience, missing Slack claim, or disallowed workspace is rejected. No caller-supplied workspace value is used.

Cognito UserInfo reads the Slack attributes mapped during Slack OIDC login. The app clients need those attributes readable and writable for Cognito's IdP mapping, but must not allow the `aws.cognito.signin.user.admin` OAuth scope; the OAuth access token must not permit self-service changes to the workspace claim. The AI API and MCP Lambda roles need read access to the dedicated cursor-encryption SSM parameter; they do not need access to the Slack signing secret. Cognito supports PKCE S256, but its discovery metadata may omit `code_challenge_methods_supported`; a client that requires this field to be advertised may reject Cognito even when S256 works. Validate the deployed discovery document and attribute permissions before rollout.

### Manual OAuth verification

CI exercises Streamable HTTP using the official MCP SDK client and tests token/workspace checks with verified-token fixtures. It cannot sign in to the deployed Slack OIDC provider. Before connecting a production client:

1. Check the User Pool OIDC discovery document advertises `S256`.
2. Complete a real authorization-code + PKCE login and inspect the access token: `token_use=access`, `client_id` equals `McpOAuthClientId`, `aud` equals `McpResourceUrl`, and scope contains `<McpResourceUrl>/read`.
3. Call Cognito UserInfo with that access token and confirm `sub` and `custom:slack_team_id` are present. Cognito returns the mapped custom attribute; the handler also accepts the Slack-namespaced claim when present.
4. Connect an MCP client, list tools, search a known message, and open its authenticated `archive_url`.
5. Repeat with two workspaces and confirm a forged tool `team_id` cannot change the returned workspace. Confirm an ID token is rejected.

Static OAuth client IDs are supported; callback URLs are pre-registered in Cognito. Dynamic client registration is intentionally disabled. A client that requires open DCR rather than a configured client ID is not supported by this setup.

## Cost and repair

No fixed-cost MCP infrastructure is added. Each MCP request adds one Lambda invocation, one Cognito UserInfo request, and usage-based DynamoDB reads. A response containing messages also verifies current public-channel visibility with Slack's paginated `conversations.list` and resolves user names when available. A search page performs one token-index Query and at most 50 message Gets; a single-message request performs one Get, and a thread page performs a root Get and one channel Query. Cognito resource binding requires the Essentials or Plus feature plan, so check account pricing before rollout. No AgentCore Gateway or vector service is used.

Message edits/deletes conditionally update the authoritative message record and reconcile its token index in small DynamoDB transactions. If an invocation fails after updating a message, a Slack retry reuses the pending token set. For a complete manual repair or imported legacy data, run the full `reindex` from [backfill.md](backfill.md); first run `--dry-run`. Do not use `--limit` for repair: limited runs intentionally do not delete stale entries.
