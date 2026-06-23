# Repository Instructions

## Project Scope

- Build a low-cost Slack archiver for a small Slack workspace.
- Keep the first release Slack-only. Do not implement the web UI unless explicitly requested.
- Private channels are out of scope for the current release.
- The active Slack slash command is `/hi-nick`; `/archive` was unavailable in the workspace.

## Local Tooling

- Use Node.js 22 or newer.
- Run JavaScript tests with `npm test`.
- Manage SAM CLI through uv, using `pyproject.toml` and `uv.lock`.
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
  - `/slack-archiver/slack-signing-secret`
  - `/slack-archiver/slack-bot-token`

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

## Data Model

- Messages are stored in DynamoDB under `workspace#{team_id}#channel#{channel_id}` and `ts#{message_ts}`.
- Search index entries map normalized tokens to message keys.
- The current context view loads up to five messages before and after each hit from the same channel partition.
