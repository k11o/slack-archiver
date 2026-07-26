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
```

### Components

| Component | Purpose |
|---|---|
| Slack Events API | Sends new message events to the archive as they happen. |
| Slack Slash Command | Provides simple search from Slack, e.g. `/hi-nick aws lambda`. |
| API Gateway HTTP API | Public HTTPS endpoint for Slack and optional web frontend API. |
| Lambda | Signature verification, normalization, persistence, and search. |
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
4. Lambda deduplicates by Slack event ID or message timestamp.
5. Lambda stores the message record.
6. Lambda emits token or n-gram index records for search.

## Search flow

1. User runs a Slack slash command or calls the web API.
2. Lambda normalizes the query.
3. Lambda looks up candidate message IDs from the search index.
4. Lambda fetches message records.
5. Lambda reranks and returns the top results.

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
- Expire generated CSV exports after one day.
- Use DynamoDB provisioned capacity conservatively or on-demand with billing alarms, depending on account/free-tier strategy.
- Add AWS Budgets alert before deployment.
