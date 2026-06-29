# Slack app setup

This project uses Slack HTTP endpoints, not Socket Mode.

## Create or configure the Slack app

Create a single Slack app and install it into each workspace that should be archived. The same Signing Secret and OIDC client credentials are shared across workspaces; only the Bot User OAuth Token differs per workspace, stored under `/slack-archiver/workspaces/<TEAM_ID>/slack-bot-token`.

For multi-workspace installations, keep the app configured as a distributable app (Settings > Manage Distribution) so it can be installed into additional workspaces with "Install to another workspace". The app-level settings (slash command, Event Subscriptions request URL, OAuth scopes, OIDC Redirect URL) are shared, so per-workspace reconfiguration is not needed. Slack includes `team_id` in every Events API and slash command payload, which the Lambda uses to scope storage and look up the correct bot token.

## Basic Information

Record these values locally, not in the repository:

- Signing Secret
- Bot User OAuth Token
- Client ID
- Client Secret

The Signing Secret and Bot User OAuth Token are required by the threaded slash-command search version.
Store them in SSM Parameter Store, not in Git.

## OAuth scopes

Start with the smallest practical set.

First-release target:

| Setting | Value |
|---|---|
| Workspace coverage | Public channels only |
| Web UI | Enabled through Slack Sign in and Cognito Hosted UI |
| Slash command | `/hi-nick` |
| Events endpoint | `<API_ENDPOINT>/slack/events` |
| Slash command endpoint | `<API_ENDPOINT>/slack/search` |
| Search response shape | One parent message in the command channel, detailed hits in its thread |

Recommended bot token scopes:

| Scope | Why |
|---|---|
| `channels:history` | Read message events/history for public channels where the app is present. |
| `channels:read` | Resolve public channel metadata if needed later. |
| `commands` | Enable the slash command. |
| `chat:write` | Post slash command search summaries and threaded result details. |
| `users:read` | Resolve archived user IDs to display names without mentioning users. |

Optional scopes:

| Scope | When needed |
|---|---|
| `groups:history` | Archive private channels where the app is explicitly added. |
| `groups:read` | Resolve private channel metadata if needed later. |

Do not request broad scopes until the implementation actually uses them.

For the first release, private channels are out of scope. Do not add `groups:history`,
`groups:read`, or `message.groups` unless that decision changes later.

## Event Subscriptions

Enable Event Subscriptions and set the request URL to:

```text
<API_ENDPOINT>/slack/events
```

Subscribe only to this bot event for the first release:

```text
message.channels
```

Do not subscribe to `message.groups`. Add it only if private channel archiving is required later:

```text
message.groups
```

Slack will send a URL verification challenge. The ingest Lambda responds with the `challenge` value.

## Slash Command

Create a slash command:

```text
Command: /hi-nick
Request URL: <API_ENDPOINT>/slack/search
Short description: Search archived Slack messages
Usage hint: <query>
```

Slack sends slash command requests as `application/x-www-form-urlencoded`; the search Lambda parses that format.

Suggested Slack form values:

| Field | Value |
|---|---|
| Command | `/hi-nick` |
| Request URL | `<API_ENDPOINT>/slack/search` |
| Short Description | `Search archived Slack messages` |
| Usage Hint | `<query>` |
| Escape channels, users, and links | Leave disabled for the first release |

## Install the app

Install the app to each workspace after scopes are configured. If scopes are changed later, reinstall or reauthorize the app in every installed workspace.

After adding `chat:write` or `users:read`, reinstall or reauthorize the app and copy the new Bot User OAuth Token to SSM. One SSM parameter is required per installed workspace, keyed by the Slack team ID:

```bash
aws ssm put-parameter \
  --profile <AWS_PROFILE> \
  --region ap-northeast-1 \
  --name /slack-archiver/workspaces/<TEAM_ID>/slack-bot-token \
  --type SecureString \
  --value '<SLACK_BOT_USER_OAUTH_TOKEN>' \
  --overwrite
```

### Add a new workspace

Repeat these steps for each additional Slack workspace to archive:

1. Open the app's "Install to another workspace" flow and install it into the target workspace.
2. After install, copy that workspace's Bot User OAuth Token from OAuth & Permissions.
3. Store the token in SSM under `/slack-archiver/workspaces/<TEAM_ID>/slack-bot-token` using the command above.
4. Invite the app to each public channel that should be archived (see Channel coverage below).
5. (Optional) If `/slack-archiver/allowed-slack-team-ids` is configured for Web UI access control, append the new `<TEAM_ID>` to the comma-separated list and redeploy.
6. Verify with `/hi-nick <test word>` in the new workspace and a Web UI search signed in as a user from that workspace.

No code or SAM redeploy is needed for step 1-4; the running Lambda reads the new SSM parameter on the next request.

## Channel coverage

The app only receives message events for public channels it can see. Private channels are excluded from the first release.

Use Slack channel UI or:

```text
/invite @<app-name>
```

## Verification checklist

- Event Subscriptions request URL is verified.
- Slash command is installed and visible in the workspace.
- App is invited to at least one test channel.
- Test message is archived.
- `/hi-nick <test word>` posts one search summary message.
- The summary message thread contains each hit with channel, user, time, and up to five messages before and after.
- User references are rendered as plain display names, not Slack mentions.

## Web UI Sign in with Slack

When enabling the web UI, configure Slack OIDC login in the Slack app:

```text
Redirect URL: https://<COGNITO_DOMAIN_PREFIX>.auth.ap-northeast-1.amazoncognito.com/oauth2/idpresponse
Scopes: openid, profile, email
```

For the deployed development stack:

```text
Redirect URL: https://<COGNITO_DOMAIN_PREFIX>.auth.ap-northeast-1.amazoncognito.com/oauth2/idpresponse
Web URL: https://<API_ID>.execute-api.ap-northeast-1.amazonaws.com/web
```

Configure this redirect URL only in the **Sign in with Slack** settings of the Slack app (in some app versions, it may appear under **User Info & OAuth > Redirect URLs** or similar). Do NOT add it to the separate **OAuth & Permissions > Redirect URLs** used for bot token installs. Putting the Cognito `/oauth2/idpresponse` URL in both places makes the bot install flow from the Manage Distribution page redirect to Cognito, which rejects the request with "Invalid state" because bot installs do not send a `state` parameter. Do not use the Web UI callback URL (`/web/callback`) as the Slack redirect URL.

Store the Slack OIDC Client Secret in SSM Parameter Store as `/slack-archiver/slack-oidc-client-secret`.

The user token scopes for web login only need:

```text
openid
profile
email
```

Do not add channel history scopes to the user token for web login. Message archive search uses the stored DynamoDB data and the bot token only where Slack API lookups or Slack posts are needed.

## Security notes

- Keep the Signing Secret in SSM Parameter Store SecureString or Secrets Manager.
- Keep the Bot User OAuth Token in SSM Parameter Store SecureString or Secrets Manager.
- Do not commit Slack tokens or secrets.
- Verify request signatures for both Events API and Slash Commands.
- Reject stale Slack timestamps to reduce replay risk.
