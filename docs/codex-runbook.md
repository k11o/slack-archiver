# Codex work order

Use this document as the operational brief for Codex.

## Objective

Turn this scaffold into a deployable Slack archiver for a small Slack free-plan workspace.

Primary workflow:

1. Deploy the AWS serverless backend.
2. Configure the Slack app endpoints.
3. Verify Slack message ingestion.
4. Verify Slack slash command search.
5. Verify Slack-authenticated Web UI search.
6. Document any manual steps that cannot be automated safely.

## Repository context

Read these files first:

- `README.md`
- `docs/architecture.md`
- `docs/auth.md`
- `docs/data-model.md`
- `docs/deployment.md`
- `docs/slack-app.md`
- `template.yaml`

## Constraints

- Do not use EC2.
- Do not add always-on infrastructure.
- Do not add NAT Gateway.
- Do not add OpenSearch for the first version.
- Keep cost suitable for a workspace with tens of messages per day.
- Keep secrets out of Git.
- Prefer AWS managed/serverless services.

## Required operator-provided values

Ask the operator for these values if they are not already available in the execution environment:

- Target AWS account and region.
- Slack Signing Secret.
- Slack Bot User OAuth Token.
- Slack app name.
- Slack workspace where the app should be installed.
- Whether private channels should be archived. Current first release decision: no.
- Whether the release should include only Slack slash command search or also a web UI. Current state: Slack slash command search and Slack-authenticated Web UI search are implemented.

Do not guess secrets or workspace-specific identifiers.

## Implementation tasks

### 1. Validate local project

Run:

```bash
npm install
npm test
uv run sam validate
uv run sam build
```

If tests do not exist, add minimal tests for:

- Slack signature verification.
- URL verification request handling.
- Text normalization and tokenization.

### 2. Harden ingestion

Implement or verify:

- `url_verification` handling.
- Slack signature validation for raw request body.
- Timestamp replay protection.
- Ignore unsupported message subtypes.
- Idempotency for duplicate Slack retries.
- Safe handling for empty or missing text.

### 3. Harden search

Implement or verify:

- Slash command form parsing.
- Signature validation.
- Empty query response.
- Candidate lookup by token/n-gram.
- Result formatting for Slack ephemeral response.
- Reasonable result limit.

### 4. Deploy

Follow `docs/deployment.md`.

Before deployment, store the Slack secrets in SSM Parameter Store:

```bash
aws ssm put-parameter \
  --profile <AWS_PROFILE> \
  --region ap-northeast-1 \
  --name /slack-archiver/slack-signing-secret \
  --type SecureString \
  --value '<SLACK_SIGNING_SECRET>' \
  --overwrite

aws ssm put-parameter \
  --profile <AWS_PROFILE> \
  --region ap-northeast-1 \
  --name /slack-archiver/workspaces/<TEAM_ID>/slack-bot-token \
  --type SecureString \
  --value '<SLACK_BOT_USER_OAUTH_TOKEN>' \
  --overwrite
```

Then deploy:

```bash
uv run sam build
uv run sam deploy --guided --profile <AWS_PROFILE> --region ap-northeast-1
```

Record the `ApiEndpoint` output.

### 5. Configure Slack

Follow `docs/slack-app.md`.

Use:

```text
Events API request URL: <API_ENDPOINT>/slack/events
Slash command request URL: <API_ENDPOINT>/slack/search
```

### 6. Verify end-to-end

Run this acceptance test:

1. Invite the Slack app to a test channel.
2. Post a message containing a unique token, e.g. `slack-archiver-smoke-test-20260622`.
3. Run `/hi-nick slack-archiver-smoke-test-20260622`.
4. Confirm the result contains the message.
5. Inspect DynamoDB to confirm the message and index records exist.

## Web app authentication decision

The Web UI is now implemented. Maintain this authentication model:

- Cognito User Pool Hosted UI for login.
- Slack Sign in with Slack as the external OIDC provider.
- Web API Lambda verifies Cognito JWTs.
- Web API Lambda scopes search to Slack's `team_id` claim from the logged-in user.
- The frontend is currently served by API Gateway and Lambda at `/web`.

Do not implement custom password storage.

## Deliverables

At the end of the Codex run, provide:

- Commit hash or branch name.
- Deployed stack name and region.
- API endpoint.
- Slack app setup status.
- Any manual steps remaining.
- Known risks or follow-up issues.
