# Import Slack official exports

Use `scripts/import-slack-export.js` to load Slack's official public-channel export ZIP into the existing DynamoDB archive.

The importer writes the same keys used by live Slack Events ingestion:

- `slack_messages`: `workspace#{team_id}#channel#{channel_id}` / `ts#{message_ts}`
- `slack_search_index`: `workspace#{team_id}#token#{token}` / `workspace#{team_id}#channel#{channel_id}#ts#{message_ts}`

Duplicate handling is idempotent. The importer reads target message keys and inserts each message with a conditional write, so an existing record or delete tombstone cannot be overwritten even if it appears after the duplicate check. Duplicate messages inside the same export batch are also skipped. Index entries are reconciled from each message's current stored revision using conditional transactions. If an import stops after writing messages, rerunning it repairs the corresponding index entries without replacing live edits or deletions. Use the full `reindex` repair from `docs/backfill.md` only for inconsistencies outside the imported message set.

## Prerequisites

- Node.js 24 or newer.
- AWS credentials for the target account.
- The `unzip` command when importing directly from a `.zip` file.
- `MESSAGES_TABLE` and `SEARCH_INDEX_TABLE` table names.

Get table names from the deployed stack:

```bash
export AWS_PROFILE=<AWS_PROFILE>
export AWS_DEFAULT_REGION=ap-northeast-1
REGION="$AWS_DEFAULT_REGION"
STACK_NAME=slack-archiver

MESSAGES_TABLE=$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK_NAME" \
  --logical-resource-id MessagesTable \
  --region "$REGION" \
  --query 'StackResources[0].PhysicalResourceId' \
  --output text)

SEARCH_INDEX_TABLE=$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK_NAME" \
  --logical-resource-id SearchIndexTable \
  --region "$REGION" \
  --query 'StackResources[0].PhysicalResourceId' \
  --output text)
```

## Dry run

Run a small sample first. The script reads existing message keys even in dry-run mode so the duplicate count reflects the current table.

```bash
node scripts/import-slack-export.js \
  --source="/Users/konota/Downloads/AWSJ Support 2018NewGrads Slack export Mar 27 2025 - Jun 30 2026.zip" \
  --messages-table="$MESSAGES_TABLE" \
  --index-table="$SEARCH_INDEX_TABLE" \
  --region="$REGION" \
  --limit=100 \
  --dry-run
```

For a full dry run, remove `--limit`.

## Import

```bash
node scripts/import-slack-export.js \
  --source="/Users/konota/Downloads/AWSJ Support 2018NewGrads Slack export Mar 27 2025 - Jun 30 2026.zip" \
  --messages-table="$MESSAGES_TABLE" \
  --index-table="$SEARCH_INDEX_TABLE" \
  --region="$REGION"
```

If the export does not contain `users.json`, pass the workspace ID explicitly:

```bash
node scripts/import-slack-export.js \
  --source=slack-export.zip \
  --messages-table="$MESSAGES_TABLE" \
  --index-table="$SEARCH_INDEX_TABLE" \
  --team-id=<TEAM_ID>
```

The script can also import an already extracted export directory with the same `--source` option.

## Notes

- Public channel messages are imported from `channel-name/YYYY-MM-DD.json` files listed in `channels.json`; entries marked `is_private` are skipped.
- Messages with Slack subtypes, bot IDs, app IDs, or bot profiles are skipped to match the current live ingest behavior.
- Search-index writes use the current stored message revision and the same tokenizer as live ingestion.
- Re-running the command is safe; existing message keys, including tombstones, are skipped. Re-importing does not update a live-edited message, and reconciliation preserves concurrent edits/deletes.
- A rerun repairs partial index work for messages in that export. A full `reindex` is only needed for broader index inconsistencies.
