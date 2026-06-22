# Codex work order

Use this document as the operational brief for Codex.

## Objective

Turn this scaffold into a deployable Slack archiver for a small Slack free-plan workspace.

Primary workflow:

1. Deploy the AWS serverless backend.
2. Configure the Slack app endpoints.
3. Verify Slack message ingestion.
4. Verify Slack slash command search.
5. Document any manual steps that cannot be automated safely.

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
- Slack app name.
- Slack workspace where the app should be installed.
- Whether private channels should be archived.
- Whether the first release should include only Slack slash command search or also a web UI.

Do not guess secrets or workspace-specific identifiers.

## Implementation tasks

### 1. Validate local project

Run:

```bash
npm install
npm test
sam validate
sam build
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

Before deployment, store the Slack Signing Secret in SSM Parameter Store:

```bash
aws ssm put-parameter \
  --name /slack-archiver/slack-signing-secret \
  --type SecureString \
  --value '<SLACK_SIGNING_SECRET>' \
  --overwrite
```

Then deploy:

```bash
sam build
sam deploy --guided
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
3. Run `/archive slack-archiver-smoke-test-20260622`.
4. Confirm the result contains the message.
5. Inspect DynamoDB to confirm the message and index records exist.

## Web app authentication decision

Do not implement the web UI in the first pass unless explicitly requested.

When web UI work begins, use:

- Cognito User Pool Hosted UI for login.
- API Gateway HTTP API JWT authorizer for API access.
- S3 + CloudFront for static frontend hosting.

Do not implement custom password storage.

## Deliverables

At the end of the Codex run, provide:

- Commit hash or branch name.
- Deployed stack name and region.
- API endpoint.
- Slack app setup status.
- Any manual steps remaining.
- Known risks or follow-up issues.
