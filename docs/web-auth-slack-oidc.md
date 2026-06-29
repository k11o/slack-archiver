# Web authentication with Slack workspace accounts

## Goal

Authenticate the Web UI using Slack workspace accounts.

The preferred first implementation is:

```text
Slack Sign in with Slack (OIDC)
        ↓
Amazon Cognito User Pool Hosted UI
        ↓
Web API Lambda Cognito JWT verification
        ↓
Web search API
```

Do not implement custom password storage.

## Current deployed configuration

```text
Web URL: https://<API_ID>.execute-api.ap-northeast-1.amazonaws.com/web
Cognito domain: https://<COGNITO_DOMAIN_PREFIX>.auth.ap-northeast-1.amazoncognito.com
Slack redirect URL: https://<COGNITO_DOMAIN_PREFIX>.auth.ap-northeast-1.amazoncognito.com/oauth2/idpresponse
Allowed Slack team IDs: <ALLOWED_SLACK_TEAM_IDS> (optional)
```

The deployed Web API verifies Cognito JWTs in Lambda, reads the mapped Slack team claim, and searches only archived messages for that Slack workspace. If an allowlist is configured, the API rejects users whose Slack team claim is not in that list.

## Task brief

Maintain web UI authentication using Slack workspace accounts.

- Use Slack Sign in with Slack as an OIDC provider.
- Prefer Cognito User Pool Hosted UI with Slack configured as an external OIDC IdP.
- Validate Slack's `https://slack.com/team_id` claim and use it as the search workspace scope.
- Do not change Slack Events API or `/hi-nick` slash command authentication; those endpoints must continue to use Slack request signature verification.
- Do not commit Slack OIDC Client Secret or any Slack tokens.

Expected deliverables:

- SAM/Cognito infrastructure for Slack OIDC login.
- Protected web API route using Cognito JWT verification and Slack workspace-scoped search.
- Documented Slack app callback URL and required OIDC scopes.
- Tests or a local verification path for allowed-workspace and rejected-workspace behavior.

## Feasibility

Slack supports "Sign in with Slack" as an OpenID Connect provider.

Relevant Slack endpoints:

- Discovery document: `https://slack.com/.well-known/openid-configuration`
- Authorization endpoint: `https://slack.com/openid/connect/authorize`
- Token endpoint: `https://slack.com/api/openid.connect.token`
- UserInfo endpoint: `https://slack.com/api/openid.connect.userInfo`

Official docs:

- Slack Sign in with Slack: https://docs.slack.dev/authentication/sign-in-with-slack/
- AWS Cognito OIDC IdP: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-oidc-idp.html

## Required Slack scopes

For web login, use these OpenID Connect scopes:

- `openid`
- `profile`
- `email`

These are separate from the bot scopes used by ingestion/search.

## Workspace restriction

Slack's OIDC ID token includes Slack-specific claims such as:

- `https://slack.com/team_id`
- `https://slack.com/user_id`

The web UI must use `https://slack.com/team_id` as an authorization and data-isolation boundary. Search results for an authenticated user must come only from the workspace in that token claim. An optional allowlist may restrict which workspace IDs can use the web UI at all.

The Slack authorization request may include a `team` parameter to improve the login experience, but that is not an authorization boundary. The final decision must validate the token claim.

## Preferred implementation task

Implement or maintain Slack workspace login through Cognito Hosted UI.

### Infrastructure

- Add or maintain a Cognito User Pool for web users.
- Add or maintain a Cognito User Pool App Client.
- Add or maintain a Cognito Hosted UI domain.
- Configure or maintain Slack as an external OIDC identity provider.
- Configure protected web API routes to verify Cognito JWTs.
- Store Slack OIDC client credentials outside Git. Keep the client secret in SSM Parameter Store SecureString, then pass it to SAM as a `NoEcho` parameter at deploy time because Cognito OIDC provider `client_secret` does not support SSM SecureString dynamic references.
- Add optional environment/configuration for allowed Slack workspace team IDs.
- Pass the deployed API base URL as `WebBaseUrl` so Cognito callback/logout URLs do not create a CloudFormation dependency cycle.

### Slack app settings

- Enable Sign in with Slack / OIDC for the app.
- Add the Cognito callback URL in the **Sign in with Slack** redirect URL settings of the Slack app:

```text
https://<cognito-domain>/oauth2/idpresponse
```

- The redirect URL must be registered in the Sign in with Slack section exactly as Cognito sends it. For the current development stack, use:

```text
https://<COGNITO_DOMAIN_PREFIX>.auth.ap-northeast-1.amazoncognito.com/oauth2/idpresponse
```

- Do NOT add this URL to the separate **OAuth & Permissions > Redirect URLs** used for bot token installs. Putting the Cognito `/oauth2/idpresponse` URL there causes the Manage Distribution "Install to another workspace" flow to redirect to Cognito, which rejects the request with "Invalid state" because bot installs do not send a `state` parameter.
- Add the web app logout URL when the frontend exists.
- Record the Slack OIDC Client ID and Client Secret in AWS secrets storage. The deployment command reads those values and passes them as CloudFormation parameters.

### Authorization

- Require an authenticated Slack `team_id` claim before searching.
- Scope every search to the authenticated user's Slack `team_id`.
- If an allowed-team list is configured, require the authenticated user's Slack `team_id` to be present in it.
- Prefer enforcing this before issuing application access.
- Validate the Slack team claim in the protected API handler. This avoids a CloudFormation dependency cycle between API Gateway, Cognito callback URLs, and the Cognito app client.
- Deny users with missing team claims or team claims outside the optional allowlist.

### Frontend behavior

- Redirect unauthenticated users to Cognito Hosted UI.
- After login, store tokens only in browser-safe storage appropriate for the chosen frontend framework.
- Send API requests with `Authorization: Bearer <Cognito ID token>`.
- Provide logout through Cognito Hosted UI logout.

## Fallback implementation task

If Cognito cannot reliably preserve the Slack team claim, implement a direct Slack OIDC callback flow in Lambda:

1. Redirect `/auth/login` to Slack's OIDC authorization endpoint.
2. Handle `/auth/callback` by exchanging `code` for tokens.
3. Verify the ID token using Slack JWKS.
4. Validate `https://slack.com/team_id`.
5. Create a short-lived signed application session.
6. Protect web API routes with that application session.

This fallback is more code and should be used only after a small Cognito proof-of-concept fails.

## Acceptance criteria

- A user with a valid Slack workspace claim can sign in to the web UI.
- The API rejects unauthenticated requests.
- The API searches only messages whose `team_id` matches the authenticated user's Slack workspace claim.
- If an allowlist is configured, the API rejects authenticated users whose Slack `team_id` is not in the allowlist.
- No Slack Client Secret, bot token, signing secret, user token, or session secret is committed to Git.
- Existing Slack Events API and `/hi-nick` slash command endpoints continue to use Slack request signature verification, not the web login flow.

## Open implementation questions

- Production custom domain, if one is needed later.
- Whether to add a Cognito trigger for stricter pre-token workspace enforcement. The current implementation enforces workspace access in the protected Web API Lambda.
