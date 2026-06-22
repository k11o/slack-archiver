# Slack app setup

This project uses Slack HTTP endpoints, not Socket Mode.

## Create or configure the Slack app

Create a Slack app for the target workspace. Keep the app internal to the workspace unless there is a later need to distribute it.

## Basic Information

Record these values locally, not in the repository:

- Signing Secret
- Client ID
- Client Secret

Only the Signing Secret is required by the first version.

## OAuth scopes

Start with the smallest practical set.

Recommended bot token scopes:

| Scope | Why |
|---|---|
| `channels:history` | Read message events/history for public channels where the app is present. |
| `channels:read` | Resolve public channel metadata if needed later. |
| `commands` | Enable the slash command. |

Optional scopes:

| Scope | When needed |
|---|---|
| `groups:history` | Archive private channels where the app is explicitly added. |
| `groups:read` | Resolve private channel metadata if needed later. |
| `users:read` | Display user names instead of raw user IDs. |
| `chat:write` | Post proactive messages. Not required for basic slash command responses. |

Do not request broad scopes until the implementation actually uses them.

## Event Subscriptions

Enable Event Subscriptions and set the request URL to:

```text
<API_ENDPOINT>/slack/events
```

Subscribe to bot events:

```text
message.channels
```

Add this only if private channel archiving is required:

```text
message.groups
```

Slack will send a URL verification challenge. The ingest Lambda responds with the `challenge` value.

## Slash Command

Create a slash command:

```text
Command: /archive
Request URL: <API_ENDPOINT>/slack/search
Short description: Search archived Slack messages
Usage hint: <query>
```

Slack sends slash command requests as `application/x-www-form-urlencoded`; the search Lambda parses that format.

## Install the app

Install the app to the workspace after scopes are configured. If scopes are changed later, reinstall or reauthorize the app.

## Channel coverage

The app only receives message events for channels it can see. For private channels, invite the app explicitly.

Use Slack channel UI or:

```text
/invite @<app-name>
```

## Verification checklist

- Event Subscriptions request URL is verified.
- Slash command is installed and visible in the workspace.
- App is invited to at least one test channel.
- Test message is archived.
- `/archive <test word>` returns a result.

## Security notes

- Keep the Signing Secret in SSM Parameter Store SecureString or Secrets Manager.
- Do not commit Slack tokens or secrets.
- Verify request signatures for both Events API and Slash Commands.
- Reject stale Slack timestamps to reduce replay risk.
