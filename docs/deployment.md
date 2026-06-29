# Deployment runbook

This document describes the information and steps needed for Codex or a human operator to deploy the first serverless version.

## Required external inputs

These values are intentionally not committed to the repository.

| Value | Where to get it | Where to put it |
|---|---|---|
| AWS account ID | AWS console or `aws sts get-caller-identity` | Local deploy notes only |
| AWS region | Deployment decision | `sam deploy --region` |
| Slack signing secret | Slack app settings: Basic Information > App Credentials | SSM Parameter Store SecureString |
| Slack app client ID / OIDC client ID | Slack app settings: Basic Information > App Credentials (same value used for Sign in with Slack) | SSM Parameter Store SecureString `/slack-archiver/slack-oidc-client-id`, then SAM parameter `SlackOidcClientId` at deploy time |
| Slack app client secret / OIDC client secret | Slack app settings: Basic Information > App Credentials (same value used for Sign in with Slack) | SSM Parameter Store SecureString `/slack-archiver/slack-oidc-client-secret`, then SAM parameter `SlackOidcClientSecret` at deploy time |
| Slack bot token | Slack app settings: OAuth & Permissions > Bot User OAuth Token for each installed workspace | SSM Parameter Store SecureString under `/slack-archiver/workspaces/<TEAM_ID>/slack-bot-token` (written automatically by `InstallFunction` on install) |
| Allowed Slack workspace team IDs | Slack workspace/app metadata | Optional SAM parameter `AllowedSlackTeamIds`, comma-separated |
| Cognito domain prefix | Deployment decision | SAM parameter `CognitoDomainPrefix` |
| Web base URL | Existing API endpoint | SAM parameter `WebBaseUrl` |
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
  --name /slack-archiver/workspaces/<TEAM_ID>/slack-bot-token \
  --type SecureString \
  --value '<SLACK_BOT_USER_OAUTH_TOKEN>' \
  --overwrite

aws ssm put-parameter \
  --profile <AWS_PROFILE> \
  --region ap-northeast-1 \
  --name /slack-archiver/slack-oidc-client-secret \
  --type SecureString \
  --value '<SLACK_OIDC_CLIENT_SECRET>' \
  --overwrite
```

Do not commit Slack secrets, bot tokens, user tokens, or app-level tokens.

## GitHub Actions deployment authentication

The GitHub Actions workflow runs CI for pull requests. On `main`, it also
deploys the SAM application after tests and `sam build` pass. The workflow can
also be started manually with `workflow_dispatch`.

CD uses GitHub Actions OIDC to assume an AWS IAM role. Do not store long-lived
AWS access keys in GitHub secrets.

Recommended setup:

- Create an IAM OIDC provider for `https://token.actions.githubusercontent.com` if the AWS account does not already have one.
- Create or maintain the deploy role `arn:aws:iam::<AWS_ACCOUNT_ID>:role/slack-archiver-github-actions-deploy`.
- Restrict the role trust policy to this repository and branch, for example `repo:k11o/slack-archiver:ref:refs/heads/main`.
- Grant only the permissions needed for `sam deploy` of the `slack-archiver` stack.
- In the deploy workflow, set:
  - `permissions.id-token: write`
  - `permissions.contents: read`
  - `AWS_DEFAULT_REGION: ap-northeast-1`
- Use `aws-actions/configure-aws-credentials` with the deploy role ARN.
- Store the deploy role ARN in the GitHub Actions repository variable `AWS_DEPLOY_ROLE_ARN`.

Example deploy credential step:

```yaml
permissions:
  id-token: write
  contents: read

env:
  AWS_DEFAULT_REGION: ap-northeast-1

steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::<AWS_ACCOUNT_ID>:role/<github-actions-deploy-role>
      aws-region: ap-northeast-1
```

Keep Slack Signing Secret and Bot User OAuth Token in SSM Parameter Store. The deploy workflow should not know their plaintext values.

## Build and deploy

From the repository root:

```bash
npm install
uv run sam validate
uv run sam build
uv run sam deploy --guided --profile <AWS_PROFILE> --region ap-northeast-1
```

For non-guided deployment after the web UI is configured, read the Slack OIDC values from SSM and pass them as SAM parameters. `SlackOidcClientSecret` is a `NoEcho` CloudFormation parameter because `AWS::Cognito::UserPoolIdentityProvider.ProviderDetails.client_secret` does not support SSM SecureString dynamic references.

```bash
SLACK_OIDC_CLIENT_ID=$(aws ssm get-parameter \
  --profile <AWS_PROFILE> \
  --region ap-northeast-1 \
  --name /slack-archiver/slack-oidc-client-id \
  --query 'Parameter.Value' \
  --output text)

SLACK_OIDC_CLIENT_SECRET=$(aws ssm get-parameter \
  --profile <AWS_PROFILE> \
  --region ap-northeast-1 \
  --with-decryption \
  --name /slack-archiver/slack-oidc-client-secret \
  --query 'Parameter.Value' \
  --output text)

ALLOWED_SLACK_TEAM_IDS=$(aws ssm get-parameter \
  --profile <AWS_PROFILE> \
  --region ap-northeast-1 \
  --name /slack-archiver/allowed-slack-team-ids \
  --query 'Parameter.Value' \
  --output text 2>/dev/null || true)

COGNITO_DOMAIN_PREFIX=$(aws ssm get-parameter \
  --profile <AWS_PROFILE> \
  --region ap-northeast-1 \
  --name /slack-archiver/cognito-domain-prefix \
  --query 'Parameter.Value' \
  --output text)

WEB_BASE_URL=$(aws ssm get-parameter \
  --profile <AWS_PROFILE> \
  --region ap-northeast-1 \
  --name /slack-archiver/web-base-url \
  --query 'Parameter.Value' \
  --output text)

uv run sam deploy \
  --stack-name slack-archiver \
  --profile <AWS_PROFILE> \
  --region ap-northeast-1 \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    SlackOidcClientId="$SLACK_OIDC_CLIENT_ID" \
    SlackOidcClientSecret="$SLACK_OIDC_CLIENT_SECRET" \
    AllowedSlackTeamIds="$ALLOWED_SLACK_TEAM_IDS" \
    CognitoDomainPrefix="$COGNITO_DOMAIN_PREFIX" \
    WebBaseUrl="$WEB_BASE_URL"
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

Current deployed development stack:

```text
Stack: slack-archiver
Region: ap-northeast-1
ApiEndpoint: https://<API_ID>.execute-api.ap-northeast-1.amazonaws.com
WebUrl: https://<API_ID>.execute-api.ap-northeast-1.amazonaws.com/web
CognitoSlackCallbackUrl: https://<COGNITO_DOMAIN_PREFIX>.auth.ap-northeast-1.amazoncognito.com/oauth2/idpresponse
AllowedSlackTeamIds: <ALLOWED_SLACK_TEAM_IDS>
```

## Smoke tests

After configuring Slack:

1. Slack should verify the Events API request URL successfully.
2. Post a test message in a channel where the app is present.
3. Run `/hi-nick <word from the test message>`.
4. Confirm the command returns the archived message.
5. Open `WebUrl`, sign in with Slack, and search for the same word.
6. Check CloudWatch Logs only if Slack returns an error or the Web UI search fails.

Basic unauthenticated Web API check:

```bash
curl -i 'https://<API_ID>.execute-api.ap-northeast-1.amazonaws.com/api/search?q=test'
```

Expected result:

```text
HTTP/2 401
{"error":"unauthorized"}
```

## Cost controls

Before or immediately after deploy:

- Create an AWS Budget alert.
- Set CloudWatch log retention manually or add it to the SAM template in a later change.
- Avoid NAT Gateway, VPC Lambda, OpenSearch, and file-body storage.

## Current implementation caveats

The first version is a scaffold, not a hardened production release.

Multi-tenant migration note: the `slack_search_index` partition key changed from `token#{token}` to `workspace#{team_id}#token#{token}`. After deploying the multi-tenant code, existing index entries no longer match searches. Run the one-time backfill in `docs/backfill.md` (`scripts/backfill-search-index.js`) to rebuild the index from `slack_messages` before cleaning up legacy entries.

Known follow-up tasks:

- Add explicit CloudWatch log retention resources.
- Add duplicate-event handling using Slack `event_id`.
- Add message edit/delete handling.
- Add pagination or better ranking for search results.
- Decide whether DynamoDB billing should remain on-demand or move to provisioned capacity for stricter free-tier alignment.
