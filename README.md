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

Web frontend and AI API:

```text
API Gateway HTTP API /web and /api/ai/*
        ↓
Cognito Hosted UI with Slack Sign in
        ↓
Lambda verifies the authenticated Slack workspace and searches DynamoDB
```

MCP clients use a separate Cognito OAuth access token and the stateless Streamable HTTP endpoint at `/mcp`.

## Initial scope

- Receive Slack message, edit, and delete events.
- Verify Slack request signatures.
- Store normalized message records in DynamoDB.
- Build a simple n-gram search index for Japanese and English text.
- Search from a Slack slash command.
- Search from a Slack-authenticated web UI and the read-only AI search API.
- Expose read-only archive tools through Streamable HTTP MCP.
- Export one public channel's archived messages from the Web UI as CSV.
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
  export-channel-messages.md
  import-slack-export.md
  mcp.md
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
8. `docs/import-slack-export.md`
9. `docs/export-channel-messages.md`
10. `docs/mcp.md`
11. `template.yaml`

## Required external inputs

These values are not stored in the repository and must be provided by the operator or execution environment:

- Target AWS account and region.
- Slack Signing Secret.
- Slack Bot User OAuth Token.
- Slack OIDC Client ID and Client Secret.
- Slack app name and target workspace.
- Whether private channels should be archived.
- Slack workspace team IDs for optional Web UI access control.

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

Before deployment, store secrets and the cursor encryption key in SSM Parameter Store:

- `/slack-archiver/slack-signing-secret`
- `/slack-archiver/ai-cursor-encryption-key` (generate a random 32-byte key)
- `/slack-archiver/workspaces/<TEAM_ID>/slack-bot-token`
- `/slack-archiver/slack-oidc-client-id`
- `/slack-archiver/slack-oidc-client-secret`
- `/slack-archiver/allowed-slack-team-ids` (optional)
- `/slack-archiver/cognito-domain-prefix`
- `/slack-archiver/web-base-url`

## Authentication direction

Slack-facing endpoints use Slack request signature verification.

The web app uses Cognito Hosted UI with Slack Sign in as an external OIDC provider. Web API routes use the authenticated Slack `team_id` claim. MCP uses a separate Cognito OAuth app client and resource-bound access tokens; the server resolves the workspace through Cognito UserInfo and ignores client-supplied team IDs. If an allowed-team list is configured, users outside that list are rejected. Do not implement custom password storage.
