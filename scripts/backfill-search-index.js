const {
  DynamoDBClient,
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  ScanCommand,
  BatchWriteCommand,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');
const { tokenize, isIndexableToken } = require('../src/common/text');
const { reconcileSearchIndex } = require('../src/ingest/handler');

const MAX_BATCH = 25;

function buildNewIndexEntries(message) {
  if (!message || message.deleted || !message.team_id || !message.channel_id || !message.ts) return [];
  const tokens = (message.search_tokens || tokenize(message.text || '')).filter(isIndexableToken);
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
        revision_ts: message.revision_ts || Number.parseFloat(message.ts) || 0,
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
      ConsistentRead: true,
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

async function writeBatches({ ddb, entries, indexTable, dryRun, label, sleep = wait }) {
  let written = 0;
  for (let i = 0; i < entries.length; i += MAX_BATCH) {
    let pending = entries.slice(i, i + MAX_BATCH);
    if (dryRun) {
      written += pending.length;
    } else {
      for (let attempt = 0; pending.length && attempt < 5; attempt += 1) {
        const response = await ddb.send(new BatchWriteCommand({ RequestItems: { [indexTable]: pending } }));
        const unprocessed = response.UnprocessedItems?.[indexTable] || [];
        written += pending.length - unprocessed.length;
        pending = unprocessed;
        if (pending.length && attempt < 4) await sleep(25 * (2 ** attempt));
      }
      if (pending.length) throw new Error(`${label}: ${pending.length} writes remained unprocessed`);
    }
    if (written % 250 === 0 || i + MAX_BATCH >= entries.length) {
      process.stderr.write(`${label}: ${written}/${entries.length}\n`);
    }
  }
  return written;
}

async function deleteOldEntries({ ddb, items, indexTable, dryRun }) {
  return writeBatches({
    ddb,
    indexTable,
    dryRun,
    label: 'cleanup-old',
    entries: items.map((item) => ({ DeleteRequest: { Key: { pk: item.pk, sk: item.sk } } })),
  });
}

async function deleteStaleIndexEntries({ ddb, indexTable, messagesTable, desiredKeys, teamId, dryRun }) {
  const prefix = teamId ? `workspace#${teamId}#token#` : 'workspace#';
  const { items } = await scanAll({
    ddb,
    tableName: indexTable,
    filterExpression: 'begins_with(pk, :prefix) AND contains(pk, :token_marker)',
    expressionValues: { ':prefix': prefix, ':token_marker': '#token#' },
    dryRun,
  });
  if (dryRun) {
    const stale = items.filter((item) => !desiredKeys.has(`${item.pk}\0${item.sk}`));
    return { scanned: items.length, deleted: await deleteOldEntries({ ddb, items: stale, indexTable, dryRun }) };
  }

  let deleted = 0;
  for (const item of items) {
    if (await deleteStaleIndexEntry({ ddb, indexTable, messagesTable, item })) deleted += 1;
  }
  return { scanned: items.length, deleted };
}

async function deleteStaleIndexEntry({ ddb, indexTable, messagesTable, item }) {
  if (!item.message_pk || !item.message_sk) return false;
  const indexKey = { pk: item.pk, sk: item.sk };
  const messageKey = { pk: item.message_pk, sk: item.message_sk };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [indexResult, messageResult] = await Promise.all([
      ddb.send(new GetCommand({ TableName: indexTable, Key: indexKey, ConsistentRead: true })),
      ddb.send(new GetCommand({ TableName: messagesTable, Key: messageKey, ConsistentRead: true })),
    ]);
    const currentIndex = indexResult.Item;
    if (!currentIndex) return false;
    const message = messageResult.Item;
    const marker = '#token#';
    const token = currentIndex.token || currentIndex.pk.slice(currentIndex.pk.indexOf(marker) + marker.length);
    if (message && getSearchTokens(message).includes(token)) return false;

    const messageCondition = message?.revision_ts === undefined
      ? 'attribute_not_exists(revision_ts)'
      : 'revision_ts = :messageRevision';
    const indexCondition = currentIndex.revision_ts === undefined
      ? 'attribute_not_exists(revision_ts)'
      : 'revision_ts = :indexRevision';
    try {
      await ddb.send(new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: messagesTable,
              Key: messageKey,
              ConditionExpression: message ? messageCondition : 'attribute_not_exists(pk)',
              ...(message?.revision_ts === undefined || !message ? {} : {
                ExpressionAttributeValues: { ':messageRevision': message.revision_ts },
              }),
            },
          },
          {
            Delete: {
              TableName: indexTable,
              Key: indexKey,
              ConditionExpression: indexCondition,
              ...(currentIndex.revision_ts === undefined ? {} : {
                ExpressionAttributeValues: { ':indexRevision': currentIndex.revision_ts },
              }),
            },
          },
        ],
      }));
      return true;
    } catch (error) {
      if (error.name !== 'TransactionCanceledException'
        && error.name !== 'ConditionalCheckFailedException') throw error;
    }
  }
  throw new Error('search index changed concurrently; retry reindex');
}

function getSearchTokens(message) {
  if (!message.team_id || !message.channel_id || !message.ts) return [];
  return (message.deleted ? [] : (message.search_tokens || tokenize(message.text || '')))
    .filter(isIndexableToken);
}

async function clearTombstoneIndexTokens({ ddb, messagesTable, messages, dryRun }) {
  let cleared = 0;
  for (const message of messages) {
    if (!message.deleted || dryRun) continue;
    const result = await ddb.send(new GetCommand({
      TableName: messagesTable,
      Key: { pk: message.pk, sk: message.sk },
      ConsistentRead: true,
    }));
    const current = result.Item;
    if (!current?.deleted || !Array.isArray(current.index_tokens)) continue;
    try {
      await ddb.send(new UpdateCommand({
        TableName: messagesTable,
        Key: { pk: current.pk, sk: current.sk },
        UpdateExpression: 'REMOVE index_tokens',
        ConditionExpression: current.revision_ts === undefined
          ? '#deleted = :deleted AND attribute_not_exists(revision_ts)'
          : '#deleted = :deleted AND revision_ts = :revision',
        ExpressionAttributeNames: { '#deleted': 'deleted' },
        ExpressionAttributeValues: {
          ':deleted': true,
          ...(current.revision_ts === undefined ? {} : { ':revision': current.revision_ts }),
        },
      }));
      cleared += 1;
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
    }
  }
  return cleared;
}

async function reindex({ ddb, messagesTable, indexTable, teamId, limit, dryRun }) {
  if (messagesTable === indexTable) throw new Error('messages and index tables must be different');
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
    const built = buildNewIndexEntries(message);
    if (!built.length) {
      skipped += 1;
      continue;
    }
    entries.push(...built);
  }

  const uniqueEntries = [...new Map(entries.map((entry) => {
    const item = entry.PutRequest.Item;
    return [`${item.pk}\0${item.sk}`, entry];
  })).values()];
  const desiredKeys = new Set(uniqueEntries.map((entry) => {
    const item = entry.PutRequest.Item;
    return `${item.pk}\0${item.sk}`;
  }));
  let written = 0;
  if (dryRun) {
    written = await writeBatches({ ddb, entries: uniqueEntries, indexTable, dryRun, label: 'reindex' });
  } else {
    for (const message of messages) {
      written += await reconcileSearchIndex({
        message,
        ddbSend: (command) => ddb.send(command),
        messagesTable,
        indexTable,
      });
    }
  }
  const cleanup = limit
    ? { scanned: 0, deleted: 0 }
    : await deleteStaleIndexEntries({ ddb, indexTable, messagesTable, desiredKeys, teamId, dryRun });
  const cleared = limit ? 0 : await clearTombstoneIndexTokens({ ddb, messagesTable, messages, dryRun });
  process.stderr.write(`reindex: done. wrote ${written} index entries, removed ${cleanup.deleted} stale entries, cleared ${cleared} tombstones, skipped ${skipped} messages\n`);
  return { scanned: messages.length, written, skipped, deleted: cleanup.deleted, cleared };
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
    else if (arg.startsWith('--team-id=')) {
      args.teamId = arg.slice('--team-id='.length);
      if (!/^T[A-Z0-9]+$/.test(args.teamId)) throw new Error('--team-id must be a Slack team ID');
    } else if (arg.startsWith('--limit=')) {
      args.limit = Number(arg.slice('--limit='.length));
      if (!Number.isSafeInteger(args.limit) || args.limit < 1) throw new Error('--limit must be a positive integer');
    }
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  process.stderr.write(`Usage: node scripts/backfill-search-index.js [reindex|cleanup-old] [options]

Modes:
  reindex        (default) Rebuild workspace-scoped search index entries
                 from messages and remove stale entries (including deleted messages).
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

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

module.exports = {
  buildNewIndexEntries,
  isOldIndexEntry,
  writeBatches,
  deleteStaleIndexEntries,
  clearTombstoneIndexTokens,
  reindex,
  cleanupOldIndex,
  parseArgs,
};
