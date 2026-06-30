const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  BatchGetCommand,
  BatchWriteCommand,
} = require('@aws-sdk/lib-dynamodb');
const { normalizeText, tokenize } = require('../src/common/text');

const MAX_BATCH_WRITE = 25;
const MAX_BATCH_GET = 100;

function parseArgs(argv) {
  const args = { dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('--messages-table=')) args.messagesTable = arg.split('=')[1];
    else if (arg.startsWith('--index-table=')) args.indexTable = arg.split('=')[1];
    else if (arg.startsWith('--team-id=')) args.teamId = arg.split('=')[1];
    else if (arg.startsWith('--region=')) args.region = arg.split('=')[1];
    else if (arg.startsWith('--limit=')) args.limit = Number(arg.split('=')[1]);
    else if (arg.startsWith('--source=')) args.source = arg.split('=')[1];
    else if (!args.source) args.source = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  process.stderr.write(`Usage: node scripts/import-slack-export.js --source=EXPORT.zip [options]

Import a Slack official export ZIP, or an already extracted export directory, into
the slack_messages table and rebuild matching slack_search_index entries.

Options:
  --source=PATH           Slack official export .zip or extracted directory
  --messages-table=NAME   slack_messages table name (default: MESSAGES_TABLE env)
  --index-table=NAME      slack_search_index table name (default: SEARCH_INDEX_TABLE env)
  --team-id=TEAM_ID       Slack workspace ID. Inferred from users.json when omitted
  --region=REGION         AWS region (default: AWS_DEFAULT_REGION env or ap-northeast-1)
  --limit=N               Stop after considering N importable messages
  --dry-run               Read and dedupe, but do not write to DynamoDB
  -h, --help              Show this help

Examples:
  node scripts/import-slack-export.js --source=slack-export.zip --dry-run
  node scripts/import-slack-export.js --source=slack-export.zip --team-id=T123
`);
}

function listSourceEntries(source) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) return listDirectoryEntries(source);
  return execFileSync('unzip', ['-Z1', source], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean)
    .map((name) => ({ name, isDirectory: name.endsWith('/') }));
}

function listDirectoryEntries(root) {
  const entries = [];
  function walk(dir) {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, dirent.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (dirent.isDirectory()) {
        entries.push({ name: `${relative}/`, isDirectory: true });
        walk(absolute);
      } else {
        entries.push({ name: relative, isDirectory: false });
      }
    }
  }
  walk(root);
  return entries;
}

function readSourceFile(source, entryName) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) return fs.readFileSync(path.join(source, entryName), 'utf8');
  return execFileSync('unzip', ['-p', source, entryName], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function readJson(source, entryName) {
  return JSON.parse(readSourceFile(source, entryName));
}

function findEntry(entries, basename) {
  return entries.find((entry) => !entry.isDirectory && entry.name === basename)
    || entries.find((entry) => !entry.isDirectory && entry.name.endsWith(`/${basename}`));
}

function loadChannelMap({ source, entries }) {
  const channelsEntry = findEntry(entries, 'channels.json');
  if (!channelsEntry) throw new Error('channels.json not found in Slack export');
  const channels = readJson(source, channelsEntry.name);
  const byName = new Map();
  for (const channel of channels) {
    if (channel && channel.name && channel.id) byName.set(channel.name, channel);
  }
  return byName;
}

function inferTeamId({ source, entries, explicitTeamId }) {
  if (explicitTeamId) return explicitTeamId;

  const usersEntry = findEntry(entries, 'users.json');
  if (usersEntry) {
    const teamIds = new Set();
    for (const user of readJson(source, usersEntry.name)) {
      if (user?.team_id) teamIds.add(user.team_id);
      if (user?.team) teamIds.add(user.team);
    }
    if (teamIds.size === 1) return [...teamIds][0];
  }

  return null;
}

function messageFileEntries(entries) {
  return entries
    .filter((entry) => !entry.isDirectory && /^[^/]+\/\d{4}-\d{2}-\d{2}\.json$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function isIgnoredExportMessage(message) {
  return Boolean(
    !message
    || message.type !== 'message'
    || message.subtype
    || message.bot_id
    || message.app_id
    || message.bot_profile
  );
}

function buildMessageItem({ message, teamId, channel }) {
  const ts = message.ts;
  const text = message.text || '';
  const now = new Date().toISOString();
  const pk = `workspace#${teamId}#channel#${channel.id}`;
  const sk = `ts#${ts}`;
  return {
    pk,
    sk,
    message_id: `${teamId}:${channel.id}:${ts}`,
    team_id: teamId,
    channel_id: channel.id,
    channel_name: channel.name,
    user_id: message.user || null,
    subtype: message.subtype || null,
    bot_id: message.bot_id || null,
    app_id: message.app_id || null,
    bot_profile: message.bot_profile || null,
    ts,
    thread_ts: message.thread_ts || null,
    text,
    normalized_text: normalizeText(text),
    client_msg_id: message.client_msg_id || null,
    event_id: null,
    deleted: false,
    import_source: 'slack_export',
    created_at: now,
    updated_at: now,
  };
}

function buildIndexWriteRequests(message) {
  return tokenize(message.text).map((token) => ({
    PutRequest: {
      Item: {
        pk: `workspace#${message.team_id}#token#${token}`,
        sk: `workspace#${message.team_id}#channel#${message.channel_id}#ts#${message.ts}`,
        token,
        team_id: message.team_id,
        message_pk: message.pk,
        message_sk: message.sk,
        ts: message.ts,
      },
    },
  }));
}

function uniqueByKey(items, keyFn) {
  const seen = new Set();
  const unique = [];
  let duplicates = 0;
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    unique.push(item);
  }
  return { unique, duplicates };
}

async function batchGetExistingKeys({ ddb, tableName, keys }) {
  const existing = new Set();
  for (let i = 0; i < keys.length; i += MAX_BATCH_GET) {
    let requestKeys = keys.slice(i, i + MAX_BATCH_GET);
    do {
      const response = await ddb.send(new BatchGetCommand({
        RequestItems: { [tableName]: { Keys: requestKeys } },
      }));
      for (const item of response.Responses?.[tableName] || []) {
        existing.add(`${item.pk}\0${item.sk}`);
      }
      requestKeys = response.UnprocessedKeys?.[tableName]?.Keys || [];
    } while (requestKeys.length);
  }
  return existing;
}

async function batchWrite({ ddb, tableName, requests, dryRun, label }) {
  let written = 0;
  for (let i = 0; i < requests.length; i += MAX_BATCH_WRITE) {
    let chunk = requests.slice(i, i + MAX_BATCH_WRITE);
    if (dryRun) {
      written += chunk.length;
    } else {
      do {
        const response = await ddb.send(new BatchWriteCommand({ RequestItems: { [tableName]: chunk } }));
        written += chunk.length - (response.UnprocessedItems?.[tableName]?.length || 0);
        chunk = response.UnprocessedItems?.[tableName] || [];
      } while (chunk.length);
    }
    if (written % 250 === 0 || i + MAX_BATCH_WRITE >= requests.length) {
      process.stderr.write(`${label}: ${written}/${requests.length}\n`);
    }
  }
  return written;
}

async function importSlackExport({
  ddb,
  source,
  messagesTable,
  indexTable,
  teamId: explicitTeamId,
  limit,
  dryRun,
}) {
  const entries = listSourceEntries(source);
  const channelMap = loadChannelMap({ source, entries });
  const inferredTeamId = inferTeamId({ source, entries, explicitTeamId });
  const files = messageFileEntries(entries);
  const stats = {
    files: 0,
    considered: 0,
    imported: 0,
    skippedDuplicate: 0,
    skippedIgnored: 0,
    skippedMissingChannel: 0,
    skippedMissingTeam: 0,
    indexWritten: 0,
  };

  for (const file of files) {
    if (limit && stats.considered >= limit) break;
    stats.files += 1;
    const [channelName] = file.name.split('/');
    const channel = channelMap.get(channelName);
    if (!channel) {
      stats.skippedMissingChannel += 1;
      continue;
    }

    const messages = readJson(source, file.name);
    const candidates = [];
    for (const message of messages) {
      if (limit && stats.considered >= limit) break;
      if (isIgnoredExportMessage(message)) {
        stats.skippedIgnored += 1;
        continue;
      }
      const teamId = message.team || message.user_team || message.source_team || inferredTeamId;
      if (!teamId) {
        stats.skippedMissingTeam += 1;
        continue;
      }
      stats.considered += 1;
      candidates.push(buildMessageItem({ message, teamId, channel }));
    }

    const { unique: uniqueCandidates, duplicates } = uniqueByKey(candidates, (item) => `${item.pk}\0${item.sk}`);
    stats.skippedDuplicate += duplicates;
    if (!uniqueCandidates.length) continue;

    const existing = await batchGetExistingKeys({
      ddb,
      tableName: messagesTable,
      keys: uniqueCandidates.map((item) => ({ pk: item.pk, sk: item.sk })),
    });
    const newMessages = uniqueCandidates.filter((item) => !existing.has(`${item.pk}\0${item.sk}`));
    stats.skippedDuplicate += uniqueCandidates.length - newMessages.length;
    if (!newMessages.length) continue;

    const messageRequests = newMessages.map((item) => ({ PutRequest: { Item: item } }));
    await batchWrite({ ddb, tableName: messagesTable, requests: messageRequests, dryRun, label: 'messages' });
    stats.imported += newMessages.length;

    const indexRequests = [];
    for (const message of newMessages) {
      for (const request of buildIndexWriteRequests(message)) indexRequests.push(request);
    }
    const { unique: uniqueIndexRequests } = uniqueByKey(
      indexRequests,
      (request) => `${request.PutRequest.Item.pk}\0${request.PutRequest.Item.sk}`,
    );
    stats.indexWritten += await batchWrite({
      ddb,
      tableName: indexTable,
      requests: uniqueIndexRequests,
      dryRun,
      label: 'index',
    });
  }

  process.stderr.write(`import: done ${JSON.stringify(stats)}${dryRun ? ' [dry-run]' : ''}\n`);
  return stats;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }

  const source = args.source;
  const messagesTable = args.messagesTable || process.env.MESSAGES_TABLE;
  const indexTable = args.indexTable || process.env.SEARCH_INDEX_TABLE;
  const region = args.region || process.env.AWS_DEFAULT_REGION || 'ap-northeast-1';

  if (!source) throw new Error('source path is required (use --source)');
  if (!messagesTable) throw new Error('messages table name is required (use --messages-table or MESSAGES_TABLE env)');
  if (!indexTable) throw new Error('index table name is required (use --index-table or SEARCH_INDEX_TABLE env)');

  const client = new DynamoDBClient({ region });
  const ddb = DynamoDBDocumentClient.from(client);
  await importSlackExport({
    ddb,
    source,
    messagesTable,
    indexTable,
    teamId: args.teamId,
    limit: args.limit,
    dryRun: args.dryRun,
  });
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  messageFileEntries,
  inferTeamId,
  isIgnoredExportMessage,
  buildMessageItem,
  buildIndexWriteRequests,
  importSlackExport,
};
