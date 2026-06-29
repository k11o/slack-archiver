const {
  DynamoDBClient,
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  ScanCommand,
  BatchWriteCommand,
} = require('@aws-sdk/lib-dynamodb');
const { tokenize } = require('../src/common/text');

const MAX_BATCH = 25;

function buildNewIndexEntries(message) {
  if (!message || !message.team_id || !message.channel_id || !message.ts) return [];
  const text = message.text || '';
  const tokens = tokenize(text);
  if (!tokens.length) return [];
  const pk = `workspace#${message.team_id}#channel#${message.channel_id}`;
  const sk = `ts#${message.ts}`;
  return tokens.map((token) => ({
    PutRequest: {
      Item: {
        pk: `workspace#${message.team_id}#token#${token}`,
        sk: `workspace#${message.team_id}#channel#${message.channel_id}#ts#${message.ts}`,
        token,
        team_id: message.team_id,
        message_pk: pk,
        message_sk: sk,
        ts: message.ts,
      },
    },
  }));
}

function isOldIndexEntry(item) {
  return Boolean(item && typeof item.pk === 'string' && item.pk.startsWith('token#'));
}

async function scanAll({ ddb, tableName, filterExpression, expressionValues, limit, dryRun }) {
  const items = [];
  let lastKey;
  do {
    const response = await ddb.send(new ScanCommand({
      TableName: tableName,
      FilterExpression: filterExpression,
      ExpressionAttributeValues: expressionValues,
      ExclusiveStartKey: lastKey,
      Limit: limit && !lastKey ? limit : undefined,
    }));
    for (const item of response.Items || []) {
      items.push(item);
      if (limit && items.length >= limit) {
        return { items, lastKey: response.LastEvaluatedKey };
      }
    }
    lastKey = response.LastEvaluatedKey;
    if (limit && items.length >= limit) break;
  } while (lastKey);
  return { items, lastKey: null };
}

async function writeBatches({ ddb, entries, indexTable, dryRun, label }) {
  let written = 0;
  for (let i = 0; i < entries.length; i += MAX_BATCH) {
    const chunk = entries.slice(i, i + MAX_BATCH);
    const requestItems = { [indexTable]: chunk };
    if (dryRun) {
      written += chunk.length;
    } else {
      await ddb.send(new BatchWriteCommand({ RequestItems: requestItems }));
      written += chunk.length;
    }
    if (written % 250 === 0 || written === entries.length) {
      process.stderr.write(`${label}: ${written}/${entries.length}\n`);
    }
  }
  return written;
}

async function deleteOldEntries({ ddb, items, indexTable, dryRun }) {
  let deleted = 0;
  for (let i = 0; i < items.length; i += MAX_BATCH) {
    const chunk = items.slice(i, i + MAX_BATCH);
    const requestItems = {};
    requestItems[indexTable] = chunk.map((item) => ({
      DeleteRequest: { Key: { pk: item.pk, sk: item.sk } },
    }));
    if (dryRun) {
      deleted += chunk.length;
    } else {
      await ddb.send(new BatchWriteCommand({ RequestItems: requestItems }));
      deleted += chunk.length;
    }
    if (deleted % 250 === 0 || deleted === items.length) {
      process.stderr.write(`cleanup-old: deleted ${deleted}/${items.length}\n`);
    }
  }
  return deleted;
}

async function reindex({ ddb, messagesTable, indexTable, teamId, limit, dryRun }) {
  const filterExpression = teamId ? 'team_id = :team' : undefined;
  const expressionValues = teamId ? { ':team': teamId } : undefined;
  process.stderr.write(`reindex: scanning ${messagesTable}${teamId ? ` (team_id=${teamId})` : ''}${dryRun ? ' [dry-run]' : ''}\n`);

  const { items: messages } = await scanAll({
    ddb, tableName: messagesTable, filterExpression, expressionValues, limit, dryRun,
  });
  process.stderr.write(`reindex: scanned ${messages.length} messages\n`);

  const entries = [];
  let skipped = 0;
  for (const message of messages) {
    const built = buildNewIndexEntries(message, indexTable);
    if (!built.length) {
      skipped += 1;
      continue;
    }
    for (const entry of built) entries.push(entry);
  }

  const written = await writeBatches({ ddb, entries, indexTable, dryRun, label: 'reindex' });
  process.stderr.write(`reindex: done. wrote ${written} index entries, skipped ${skipped} messages with no tokens\n`);
  return { scanned: messages.length, written, skipped };
}

async function cleanupOldIndex({ ddb, indexTable, limit, dryRun }) {
  process.stderr.write(`cleanup-old: scanning ${indexTable} for legacy token# entries${dryRun ? ' [dry-run]' : ''}\n`);
  const { items: oldEntries } = await scanAll({
    ddb, tableName: indexTable, limit, dryRun,
  });
  const targets = oldEntries.filter(isOldIndexEntry);
  process.stderr.write(`cleanup-old: found ${targets.length} legacy entries (out of ${oldEntries.length} scanned)\n`);

  const deleted = await deleteOldEntries({ ddb, items: targets, indexTable, dryRun });
  process.stderr.write(`cleanup-old: done. deleted ${deleted} legacy entries\n`);
  return { scanned: oldEntries.length, deleted };
}

function parseArgs(argv) {
  const args = { mode: 'reindex', dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === 'reindex' || arg === 'cleanup-old') args.mode = arg;
    else if (arg.startsWith('--messages-table=')) args.messagesTable = arg.split('=')[1];
    else if (arg.startsWith('--index-table=')) args.indexTable = arg.split('=')[1];
    else if (arg.startsWith('--region=')) args.region = arg.split('=')[1];
    else if (arg.startsWith('--team-id=')) args.teamId = arg.split('=')[1];
    else if (arg.startsWith('--limit=')) args.limit = Number(arg.split('=')[1]);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  process.stderr.write(`Usage: node scripts/backfill-search-index.js [reindex|cleanup-old] [options]

Modes:
  reindex        (default) Rebuild workspace-scoped search index entries
                 from the slack_messages table.
  cleanup-old    Delete legacy token#-prefixed entries from the search index.

Options:
  --messages-table=NAME   slack_messages table name (default: from stack output or MESSAGES_TABLE env)
  --index-table=NAME      slack_search_index table name (default: from stack output or SEARCH_INDEX_TABLE env)
  --region=REGION         AWS region (default: AWS_DEFAULT_REGION env or ap-northeast-1)
  --team-id=TEAM_ID       Only reindex messages for this Slack workspace (reindex mode only)
  --limit=N               Stop after scanning N items (for smoke testing)
  --dry-run               Print planned actions without writing or deleting
  -h, --help              Show this help

Examples:
  node scripts/backfill-search-index.js --dry-run
  node scripts/backfill-search-index.js reindex --team-id=T123 --limit=100
  node scripts/backfill-search-index.js cleanup-old --dry-run
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }

  const messagesTable = args.messagesTable || process.env.MESSAGES_TABLE;
  const indexTable = args.indexTable || process.env.SEARCH_INDEX_TABLE;
  const region = args.region || process.env.AWS_DEFAULT_REGION || 'ap-northeast-1';

  if (args.mode === 'reindex' && !messagesTable) {
    throw new Error('messages table name is required for reindex mode (use --messages-table or MESSAGES_TABLE env)');
  }
  if (!indexTable) {
    throw new Error('index table name is required (use --index-table or SEARCH_INDEX_TABLE env)');
  }

  const client = new DynamoDBClient({ region });
  const ddb = DynamoDBDocumentClient.from(client);

  if (args.mode === 'reindex') {
    await reindex({
      ddb,
      messagesTable,
      indexTable,
      teamId: args.teamId,
      limit: args.limit,
      dryRun: args.dryRun,
    });
  } else if (args.mode === 'cleanup-old') {
    await cleanupOldIndex({ ddb, indexTable, limit: args.limit, dryRun: args.dryRun });
  } else {
    throw new Error(`unknown mode: ${args.mode}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  buildNewIndexEntries,
  isOldIndexEntry,
  reindex,
  cleanupOldIndex,
  parseArgs,
};
