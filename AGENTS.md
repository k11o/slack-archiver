# Repository Instructions

## Project Scope

- Build a low-cost Slack archiver that supports multiple Slack workspaces.
- Keep the first release Slack-only. Do not implement the web UI unless explicitly requested.
- Private channels are out of scope for the current release.
- The active Slack slash command is `/hi-nick`; `/archive` was unavailable in the workspace.

## Local Tooling

- Use Node.js 24 or newer.
- Use Python 3.13.14 for uv-managed SAM CLI tooling. Python 3.14 is newer, but the current SAM CLI dependency set does not build reliably with it in this project.
- Run JavaScript tests with `npm test`.
- Manage SAM CLI through uv, using `pyproject.toml` and `uv.lock`.
- GitHub Actions CI should run the same test and SAM validation/build commands.
- Use these validation commands before deployment:

```bash
npm test
uv run sam validate
uv run sam build
```

## AWS Deployment

- Target profile: `<AWS_PROFILE>`.
- Target region: `ap-northeast-1`.
- Stack name: `slack-archiver`.
- Deploy with:

```bash
uv run sam deploy \
  --stack-name slack-archiver \
  --profile <AWS_PROFILE> \
  --region ap-northeast-1 \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset
```

## Secrets

- Never commit Slack secrets or tokens.
- Required SSM SecureString parameters:
  - `/slack-archiver/slack-signing-secret` (shared across workspaces)
  - `/slack-archiver/slack-app-client-id` (Slack app Client ID for bot install OAuth exchange)
  - `/slack-archiver/slack-app-client-secret` (Slack app Client Secret for bot install OAuth exchange)
  - `/slack-archiver/workspaces/<TEAM_ID>/slack-bot-token` (one per installed Slack workspace; written automatically by `InstallFunction` on install)
- Optional SSM parameter for Web UI access control:
  - `/slack-archiver/allowed-slack-team-ids` (comma-separated; when absent, any Slack-authenticated workspace can use the Web UI and searches are scoped by the user's team ID claim)

## Slack Behavior

- Slack request signatures must be verified against the raw request body.
- Slash command handlers must return within Slack's 3-second timeout.
- Keep `/hi-nick` command handling asynchronous:
  - `SearchFunction` validates and accepts the command quickly.
  - `SearchWorkerFunction` performs search and posts Slack messages.
- Search results should post one parent message to the channel and detailed hits in that message's thread.
- Do not emit Slack user mentions in search results. Resolve display names with `users.info` when possible, and fall back to plain user IDs without `@`.
- Required Slack scopes for the current search flow:
  - `channels:history`
  - `channels:read`
  - `commands`
  - `chat:write`
  - `users:read`

## Web Authentication

- Web UI auth uses Slack Sign in with Slack through Cognito Hosted UI.
- Web API routes must verify Cognito JWTs and use the Slack `https://slack.com/team_id` claim as the search workspace scope.
- If an allowed-team list is configured (`/slack-archiver/allowed-slack-team-ids`), reject users whose team claim is not in that list. When absent, any Slack-authenticated workspace can use the Web UI and searches are scoped by the user's team ID claim.
- See `docs/web-auth-slack-oidc.md` before changing web auth implementation.

## Data Model

- Messages are stored in DynamoDB under `workspace#{team_id}#channel#{channel_id}` and `ts#{message_ts}`.
- Search index entries map normalized tokens to message keys, partitioned per workspace as `workspace#{team_id}#token#{token}`.
- The current context view loads up to five messages before and after each hit from the same channel partition.
