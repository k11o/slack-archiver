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
- Search from a Slack-authenticated web UI.
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
  web-auth-slack-oidc.md
  codex-runbook.md
  data-model.md
  deployment.md
  slack-app.md
src/
  common/
  ingest/
  search/
template.yaml
```

## Read these first

For implementation and deployment work, read in this order:

1. `docs/codex-runbook.md`
2. `docs/deployment.md`
3. `docs/slack-app.md`
4. `docs/auth.md`
5. `docs/web-auth-slack-oidc.md`
6. `docs/architecture.md`
7. `docs/data-model.md`
8. `template.yaml`

## Required external inputs

These values are not stored in the repository and must be provided by the operator or execution environment:

- Target AWS account and region.
- Slack Signing Secret.
- Slack Bot User OAuth Token.
- Slack app name and target workspace.
- Whether private channels should be archived.
- Whether the first release should stay Slack-only or include a web UI.

Secrets must not be committed to Git.

## Deployment direction

The first deploy target is AWS SAM.

High-level flow:

```bash
npm install
uv run sam validate
uv run sam build
uv run sam deploy --guided
```

Before deployment, store Slack secrets in SSM Parameter Store:

- `/slack-archiver/slack-signing-secret`
- `/slack-archiver/slack-bot-token`

## Authentication direction

Slack-facing endpoints use Slack request signature verification.

The web app should not be implemented in the first pass unless explicitly requested. When added, use Cognito User Pool Hosted UI plus API Gateway HTTP API JWT authorizer. Do not implement custom password storage.
