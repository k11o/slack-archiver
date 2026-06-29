const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildNewIndexEntries,
  isOldIndexEntry,
  reindex,
  cleanupOldIndex,
  parseArgs,
} = require('../scripts/backfill-search-index');

function message(overrides = {}) {
  return {
    pk: 'workspace#T123#channel#C1',
    sk: 'ts#1710000001.000000',
    team_id: 'T123',
    channel_id: 'C1',
    ts: '1710000001.000000',
    text: 'hello needle',
    ...overrides,
  };
}

test('buildNewIndexEntries produces workspace-scoped index entries matching ingest handler', () => {
  const entries = buildNewIndexEntries(message());
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.equal(entry.PutRequest.Item.pk.startsWith('workspace#T123#token#'), true);
    assert.equal(entry.PutRequest.Item.sk, 'workspace#T123#channel#C1#ts#1710000001.000000');
    assert.equal(entry.PutRequest.Item.team_id, 'T123');
    assert.equal(entry.PutRequest.Item.message_pk, 'workspace#T123#channel#C1');
    assert.equal(entry.PutRequest.Item.message_sk, 'ts#1710000001.000000');
  }
  assert.ok(entries.some((entry) => entry.PutRequest.Item.token === 'needle'));
});

test('buildNewIndexEntries scopes tokens per workspace and does not collide across teams', () => {
  const a = buildNewIndexEntries(message({ team_id: 'TA', channel_id: 'C1' }));
  const b = buildNewIndexEntries(message({ team_id: 'TB', channel_id: 'C1', ts: '1710000002.000000' }));
  const aPks = new Set(a.map((entry) => entry.PutRequest.Item.pk));
  const bPks = new Set(b.map((entry) => entry.PutRequest.Item.pk));
  for (const pk of bPks) assert.equal(aPks.has(pk), false);
});

test('buildNewIndexEntries returns empty for messages missing required fields or text', () => {
  assert.deepEqual(buildNewIndexEntries({ text: 'hello' }), []);
  assert.deepEqual(buildNewIndexEntries(message({ team_id: undefined })), []);
  assert.deepEqual(buildNewIndexEntries(message({ channel_id: undefined })), []);
  assert.deepEqual(buildNewIndexEntries(message({ ts: undefined })), []);
  assert.deepEqual(buildNewIndexEntries(message({ text: '' })), []);
  assert.deepEqual(buildNewIndexEntries(message({ text: '   ' })), []);
});

test('isOldIndexEntry detects legacy token# entries and rejects workspace-scoped entries', () => {
  assert.equal(isOldIndexEntry({ pk: 'token#needle' }), true);
  assert.equal(isOldIndexEntry({ pk: 'token#日本語' }), true);
  assert.equal(isOldIndexEntry({ pk: 'workspace#T123#token#needle' }), false);
  assert.equal(isOldIndexEntry({ pk: 'workspace#T_OTHER#token#needle' }), false);
  assert.equal(isOldIndexEntry({ pk: '' }), false);
  assert.equal(isOldIndexEntry({}), false);
  assert.equal(isOldIndexEntry(null), false);
});

test('parseArgs defaults to reindex mode and parses flags', () => {
  assert.deepEqual(parseArgs([]), { mode: 'reindex', dryRun: false });
  assert.deepEqual(parseArgs(['--dry-run']), { mode: 'reindex', dryRun: true });
  assert.equal(parseArgs(['cleanup-old']).mode, 'cleanup-old');
  assert.equal(parseArgs(['reindex']).mode, 'reindex');
  assert.equal(parseArgs(['--team-id=T123']).teamId, 'T123');
  assert.equal(parseArgs(['--limit=50']).limit, 50);
  assert.equal(parseArgs(['--messages-table=m', '--index-table=i']).messagesTable, 'm');
  assert.equal(parseArgs(['--messages-table=m', '--index-table=i']).indexTable, 'i');
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
});

test('reindex scans messages, writes workspace-scoped entries, and skips empty messages', async () => {
  const sent = [];
  const result = await reindex({
    ddb: {
      send: async (command) => {
        sent.push(command);
        if (command.constructor.name === 'ScanCommand') {
          return {
            Items: [
              message({ text: 'hello needle' }),
              message({ text: '', ts: '1710000002.000000' }),
              message({ team_id: 'T_OTHER', channel_id: 'C2', ts: '1710000003.000000', text: 'needle other' }),
            ],
            LastEvaluatedKey: null,
          };
        }
        return {};
      },
    },
    messagesTable: 'messages-table',
    indexTable: 'index-table',
  });

  assert.equal(result.scanned, 3);
  assert.equal(result.skipped, 1);
  assert.ok(result.written > 0);
  const batch = sent.find((command) => command.constructor.name === 'BatchWriteCommand');
  const items = batch.input.RequestItems['index-table'].map((entry) => entry.PutRequest.Item);
  assert.ok(items.every((item) => item.pk.startsWith('workspace#')));
  assert.ok(items.some((item) => item.pk.startsWith('workspace#T123#token#')));
  assert.ok(items.some((item) => item.pk.startsWith('workspace#T_OTHER#token#')));
});

test('reindex filters to a single team_id when teamId is provided', async () => {
  const sent = [];
  await reindex({
    ddb: {
      send: async (command) => {
        sent.push(command);
        if (command.constructor.name === 'ScanCommand') {
          assert.equal(command.input.FilterExpression, 'team_id = :team');
          assert.deepEqual(command.input.ExpressionAttributeValues, { ':team': 'T123' });
          return { Items: [message()], LastEvaluatedKey: null };
        }
        return {};
      },
    },
    messagesTable: 'messages-table',
    indexTable: 'index-table',
    teamId: 'T123',
  });
  assert.ok(sent.some((command) => command.constructor.name === 'BatchWriteCommand'));
});

test('reindex dry-run scans messages but does not send BatchWriteCommand', async () => {
  const sent = [];
  const result = await reindex({
    ddb: {
      send: async (command) => {
        sent.push(command);
        if (command.constructor.name === 'ScanCommand') {
          return { Items: [message()], LastEvaluatedKey: null };
        }
        return {};
      },
    },
    messagesTable: 'messages-table',
    indexTable: 'index-table',
    dryRun: true,
  });
  assert.equal(result.written > 0, true);
  assert.equal(sent.some((command) => command.constructor.name === 'BatchWriteCommand'), false);
});

test('cleanupOldIndex deletes only legacy token# entries and keeps workspace-scoped entries', async () => {
  const sent = [];
  const result = await cleanupOldIndex({
    ddb: {
      send: async (command) => {
        sent.push(command);
        if (command.constructor.name === 'ScanCommand') {
          return {
            Items: [
              { pk: 'token#needle', sk: 'workspace#T123#channel#C1#ts#1710000001.000000' },
              { pk: 'workspace#T123#token#needle', sk: 'workspace#T123#channel#C1#ts#1710000001.000000' },
              { pk: 'token#other', sk: 'workspace#T_OTHER#channel#C2#ts#1710000002.000000' },
            ],
            LastEvaluatedKey: null,
          };
        }
        return {};
      },
    },
    indexTable: 'index-table',
  });

  assert.equal(result.scanned, 3);
  assert.equal(result.deleted, 2);
  const batch = sent.find((command) => command.constructor.name === 'BatchWriteCommand');
  const deletes = batch.input.RequestItems['index-table'];
  assert.deepEqual(deletes.map((entry) => entry.DeleteRequest.Key), [
    { pk: 'token#needle', sk: 'workspace#T123#channel#C1#ts#1710000001.000000' },
    { pk: 'token#other', sk: 'workspace#T_OTHER#channel#C2#ts#1710000002.000000' },
  ]);
});

test('cleanupOldIndex dry-run does not send BatchWriteCommand', async () => {
  const sent = [];
  await cleanupOldIndex({
    ddb: {
      send: async (command) => {
        sent.push(command);
        if (command.constructor.name === 'ScanCommand') {
          return { Items: [{ pk: 'token#needle', sk: 'x' }], LastEvaluatedKey: null };
        }
        return {};
      },
    },
    indexTable: 'index-table',
    dryRun: true,
  });
  assert.equal(sent.some((command) => command.constructor.name === 'BatchWriteCommand'), false);
});
