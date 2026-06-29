# Search index backfill

One-time migration runbook for the multi-tenant change.

## Why this is needed

The `slack_search_index` table partition key changed from `token#{token}` to `workspace#{team_id}#token#{token}` so searches can be scoped per Slack workspace.

The `slack_messages` table was already workspace-scoped (`workspace#{team_id}#channel#{channel_id}`) and is unaffected.

After deploying the multi-tenant code, the search Lambda only queries the new `workspace#...` PK format, so legacy `token#...` index entries stop matching. Existing archived messages become unsearchable until the index is rebuilt.

## Prerequisites

- AWS CLI authenticated to the target account (`aws sts get-caller-identity`).
- `npm install` has been run in the repository.
- The multi-tenant code is deployed (`uv run sam deploy`).
- The `slack_messages` table still contains the archived messages. The backfill re-tokenizes from that table, so it does not depend on the old index entries being intact.

## Get the table names

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

The backfill script reads AWS credentials from the standard SDK credential chain, so exporting `AWS_PROFILE` and `AWS_DEFAULT_REGION` before running is enough.

## Rebuild the index (reindex mode)

`reindex` scans `slack_messages`, re-tokenizes each message with the same `src/common/text.js` logic used by the ingest Lambda, and writes workspace-scoped entries to `slack_search_index`.

It is idempotent: re-running overwrites the same `pk`/`sk` entries. Messages with no extractable tokens (empty text, missing `team_id`/`channel_id`/`ts`) are skipped.

### Dry run first

```bash
node scripts/backfill-search-index.js reindex \
  --messages-table="$MESSAGES_TABLE" \
  --index-table="$SEARCH_INDEX_TABLE" \
  --region="$REGION" \
  --dry-run
```

### Smoke test on a small sample

```bash
node scripts/backfill-search-index.js reindex \
  --messages-table="$MESSAGES_TABLE" \
  --index-table="$SEARCH_INDEX_TABLE" \
  --limit=20
```

### Reindex one workspace

Use this to verify a single Slack workspace before processing the whole table:

```bash
node scripts/backfill-search-index.js reindex \
  --messages-table="$MESSAGES_TABLE" \
  --index-table="$SEARCH_INDEX_TABLE" \
  --team-id=<TEAM_ID>
```

### Reindex everything

```bash
node scripts/backfill-search-index.js reindex \
  --messages-table="$MESSAGES_TABLE" \
  --index-table="$SEARCH_INDEX_TABLE"
```

Progress is written to stderr. For a small workspace this finishes in one scan pass; for larger tables the script paginates with `LastEvaluatedKey` automatically.

## Delete legacy entries (cleanup-old mode)

After `reindex` confirms new entries are searchable, the old `token#...` entries in `slack_search_index` are dead data. They are never queried by the deployed code, but they still consume storage.

`cleanup-old` scans `slack_search_index`, filters to entries whose `pk` starts with `token#`, and deletes them. It leaves `workspace#...` entries untouched.

### Dry run first

```bash
node scripts/backfill-search-index.js cleanup-old \
  --index-table="$SEARCH_INDEX_TABLE" \
  --dry-run
```

### Delete

```bash
node scripts/backfill-search-index.js cleanup-old \
  --index-table="$SEARCH_INDEX_TABLE"
```

## Verification

After `reindex`:

1. Run `/hi-nick <known word>` in Slack and confirm hits return.
2. Open the Web UI, sign in, and search for the same word. Confirm results come only from the signed-in user's workspace.
3. For multi-workspace verification, reindex a second workspace with `--team-id` and confirm searches do not cross workspaces.

After `cleanup-old`:

- A `cleanup-old --dry-run` should report `found 0 legacy entries`.

## Safety notes

- Run `reindex` before `cleanup-old`. Deleting legacy entries before rebuilding would leave a window where neither old nor new queries match.
- The script uses `BatchWriteItem` with 25-item batches and retries are handled by the SDK. For very large tables, consider running it during a low-traffic window.
- The script does not modify the `slack_messages` table. Source data is never deleted.
- `--dry-run` performs read scans only; it never writes or deletes.
- The script is safe to re-run. `reindex` overwrites; `cleanup-old` is a no-op once no `token#` entries remain.
