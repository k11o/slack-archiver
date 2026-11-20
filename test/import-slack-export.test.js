const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  parseArgs,
  messageFileEntries,
  inferTeamId,
  isIgnoredExportMessage,
  buildMessageItem,
  buildIndexWriteRequests,
  batchWrite,
  putNewMessages,
  importSlackExport,
} = require('../scripts/import-slack-export');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
}

function makeExportDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-export-'));
  writeJson(path.join(dir, 'channels.json'), [
    { id: 'C1', name: 'general' },
    { id: 'C2', name: 'random' },
  ]);
  writeJson(path.join(dir, 'users.json'), [
    { id: 'U1', team_id: 'T123' },
    { id: 'U2', team_id: 'T123' },
  ]);
  writeJson(path.join(dir, 'general', '2026-06-30.json'), [
    {
      type: 'message',
      user: 'U1',
      ts: '1782803731.223699',
      text: 'hello import needle',
      team: 'T123',
      client_msg_id: 'client-1',
    },
    {
      type: 'message',
      user: 'U1',
      ts: '1782803731.223699',
      text: 'duplicate in export',
      team: 'T123',
    },
    {
      type: 'message',
      subtype: 'channel_join',
      user: 'U2',
      ts: '1782803732.000000',
      text: '<@U2> joined the channel',
      team: 'T123',
    },
  ]);
  writeJson(path.join(dir, 'random', '2026-06-30.json'), [
    {
      type: 'message',
      user: 'U2',
      ts: '1782803733.000000',
      text: 'already archived',
      team: 'T123',
    },
  ]);
  return dir;
}

test('parseArgs parses import options', () => {
  assert.deepEqual(parseArgs(['--source=export.zip', '--dry-run']), {
    source: 'export.zip',
    dryRun: true,
  });
  assert.equal(parseArgs(['export.zip', '--team-id=T123']).source, 'export.zip');
  assert.equal(parseArgs(['--messages-table=m', '--index-table=i']).messagesTable, 'm');
  assert.equal(parseArgs(['--limit=10']).limit, 10);
  assert.throws(() => parseArgs(['a.zip', 'b.zip']), /unknown argument/);
});

test('messageFileEntries finds dated channel files only', () => {
  const files = messageFileEntries([
    { name: 'channels.json', isDirectory: false },
    { name: 'general/', isDirectory: true },
    { name: 'general/2026-06-30.json', isDirectory: false },
    { name: 'general/readme.txt', isDirectory: false },
    { name: 'users.json', isDirectory: false },
  ]);
  assert.deepEqual(files.map((entry) => entry.name), ['general/2026-06-30.json']);
});

test('inferTeamId reads the single workspace ID from users.json', () => {
  const source = makeExportDir();
  const entries = [
    { name: 'users.json', isDirectory: false },
  ];
  assert.equal(inferTeamId({ source, entries }), 'T123');
});

test('isIgnoredExportMessage matches current live ingest filtering', () => {
  assert.equal(isIgnoredExportMessage({ type: 'message', user: 'U1', text: 'human' }), false);
  assert.equal(isIgnoredExportMessage({ type: 'message', subtype: 'bot_message' }), true);
  assert.equal(isIgnoredExportMessage({ type: 'message', bot_id: 'B1' }), true);
  assert.equal(isIgnoredExportMessage({ type: 'file' }), true);
});

test('importSlackExport skips channels marked private in Slack export metadata', async () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-private-export-'));
  writeJson(path.join(source, 'channels.json'), [{ id: 'C_PRIVATE', name: 'private', is_private: true }]);
  writeJson(path.join(source, 'users.json'), [{ id: 'U1', team_id: 'T123' }]);
  writeJson(path.join(source, 'private', '2026-06-30.json'), [
    { type: 'message', user: 'U1', team: 'T123', ts: '1782803731.223699', text: 'secret' },
  ]);
  const result = await importSlackExport({
    ddb: { send: async () => { throw new Error('private channel must not be written'); } },
    source,
    messagesTable: 'messages',
    indexTable: 'index',
  });

  assert.equal(result.imported, 0);
  assert.equal(result.skippedMissingChannel, 1);
});

test('buildMessageItem and buildIndexWriteRequests use existing table keys', () => {
  const item = buildMessageItem({
    teamId: 'T123',
    channel: { id: 'C1', name: 'general' },
    message: {
      type: 'message',
      user: 'U1',
      ts: '1782803731.223699',
      text: 'hello import needle',
      client_msg_id: 'client-1',
    },
  });
  assert.equal(item.pk, 'workspace#T123#channel#C1');
  assert.equal(item.sk, 'ts#1782803731.223699');
  assert.equal(item.channel_name, 'general');
  assert.equal(item.import_source, 'slack_export');
  assert.equal(item.revision_ts, Number.parseFloat(item.ts));
  const edited = buildMessageItem({
    teamId: 'T123',
    channel: { id: 'C1', name: 'general' },
    message: { ts: item.ts, edited: { ts: '1782803732.000000' }, text: 'edited' },
  });
  assert.equal(edited.revision_ts, 1782803732);
  assert.deepEqual(item.search_tokens, item.index_tokens);

  const indexItems = buildIndexWriteRequests(item).map((request) => request.PutRequest.Item);
  assert.ok(indexItems.some((entry) => entry.pk === 'workspace#T123#token#needle'));
  assert.ok(indexItems.every((entry) => entry.message_pk === item.pk));
});

test('importSlackExport imports only new human messages and skips duplicates', async () => {
  const source = makeExportDir();
  const sent = [];
  const existingKey = 'workspace#T123#channel#C2\0ts#1782803733.000000';

  const result = await importSlackExport({
    ddb: {
      send: async (command) => {
        sent.push(command);
        if (command.constructor.name === 'BatchGetCommand') {
          const responses = [];
          for (const key of command.input.RequestItems.messages.Keys) {
            if (`${key.pk}\0${key.sk}` === existingKey) responses.push(key);
          }
          return { Responses: { messages: responses } };
        }
        return {};
      },
    },
    source,
    messagesTable: 'messages',
    indexTable: 'index',
    dryRun: false,
  });

  assert.equal(result.considered, 3);
  assert.equal(result.imported, 1);
  assert.equal(result.skippedIgnored, 1);
  assert.equal(result.skippedDuplicate, 2);
  assert.ok(result.indexWritten > 0);

  const messageWrites = sent.filter((command) => command.constructor.name === 'PutCommand');
  assert.equal(messageWrites.length, 1);
  assert.equal(messageWrites[0].input.Item.text, 'hello import needle');
  assert.equal(messageWrites[0].input.ConditionExpression, 'attribute_not_exists(pk)');
});

test('conditional import skips a tombstone created after the duplicate check', async () => {
  const inserted = await putNewMessages({
    ddb: {
      send: async () => {
        throw Object.assign(new Error('already exists'), { name: 'ConditionalCheckFailedException' });
      },
    },
    tableName: 'messages',
    items: [buildMessageItem({
      teamId: 'T123',
      channel: { id: 'C1', name: 'general' },
      message: { ts: '1782803731.223699', user: 'U1', text: 'old content' },
    })],
  });

  assert.deepEqual(inserted, []);
});

test('batchWrite retries unprocessed index entries', async () => {
  let calls = 0;
  const request = { PutRequest: { Item: { pk: 'p', sk: 's' } } };
  const written = await batchWrite({
    ddb: {
      send: async () => {
        calls += 1;
        return calls === 1 ? { UnprocessedItems: { index: [request] } } : {};
      },
    },
    tableName: 'index',
    requests: [request],
    dryRun: false,
    label: 'index',
    sleep: async () => {},
  });

  assert.equal(calls, 2);
  assert.equal(written, 1);
});

test('importSlackExport dry-run dedupes but does not write', async () => {
  const source = makeExportDir();
  const sent = [];

  const result = await importSlackExport({
    ddb: {
      send: async (command) => {
        sent.push(command);
        if (command.constructor.name === 'BatchGetCommand') return { Responses: { messages: [] } };
        throw new Error('dry run should not write');
      },
    },
    source,
    messagesTable: 'messages',
    indexTable: 'index',
    dryRun: true,
    limit: 1,
  });

  assert.equal(result.considered, 1);
  assert.equal(result.imported, 1);
  assert.equal(sent.every((command) => command.constructor.name === 'BatchGetCommand'), true);
});
