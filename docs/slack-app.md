# Slack app setup

This project uses Slack HTTP endpoints, not Socket Mode.

## Create or configure the Slack app

Create a Slack app for the target workspace. Keep the app internal to the workspace unless there is a later need to distribute it.

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
| Web UI | Disabled / not implemented |
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

Install the app to the workspace after scopes are configured. If scopes are changed later, reinstall or reauthorize the app.

After adding `chat:write` or `users:read`, reinstall or reauthorize the app and copy the new Bot User OAuth Token to SSM:

```bash
aws ssm put-parameter \
  --profile <AWS_PROFILE> \
  --region ap-northeast-1 \
  --name /slack-archiver/slack-bot-token \
  --type SecureString \
  --value '<SLACK_BOT_USER_OAUTH_TOKEN>' \
  --overwrite
```

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

## Security notes

- Keep the Signing Secret in SSM Parameter Store SecureString or Secrets Manager.
- Keep the Bot User OAuth Token in SSM Parameter Store SecureString or Secrets Manager.
- Do not commit Slack tokens or secrets.
- Verify request signatures for both Events API and Slash Commands.
- Reject stale Slack timestamps to reduce replay risk.
