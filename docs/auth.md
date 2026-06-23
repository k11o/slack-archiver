# Authentication design

## Recommendation

Use different authentication models for Slack endpoints and the web app.

- Slack ingestion/search command endpoints: Slack request signature verification.
- Web app: Amazon Cognito User Pool + API Gateway HTTP API JWT authorizer.

This keeps the Slack-facing endpoints compatible with Slack while giving the browser application normal user login and API authorization.

## Slack endpoints

Slack does not use the web app login flow when calling Events API or Slash Commands. These requests must be authenticated by validating Slack's signing secret.

Validation requirements:

- Read `X-Slack-Signature`.
- Read `X-Slack-Request-Timestamp`.
- Reject requests with stale timestamps.
- Compute `v0:{timestamp}:{raw_body}` with HMAC-SHA256 using the Slack signing secret.
- Compare the computed signature with Slack's signature using constant-time comparison.

The Slack signing secret should be stored in AWS Secrets Manager or SSM Parameter Store, not in source code.

## Web app endpoints

For a private tool used by a small number of users, the recommended web authentication is:

```text
Cognito User Pool Hosted UI
        ↓ returns JWT
Browser frontend
        ↓ Authorization: Bearer <JWT>
API Gateway HTTP API JWT authorizer
        ↓
Search Lambda
```

Use Slack Sign in with Slack as the external OIDC provider for Cognito so that web users authenticate with the target Slack workspace account. See `docs/web-auth-slack-oidc.md` for the implementation task.

### Why Cognito

- No EC2 or self-hosted identity service.
- Works with API Gateway HTTP API JWT authorizers.
- Suitable for a small number of users.
- Can use email/password first, and later add Google/OIDC if needed.

### User access policy

Start with an allowlist:

- Restrict access to the configured Slack workspace by validating Slack's `https://slack.com/team_id` OIDC claim.
- Disable open Cognito-native self-signup unless it is explicitly needed later.
- Use read-only API permissions for the initial web UI.

## Alternatives considered

### Basic Auth at CloudFront/Lambda@Edge

Simple, but it adds edge code and weak user management. Avoid unless the app is strictly single-user and temporary.

### Direct Slack OAuth/OIDC login

Attractive because the data is Slack-related, but direct implementation is more code. Prefer Cognito Hosted UI with Slack as an external OIDC provider first, then fall back to a direct Slack OIDC callback only if Cognito cannot preserve or enforce the Slack team claim reliably.

### IAM Identity Center

Good for company-internal AWS users, but overkill for a small personal/team web app unless the organization already uses it.

### No web app auth, Slack slash command only

This is the lowest-risk first release. If search through Slack is enough, skip the web UI initially.

## Initial decision

Implement Slack slash command search first. When adding the web UI, use Cognito User Pool plus API Gateway JWT authorizer.
