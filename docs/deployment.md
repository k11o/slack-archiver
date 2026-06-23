# Deployment runbook

This document describes the information and steps needed for Codex or a human operator to deploy the first serverless version.

## Required external inputs

These values are intentionally not committed to the repository.

| Value | Where to get it | Where to put it |
|---|---|---|
| AWS account ID | AWS console or `aws sts get-caller-identity` | Local deploy notes only |
| AWS region | Deployment decision | `sam deploy --region` |
| Slack signing secret | Slack app settings: Basic Information > App Credentials | SSM Parameter Store SecureString |
| Slack bot token | Slack app settings: OAuth & Permissions > Bot User OAuth Token | SSM Parameter Store SecureString |
| Slack app request URLs | SAM stack output `ApiEndpoint` | Slack app settings |
| Slack command name | Slack app settings | `/hi-nick` |
| Slack channel install targets | Slack workspace | Invite the app to channels to archive |

## AWS prerequisites

Install and configure:

- AWS CLI authenticated to the target account.
- uv. SAM CLI is managed through `pyproject.toml`.
- Node.js 24 or newer.
- Python 3.13.14 for uv-managed SAM CLI tooling.
- npm.

Node.js 24 is the latest AWS Lambda managed Node.js runtime currently used by this project. Python 3.13.14 is used for SAM CLI tooling because the current SAM CLI dependency set does not build reliably with Python 3.14.

Verify identity before deploying:

```bash
aws sts get-caller-identity
```

## Store Slack secrets

Create the SSM parameters before deployment:

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
  --name /slack-archiver/slack-bot-token \
  --type SecureString \
  --value '<SLACK_BOT_USER_OAUTH_TOKEN>' \
  --overwrite
```

Do not commit Slack secrets, bot tokens, user tokens, or app-level tokens.

## Build and deploy

From the repository root:

```bash
npm install
uv run sam validate
uv run sam build
uv run sam deploy --guided --profile <AWS_PROFILE> --region ap-northeast-1
```

Recommended guided values:

| Prompt | Value |
|---|---|
| Stack Name | `slack-archiver` |
| AWS Region | `ap-northeast-1` |
| Confirm changes before deploy | `Y` |
| Allow SAM CLI IAM role creation | `Y` |
| Disable rollback | `N` |
| Save arguments to samconfig.toml | `Y` |

After deployment, capture the `ApiEndpoint` output.

## Slack endpoint URLs

If `ApiEndpoint` is:

```text
https://example.execute-api.ap-northeast-1.amazonaws.com
```

Use:

```text
Events API request URL: https://example.execute-api.ap-northeast-1.amazonaws.com/slack/events
Slash command request URL: https://example.execute-api.ap-northeast-1.amazonaws.com/slack/search
```

## Smoke tests

After configuring Slack:

1. Slack should verify the Events API request URL successfully.
2. Post a test message in a channel where the app is present.
3. Run `/hi-nick <word from the test message>`.
4. Confirm the command returns the archived message.
5. Check CloudWatch Logs only if Slack returns an error.

## Cost controls

Before or immediately after deploy:

- Create an AWS Budget alert.
- Set CloudWatch log retention manually or add it to the SAM template in a later change.
- Avoid NAT Gateway, VPC Lambda, OpenSearch, and file-body storage.

## Current implementation caveats

The first version is a scaffold, not a hardened production release.

Known follow-up tasks:

- Add explicit CloudWatch log retention resources.
- Add duplicate-event handling using Slack `event_id`.
- Add message edit/delete handling.
- Add pagination or better ranking for search results.
- Decide whether DynamoDB billing should remain on-demand or move to provisioned capacity for stricter free-tier alignment.
