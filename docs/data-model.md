# DynamoDB data model

## Table: slack_messages

Primary access pattern: fetch messages by workspace/channel and timestamp.

| Attribute | Purpose |
|---|---|
| pk | `workspace#{team_id}#channel#{channel_id}` |
| sk | `ts#{message_ts}` |
| message_id | Stable internal message ID. |
| team_id | Slack workspace/team ID. |
| channel_id | Slack channel ID. |
| user_id | Slack user ID. |
| ts | Slack message timestamp. |
| thread_ts | Slack thread timestamp, if present. |
| text | Original message text. |
| normalized_text | Search-normalized message text. |
| permalink | Optional Slack permalink. |
| event_id | Slack event ID for deduplication. |
| deleted | Boolean tombstone for deletes. |
| created_at | Archive insertion timestamp. |
| updated_at | Archive update timestamp. |

## Table: slack_search_index

Primary access pattern: workspace-scoped token to candidate messages.

| Attribute | Purpose |
|---|---|
| pk | `workspace#{team_id}#token#{token}` |
| sk | `workspace#{team_id}#channel#{channel_id}#ts#{message_ts}` |
| message_pk | PK for `slack_messages`. |
| message_sk | SK for `slack_messages`. |
| team_id | Slack workspace/team ID. |
| token | Normalized token or n-gram. |
| ts | Slack message timestamp. |

## Tokenization

Initial approach:

- Lowercase ASCII.
- Split ASCII words, numbers, URLs, mentions, and channel references.
- Generate 2-gram or 3-gram tokens for Japanese text.
- Cap tokens per message to avoid excessive write amplification.

## Retention

No TTL by default. Optional TTL can be added if long-term retention is not desired.
