# Export archived channel messages

The Slack-authenticated Web UI can export every archived human message from one
public channel as a UTF-8 CSV file.

## User flow

1. Sign in to `/web` with Slack.
2. Choose a public channel, or enter an archived channel ID directly.
3. Select **Create CSV**.
4. Wait for the asynchronous export to finish.
5. Download the generated CSV within 24 hours.

The channel picker uses Slack `conversations.list`. An ID can be entered directly
when a channel still exists in the archive but Slack no longer returns it.

## CSV fields

| Field | Meaning |
|---|---|
| `workspace_id` | Slack workspace ID used to scope the archive query. |
| `channel_id` | Slack channel ID. |
| `channel_name` | Channel label selected in the Web UI or stored by an import. |
| `ts` | Original Slack message timestamp. |
| `time` | ISO 8601 representation of `ts`. |
| `user_id` | Slack author ID. |
| `user_name` | Current Slack display name, falling back to `user_id`. |
| `thread_ts` | Parent thread timestamp for replies. |
| `text` | Original archived Slack message text. |
| `created_at` | Archive insertion timestamp. |
| `updated_at` | Archive update timestamp. |
| `import_source` | `slack_events` or the stored import source. |

The file starts with a UTF-8 BOM for spreadsheet compatibility. Newlines,
commas, and quotes in message text are escaped according to CSV rules.
Cells beginning with spreadsheet formula characters are prefixed with an
apostrophe so archived user content cannot execute as a formula when opened.
Messages marked `deleted=true` are omitted. File bodies, reactions, and other
data that the archiver does not store are not added to the export.

## Processing model

`POST /api/exports` validates the Cognito JWT and records a job in
`ExportJobsTable`. It then invokes `ExportWorkerFunction` asynchronously.

The worker:

1. marks the job as running;
2. loads a workspace-scoped Slack user-name map when available;
3. queries `slack_messages` by
   `workspace#{team_id}#channel#{channel_id}`, following every DynamoDB page;
4. writes messages in timestamp order to a temporary CSV;
5. uploads the CSV to the private export bucket;
6. marks the job as completed.

The browser polls `GET /api/exports/{jobId}`. A completed response contains a
15-minute S3 presigned download URL.

## Access control and retention

- Cognito JWT verification and the optional Slack workspace allowlist match the
  Web search API.
- The authenticated `team_id` is always used to construct the message partition
  key; a caller cannot supply another workspace ID.
- Export jobs are owned by the authenticated Slack user ID. Other users receive
  `404 export_not_found`.
- The S3 bucket blocks all public access and uses server-side encryption.
- CSV objects and DynamoDB job records expire after approximately 24 hours.

S3 lifecycle deletion and DynamoDB TTL are asynchronous AWS processes, so
physical removal can occur after the configured expiration time.
