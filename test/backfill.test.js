const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildNewIndexEntries,
  isOldIndexEntry,
  writeBatches,
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

function memoryDdb({ messages = [], indexes = [] } = {}) {
  const keyOf = ({ pk, sk }) => JSON.stringify([pk, sk]);
  const records = new Map(messages.map((item) => [keyOf(item), structuredClone(item)]));
  const index = new Map(indexes.map((item) => [keyOf(item), structuredClone(item)]));
  const sent = [];
  return {
    records,
    index,
    sent,
    async send(command) {
      sent.push(command);
      const { name } = command.constructor;
      if (name === 'ScanCommand') {
        const tableItems = command.input.TableName === 'messages-table' ? records : index;
        let items = [...tableItems.values()];
        const values = command.input.ExpressionAttributeValues || {};
        if (command.input.FilterExpression?.startsWith('team_id =')) {
          items = items.filter((item) => item.team_id === values[':team']);
        }
        if (command.input.FilterExpression?.startsWith('begins_with')) {
          items = items.filter((item) => item.pk.startsWith(values[':prefix']) && item.pk.includes(values[':token_marker']));
        }
        return { Items: structuredClone(items), LastEvaluatedKey: null };
      }
      if (name === 'GetCommand') {
        const tableItems = command.input.TableName === 'messages-table' ? records : index;
        return { Item: structuredClone(tableItems.get(keyOf(command.input.Key))) };
      }
      if (name === 'TransactWriteCommand') {
        for (const action of command.input.TransactItems) {
          if (action.ConditionCheck) {
            const check = action.ConditionCheck;
            const current = records.get(keyOf(check.Key));
            const values = check.ExpressionAttributeValues || {};
            if (check.ConditionExpression === 'attribute_not_exists(pk)' ? Boolean(current)
              : check.ConditionExpression === 'attribute_not_exists(revision_ts)' ? current?.revision_ts !== undefined
                : current?.revision_ts !== (values[':revision'] ?? values[':messageRevision'])) {
              throw Object.assign(new Error('transaction canceled'), { name: 'TransactionCanceledException' });
            }
          }
          if (action.Delete?.ConditionExpression) {
            const deletion = action.Delete;
            const current = index.get(keyOf(deletion.Key));
            if (deletion.ConditionExpression === 'attribute_not_exists(revision_ts)'
              ? current?.revision_ts !== undefined
              : current?.revision_ts !== deletion.ExpressionAttributeValues[':indexRevision']) {
              throw Object.assign(new Error('transaction canceled'), { name: 'TransactionCanceledException' });
            }
          }
        }
        for (const action of command.input.TransactItems) {
          if (action.Put) index.set(keyOf(action.Put.Item), structuredClone(action.Put.Item));
          if (action.Delete) index.delete(keyOf(action.Delete.Key));
        }
        return {};
      }
      if (name === 'UpdateCommand') {
        const current = records.get(keyOf(command.input.Key));
        const values = command.input.ExpressionAttributeValues;
        if (command.input.UpdateExpression.startsWith('REMOVE')) {
          if (!current?.deleted || current.revision_ts !== values[':revision']) {
            throw Object.assign(new Error('condition failed'), { name: 'ConditionalCheckFailedException' });
          }
          delete current.index_tokens;
        } else {
          const condition = command.input.ConditionExpression;
          if (condition === 'attribute_not_exists(revision_ts)' ? current?.revision_ts !== undefined
            : current?.revision_ts !== values[':revision']) {
            throw Object.assign(new Error('condition failed'), { name: 'ConditionalCheckFailedException' });
          }
          current.index_tokens = structuredClone(values[':tokens']);
          if (values[':newRevision'] !== undefined) current.revision_ts = values[':newRevision'];
        }
        return {};
      }
      if (name === 'BatchWriteCommand') {
        for (const request of command.input.RequestItems['index-table'] || []) {
          if (request.DeleteRequest) index.delete(keyOf(request.DeleteRequest.Key));
        }
        return {};
      }
      throw new Error(`unexpected command: ${name}`);
    },
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

test('buildNewIndexEntries skips deleted messages and messages missing required fields or text', () => {
  assert.deepEqual(buildNewIndexEntries(message({ deleted: true })), []);
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
  assert.throws(() => parseArgs(['--limit=0']), /positive integer/);
  assert.throws(() => parseArgs(['--limit=not-a-number']), /positive integer/);
  assert.throws(() => parseArgs(['--team-id=']), /Slack team ID/);
});

test('reindex scans messages, writes workspace-scoped entries, and skips empty messages', async () => {
  const ddb = memoryDdb({ messages: [
    message({ text: 'hello needle' }),
    message({ text: '', ts: '1710000002.000000', sk: 'ts#1710000002.000000' }),
    message({ team_id: 'T_OTHER', channel_id: 'C2', ts: '1710000003.000000', sk: 'ts#1710000003.000000', pk: 'workspace#T_OTHER#channel#C2', text: 'needle other' }),
  ] });
  const result = await reindex({ ddb, messagesTable: 'messages-table', indexTable: 'index-table' });

  assert.equal(result.scanned, 3);
  assert.equal(result.skipped, 1);
  assert.ok(result.written > 0);
  const items = [...ddb.index.values()];
  assert.ok(items.every((item) => item.pk.startsWith('workspace#')));
  assert.ok(items.some((item) => item.pk.startsWith('workspace#T123#token#')));
  assert.ok(items.some((item) => item.pk.startsWith('workspace#T_OTHER#token#')));
});

test('reindex removes stale entries with revision conditions, including tombstones', async () => {
  const deleted = message({
    ts: '1710000002.000000',
    sk: 'ts#1710000002.000000',
    deleted: true,
    text: '',
    index_tokens: ['gone'],
  });
  const staleEntries = [
    {
      pk: 'workspace#T123#token#old',
      sk: 'workspace#T123#channel#C1#ts#1710000001.000000',
      token: 'old', team_id: 'T123', message_pk: message().pk, message_sk: message().sk, revision_ts: Number(message().ts),
    },
    {
      pk: 'workspace#T123#token#gone',
      sk: 'workspace#T123#channel#C1#ts#1710000002.000000',
      token: 'gone', team_id: 'T123', message_pk: deleted.pk, message_sk: deleted.sk, revision_ts: Number(deleted.ts),
    },
  ];
  const ddb = memoryDdb({ messages: [message(), deleted], indexes: staleEntries });
  const result = await reindex({ ddb, messagesTable: 'messages-table', indexTable: 'index-table' });

  assert.equal(result.deleted, 1);
  assert.equal(ddb.index.has(JSON.stringify([staleEntries[0].pk, staleEntries[0].sk])), false);
  assert.equal(ddb.index.has(JSON.stringify([staleEntries[1].pk, staleEntries[1].sk])), false);
  assert.ok(ddb.sent.filter((command) => command.constructor.name === 'ScanCommand')
    .every((command) => command.input.ConsistentRead === true));
  const deleteTransactions = ddb.sent
    .filter((command) => command.constructor.name === 'TransactWriteCommand')
    .filter((command) => command.input.TransactItems.some((action) => action.Delete));
  const deletes = deleteTransactions.flatMap((command) => command.input.TransactItems)
    .filter((action) => action.Delete);
  assert.deepEqual(
    deletes.map((action) => action.Delete.Key).sort((a, b) => a.pk.localeCompare(b.pk)),
    staleEntries.map(({ pk, sk }) => ({ pk, sk })).sort((a, b) => a.pk.localeCompare(b.pk)),
  );
  assert.ok(deleteTransactions.every((command) => command.input.TransactItems.some((action) => action.ConditionCheck)));
  assert.equal(result.cleared, 1);
  assert.equal(ddb.records.get(JSON.stringify([deleted.pk, deleted.sk])).index_tokens, undefined);
});

test('reindex keeps a token made current by an edit during stale cleanup', async () => {
  const current = message({
    text: 'hello old',
    search_tokens: ['hello', 'old'],
    index_tokens: ['hello', 'old'],
    revision_ts: 100,
  });
  const newEntry = {
    pk: 'workspace#T123#token#new',
    sk: 'workspace#T123#channel#C1#ts#1710000001.000000',
    token: 'new',
    team_id: 'T123',
    message_pk: current.pk,
    message_sk: current.sk,
    revision_ts: 100,
  };
  const ddb = memoryDdb({ messages: [current], indexes: [newEntry] });
  const send = ddb.send.bind(ddb);
  let indexScanned = false;
  let edited = false;
  ddb.send = async (command) => {
    const response = await send(command);
    if (command.constructor.name === 'ScanCommand' && command.input.TableName === 'index-table') {
      indexScanned = true;
    }
    if (indexScanned && !edited && command.constructor.name === 'GetCommand'
      && command.input.TableName === 'messages-table') {
      edited = true;
      const record = ddb.records.get(JSON.stringify([current.pk, current.sk]));
      record.text = 'hello new';
      record.search_tokens = ['hello', 'new'];
      record.index_tokens = ['hello', 'old', 'new'];
      record.revision_ts = 101;
      ddb.index.get(JSON.stringify([newEntry.pk, newEntry.sk])).revision_ts = 101;
    }
    return response;
  };

  const result = await reindex({ ddb, messagesTable: 'messages-table', indexTable: 'index-table' });
  const preserved = ddb.index.get(JSON.stringify([newEntry.pk, newEntry.sk]));
  assert.equal(result.deleted, 1);
  assert.equal(preserved.revision_ts, 101);
  assert.equal(edited, true);
});

test('limited reindex leaves unscanned index entries untouched', async () => {
  const stale = { pk: 'workspace#T123#token#stale', sk: 'workspace#T123#channel#C1#ts#old' };
  const sent = [];
  await reindex({
    ddb: {
      send: async (command) => {
        sent.push(command);
        if (command.constructor.name === 'ScanCommand') {
          return {
            Items: command.input.TableName === 'messages-table' ? [message()] : [stale],
            LastEvaluatedKey: null,
          };
        }
        return {};
      },
    },
    messagesTable: 'messages-table',
    indexTable: 'index-table',
    limit: 1,
  });

  assert.equal(sent.flatMap((command) => command.input.RequestItems?.['index-table'] || [])
    .some((request) => request.DeleteRequest), false);
});

test('writeBatches retries unprocessed DynamoDB writes', async () => {
  let calls = 0;
  const entry = { PutRequest: { Item: { pk: 'p', sk: 's' } } };
  const written = await writeBatches({
    ddb: {
      send: async () => {
        calls += 1;
        return calls === 1 ? { UnprocessedItems: { index: [entry] } } : {};
      },
    },
    entries: [entry],
    indexTable: 'index',
    dryRun: false,
    label: 'reindex',
    sleep: async () => {},
  });

  assert.equal(calls, 2);
  assert.equal(written, 1);
});

test('reindex filters to a single team_id when teamId is provided', async () => {
  const ddb = memoryDdb({ messages: [message()] });
  await reindex({ ddb, messagesTable: 'messages-table', indexTable: 'index-table', teamId: 'T123' });
  const scans = ddb.sent.filter((command) => command.constructor.name === 'ScanCommand');
  assert.equal(scans[0].input.FilterExpression, 'team_id = :team');
  assert.deepEqual(scans[0].input.ExpressionAttributeValues, { ':team': 'T123' });
  assert.equal(scans[1].input.FilterExpression, 'begins_with(pk, :prefix) AND contains(pk, :token_marker)');
  assert.deepEqual(scans[1].input.ExpressionAttributeValues, {
    ':prefix': 'workspace#T123#token#',
    ':token_marker': '#token#',
  });
  assert.ok(ddb.sent.some((command) => command.constructor.name === 'TransactWriteCommand'));
});

test('reindex refuses to use the same table for source messages and index entries', async () => {
  await assert.rejects(reindex({
    ddb: { send: async () => { throw new Error('must not scan'); } },
    messagesTable: 'same-table',
    indexTable: 'same-table',
  }), /messages and index tables must be different/);
});

test('reindex dry-run scans messages but does not send BatchWriteCommand', async () => {
  const sent = [];
  const result = await reindex({
    ddb: {
      send: async (command) => {
        sent.push(command);
        if (command.constructor.name === 'ScanCommand') {
          return {
            Items: command.input.TableName === 'messages-table' ? [message()] : [],
            LastEvaluatedKey: null,
          };
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
