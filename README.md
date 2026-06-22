# slack-archiver

Lightweight Slack message archiver and search tool for small Slack workspaces.

This project targets a low-operations AWS serverless architecture suitable for low-volume workspaces, especially where Slack's free-plan history limits make long-term message search difficult.

## Intended architecture

```text
Slack Events API / Slash Commands
        ↓
Amazon API Gateway HTTP API
        ↓
AWS Lambda
        ↓
Amazon DynamoDB
```

Optional frontend:

```text
S3 static site + CloudFront
        ↓
Cognito User Pool sign-in
        ↓
API Gateway JWT authorizer
        ↓
Lambda search API
```

## Initial scope

- Receive Slack message events.
- Verify Slack request signatures.
- Store normalized message records in DynamoDB.
- Build a simple n-gram search index for Japanese and English text.
- Search from a Slack slash command or future web UI.
- Avoid EC2 and always-on compute.

## Non-goals for the first version

- Storing file bodies.
- Enterprise-grade eDiscovery.
- Full Slack export replacement.
- OpenSearch deployment.
- Multi-workspace SaaS operation.

## Repository layout

```text
docs/
  architecture.md
  auth.md
  data-model.md
src/
  common/
  ingest/
  search/
template.yaml
```

## Deployment direction

The first deploy target is AWS SAM. The template is intentionally minimal and should be extended after Slack app details and domain/auth decisions are fixed.
