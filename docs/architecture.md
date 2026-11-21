# Architecture

## Goals

- Archive messages from a Slack free-plan workspace before Slack history limits make them unavailable.
- Keep AWS cost near the free tier for a workspace with tens of messages per day.
- Avoid EC2, containers, NAT Gateway, OpenSearch, and other always-on infrastructure.
- Keep operational responsibility small.

## Recommended baseline

Use Slack Events API and Slash Commands as the ingestion/search entry points.

```text
Slack Events API ─┐
                  ├─ API Gateway HTTP API ─ Lambda ─ DynamoDB
Slack Slash Cmd ──┘

Web UI ─ Cognito (Slack OIDC) ─ API Gateway /api/* ─ Lambda ─┐
                                                            ├─ DynamoDB
MCP Client ─ Cognito OAuth access token ─ API Gateway /mcp ─ Lambda ┘
```

### Components

| Component | Purpose |
|---|---|
| Slack Events API | Sends new, edited, and deleted message events to the archive as they happen. |
| Slack Slash Command | Provides simple search from Slack, e.g. `/hi-nick aws lambda`. |
| API Gateway HTTP API | Public HTTPS endpoint for Slack and optional web frontend API. |
| Lambda | Slack signature verification, event revision handling, workspace-scoped APIs, and stateless MCP requests. |
| DynamoDB | Stores message records and optional search index entries. |
| Amazon S3 | Temporarily stores generated channel-export CSV files. |
| CloudWatch Logs | Short-retention logs for debugging. |

## Why not periodic Slack crawling?

Slack free-plan history availability is limited. The safer design is to capture new messages when Slack emits events, rather than depending on later bulk reads from Slack APIs.

## Why not OpenSearch?

OpenSearch would improve search quality, but it adds a persistent search service and non-trivial cost. For tens of messages per day, DynamoDB plus a small token or n-gram index is a better first implementation.

## Event ingestion flow

1. Slack posts an event to API Gateway.
2. Lambda validates the `X-Slack-Signature` and `X-Slack-Request-Timestamp` headers.
3. Lambda handles Slack URL verification challenges.
4. Lambda identifies the original message key and applies only a newer event revision with a DynamoDB condition.
5. Lambda stores the latest message or a body-free deletion tombstone.
6. Lambda reconciles token or n-gram index entries in revision-checked DynamoDB transactions. Older or duplicate deliveries cannot restore a deleted message.
7. A failed index reconciliation leaves its pending token set on the message; Slack retries the event, and the manual `reindex` repair converges the index from current message records.

## Search flow

1. User runs a Slack slash command or calls the web API.
2. Lambda normalizes the query.
3. Lambda looks up candidate message IDs from the search index.
4. Lambda fetches message records.
5. The API and `/hi-nick` filter stale index entries against the current message record before returning results.

## AI search API and MCP

The authenticated `/api/ai/*` routes and the read-only `/mcp` tools call the same bounded DynamoDB search and message/thread retrieval functions. Search uses one workspace-scoped token partition at a time; encrypted cursors bind the continuation to the authenticated workspace and original query. The index sort key is channel-first, so results are sorted newest-first within a returned page but are not globally relevance-ranked across pages.

MCP runs as a stateless Lambda behind the existing API Gateway HTTP API using the official Streamable HTTP SDK. Cognito is the OAuth authorization server; MCP requires an access token with the resource-specific read scope (`<McpResourceUrl>/read`) and an audience matching the exact `/mcp` resource URL. The handler resolves the Slack team from Cognito UserInfo and never accepts a team ID from tool arguments. It offers no write tools or session store.

See [MCP and AI API](mcp.md) for OAuth setup, route schemas, pagination, validation, and operational checks.

## Channel export flow

1. An authenticated Web UI user chooses a public channel.
2. The Web API scopes the request to the Slack workspace and records an export job.
3. An asynchronous worker queries the channel's DynamoDB partition in timestamp order.
4. The worker writes a UTF-8 CSV and uploads it to a private S3 bucket.
5. The owning user receives a short-lived presigned download URL.
6. DynamoDB TTL and the S3 lifecycle remove temporary export data after one day.

## Cost controls

- Do not put Lambda in a VPC.
- Do not create NAT Gateway.
- Set CloudWatch log retention to 7 or 14 days.
- Do not store Slack file bodies in the first version.
- MCP adds Lambda invocations and Cognito UserInfo requests only when a client calls it; it adds no AgentCore Gateway or always-on service. Cognito resource binding requires the Essentials or Plus plan; verify pricing and the deployed User Pool tier before rollout.
- Expire generated CSV exports after one day.
- Use DynamoDB provisioned capacity conservatively or on-demand with billing alarms, depending on account/free-tier strategy.
- Add AWS Budgets alert before deployment.
