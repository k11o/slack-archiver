const assert = require('node:assert/strict');
const test = require('node:test');
const { createHandler, isIgnoredMessageEvent } = require('../src/ingest/handler');
const { signedSlackEvent } = require('./helpers');

const TABLES = {
  messages: 'messages-table',
  index: 'index-table',
};

function memoryDdb({ messages = [] } = {}) {
  const records = new Map(messages.map((item) => [keyOf(item), structuredClone(item)]));
  const indexes = new Map();
  return {
    records,
    indexes,
    async send(command) {
      const { constructor: { name } } = command;
      if (name === 'GetCommand') {
        return { Item: structuredClone(records.get(keyOf(command.input.Key))) };
      }
      if (name === 'PutCommand') {
        const current = records.get(keyOf(command.input.Item));
        if (command.input.ConditionExpression === 'attribute_not_exists(pk)' && current) {
          throw conditionalFailure();
        }
        if (command.input.ConditionExpression === 'attribute_not_exists(revision_ts)' && current?.revision_ts !== undefined) {
          throw conditionalFailure();
        }
        if (command.input.ConditionExpression === 'revision_ts = :existingRevision'
          && current?.revision_ts !== command.input.ExpressionAttributeValues[':existingRevision']) {
          throw conditionalFailure();
        }
        records.set(keyOf(command.input.Item), structuredClone(command.input.Item));
        return {};
      }
      if (name === 'TransactWriteCommand') {
        for (const action of command.input.TransactItems) {
          if (action.ConditionCheck) {
            const current = records.get(keyOf(action.ConditionCheck.Key));
            if (current?.revision_ts !== action.ConditionCheck.ExpressionAttributeValues[':revision']) {
              throw Object.assign(new Error('transaction canceled'), { name: 'TransactionCanceledException' });
            }
          }
        }
        for (const action of command.input.TransactItems) {
          if (action.Put) indexes.set(keyOf(action.Put.Item), structuredClone(action.Put.Item));
          if (action.Delete) indexes.delete(keyOf(action.Delete.Key));
        }
        return {};
      }
      if (name === 'UpdateCommand') {
        const current = records.get(keyOf(command.input.Key));
        const expectedRevision = command.input.ExpressionAttributeValues[':revision'];
        if (current?.revision_ts !== expectedRevision) throw conditionalFailure();
        current.index_tokens = structuredClone(command.input.ExpressionAttributeValues[':tokens']);
        return {};
      }
      throw new Error(`unexpected command: ${name}`);
    },
  };
}

function makeHandler(ddb) {
  process.env.MESSAGES_TABLE = TABLES.messages;
  process.env.SEARCH_INDEX_TABLE = TABLES.index;
  return createHandler({
    getSigningSecret: async () => 'test-secret',
    ddbSend: (command) => ddb.send(command),
  });
}

function event(body) {
  return signedSlackEvent({ body: { team_id: 'T123', ...body } });
}

function keyOf({ pk, sk }) {
  return `${pk}\0${sk}`;
}

function indexKey(teamId, token, channelId = 'C123', ts = '1710000001.000000') {
  return keyOf({
    pk: `workspace#${teamId}#token#${token}`,
    sk: `workspace#${teamId}#channel#${channelId}#ts#${ts}`,
  });
}

function conditionalFailure() {
  return Object.assign(new Error('conditional check failed'), { name: 'ConditionalCheckFailedException' });
}

test('ingest handler responds to Slack URL verification challenge', async () => {
  const handler = createHandler({
    getSigningSecret: async () => 'test-secret',
    ddbSend: async () => {
      throw new Error('URL verification should not touch DynamoDB');
    },
  });

  const response = await handler(signedSlackEvent({
    body: {
      type: 'url_verification',
      challenge: 'challenge-token',
    },
  }));

  assert.deepEqual(response, {
    statusCode: 200,
    headers: { 'content-type': 'text/plain' },
    body: 'challenge-token',
  });
});

test('ingest ignores bot, app-generated, non-public, and unsupported message events', async () => {
  assert.equal(isIgnoredMessageEvent({ subtype: 'bot_message' }), true);
  assert.equal(isIgnoredMessageEvent({ bot_id: 'B123' }), true);
  assert.equal(isIgnoredMessageEvent({ app_id: 'A123' }), true);
  assert.equal(isIgnoredMessageEvent({ bot_profile: { id: 'B123' } }), true);
  assert.equal(isIgnoredMessageEvent({ user: 'U123', text: 'human message' }), false);

  const handler = makeHandler(memoryDdb());
  const response = await handler(event({
    event: { type: 'message', channel: 'G123', user: 'U123', ts: '1710000001.000000', text: 'private' },
  }));
  assert.equal(response.body, 'ignored');
  const privateCId = await handler(event({
    event: {
      type: 'message', channel: 'CPRIVATE', channel_type: 'group', user: 'U123',
      ts: '1710000002.000000', text: 'still private',
    },
  }));
  assert.equal(privateCId.body, 'ignored');
  const privateGroup = await handler(event({
    event: { type: 'message', channel: 'GPRIVATE', channel_type: 'group', user: 'U123', ts: '1710000003.000000', text: 'private' },
  }));
  assert.equal(privateGroup.body, 'ignored');
});

test('ingest accepts a converted public channel with a legacy G ID', async () => {
  const ddb = memoryDdb();
  const handler = makeHandler(ddb);
  const response = await handler(event({
    event: { type: 'message', channel: 'G123', channel_type: 'channel', user: 'U123', ts: '1710000001.000000', text: 'public legacy channel' },
  }));

  assert.equal(response.body, 'ok');
  assert.equal([...ddb.records.values()][0].text, 'public legacy channel');
});

test('ingest stores workspace-scoped messages and token index entries', async () => {
  const ddb = memoryDdb();
  const handler = makeHandler(ddb);

  const response = await handler(event({
    event_id: 'Ev123',
    event: {
      type: 'message',
      channel: 'C123',
      user: 'U123',
      ts: '1710000001.000000',
      text: 'hello needle',
    },
  }));

  assert.equal(response.statusCode, 200);
  const item = ddb.records.get('workspace#T123#channel#C123\0ts#1710000001.000000');
  assert.equal(item.team_id, 'T123');
  assert.equal(item.text, 'hello needle');
  assert.ok(item.search_tokens.includes('needle'));
  assert.ok(ddb.indexes.has(indexKey('T123', 'needle')));
});

test('message_changed updates the inner message timestamp and replaces old tokens', async () => {
  const ddb = memoryDdb();
  const handler = makeHandler(ddb);
  await handler(event({
    event: { type: 'message', channel: 'C123', user: 'U123', ts: '1710000001.000000', text: 'old phrase' },
  }));

  await handler(event({
    event: {
      type: 'message',
      subtype: 'message_changed',
      channel: 'C123',
      ts: '1710000005.000000',
      message: {
        type: 'message',
        user: 'U123',
        ts: '1710000001.000000',
        text: 'new phrase',
        edited: { ts: '1710000004.000000', user: 'U123' },
      },
    },
  }));

  const item = ddb.records.get('workspace#T123#channel#C123\0ts#1710000001.000000');
  assert.equal(item.text, 'new phrase');
  assert.equal(item.revision_ts, 1710000004);
  assert.equal(ddb.indexes.has(indexKey('T123', 'old')), false);
  assert.equal(ddb.indexes.has(indexKey('T123', 'new')), true);
});

test('message_changed removes legacy index tokens that exceed the current token limit', async () => {
  const oldToken = 'a'.repeat(1025);
  const legacy = {
    pk: 'workspace#T123#channel#C123',
    sk: 'ts#1710000001.000000',
    team_id: 'T123',
    channel_id: 'C123',
    user_id: 'U123',
    ts: '1710000001.000000',
    text: oldToken,
  };
  const ddb = memoryDdb({ messages: [legacy] });
  ddb.indexes.set(indexKey('T123', oldToken), { pk: `workspace#T123#token#${oldToken}` });
  const handler = makeHandler(ddb);

  await handler(event({
    event: {
      type: 'message',
      subtype: 'message_changed',
      channel: 'C123',
      ts: '1710000004.000000',
      message: {
        type: 'message', user: 'U123', ts: legacy.ts, text: 'replacement',
        edited: { ts: '1710000004.000000', user: 'U123' },
      },
    },
  }));

  assert.equal(ddb.indexes.has(indexKey('T123', oldToken)), false);
  assert.equal(ddb.indexes.has(indexKey('T123', 'replacement')), true);
});

test('message_changed skips impossible legacy index keys', async () => {
  const legacy = {
    pk: 'workspace#T123#channel#C123',
    sk: 'ts#1710000001.000000',
    team_id: 'T123',
    channel_id: 'C123',
    user_id: 'U123',
    ts: '1710000001.000000',
    text: 'a'.repeat(2050),
  };
  const ddb = memoryDdb({ messages: [legacy] });
  const handler = makeHandler(ddb);

  await handler(event({
    event: {
      type: 'message',
      subtype: 'message_changed',
      channel: 'C123',
      ts: '1710000004.000000',
      message: {
        type: 'message', user: 'U123', ts: legacy.ts, text: 'replacement',
        edited: { ts: '1710000004.000000', user: 'U123' },
      },
    },
  }));

  assert.equal(ddb.indexes.has(indexKey('T123', 'replacement')), true);
});

test('concurrent newer edits reread the changed record before replacing its index tokens', async () => {
  const ddb = memoryDdb();
  const baseHandler = makeHandler(ddb);
  const original = { type: 'message', channel: 'C123', user: 'U123', ts: '1710000001.000000', text: 'base token' };
  await baseHandler(event({ event: original }));
  let interleaved = false;
  const handler = makeHandler({
    ...ddb,
    send: async (command) => {
      if (command.constructor.name === 'PutCommand' && !interleaved) {
        interleaved = true;
        const key = keyOf({ pk: 'workspace#T123#channel#C123', sk: 'ts#1710000001.000000' });
        const current = ddb.records.get(key);
        const changed = {
          ...current,
          text: 'intermediate token',
          normalized_text: 'intermediate token',
          search_tokens: ['intermediate', 'token'],
          index_tokens: ['base', 'token', 'intermediate'],
          revision_ts: 1710000002,
        };
        ddb.records.set(key, changed);
        ddb.indexes.set(indexKey('T123', 'intermediate'), { pk: 'workspace#T123#token#intermediate' });
      }
      return ddb.send(command);
    },
  });

  await handler(event({
    event: {
      type: 'message',
      subtype: 'message_changed',
      channel: 'C123',
      ts: '1710000003.000000',
      message: {
        type: 'message', user: 'U123', ts: original.ts, text: 'final phrase',
        edited: { ts: '1710000003.000000', user: 'U123' },
      },
    },
  }));

  const final = ddb.records.get(keyOf({ pk: 'workspace#T123#channel#C123', sk: 'ts#1710000001.000000' }));
  assert.equal(final.text, 'final phrase');
  assert.equal(ddb.indexes.has(indexKey('T123', 'intermediate')), false);
  assert.equal(ddb.indexes.has(indexKey('T123', 'final')), true);
});

test('message_deleted clears content, removes index entries, and blocks stale replay', async () => {
  const ddb = memoryDdb();
  const handler = makeHandler(ddb);
  const original = {
    type: 'message',
    channel: 'C123',
    user: 'U123',
    ts: '1710000001.000000',
    text: 'secret needle',
  };
  await handler(event({ event: original }));

  await handler(event({
    event: {
      type: 'message',
      subtype: 'message_deleted',
      channel: 'C123',
      ts: '1710000004.000000',
      deleted_ts: '1710000001.000000',
      previous_message: original,
    },
  }));

  const item = ddb.records.get('workspace#T123#channel#C123\0ts#1710000001.000000');
  assert.equal(item.deleted, true);
  assert.equal(item.text, '');
  assert.equal(item.normalized_text, '');
  assert.equal(item.subtype, 'message_deleted');
  assert.equal(item.bot_id, null);
  assert.deepEqual(item.search_tokens, []);
  assert.equal(ddb.indexes.has(indexKey('T123', 'secret')), false);

  await handler(event({ event: original }));
  assert.equal(ddb.records.get(keyOf(item)).deleted, true);
  assert.equal(ddb.records.get(keyOf(item)).text, '');
});

test('message_changed tombstones are handled as deletions', async () => {
  const ddb = memoryDdb();
  const handler = makeHandler(ddb);
  const original = {
    type: 'message', channel: 'C123', user: 'U123',
    ts: '1710000001.000000', text: 'tombstone secret',
  };
  await handler(event({ event: original }));
  await handler(event({
    event: {
      type: 'message',
      subtype: 'message_changed',
      channel: 'C123',
      ts: '1710000005.000000',
      previous_message: original,
      message: {
        subtype: 'tombstone',
        ts: original.ts,
        edited: { ts: '1710000005.000000' },
      },
    },
  }));

  const tombstone = ddb.records.get(keyOf({
    pk: 'workspace#T123#channel#C123',
    sk: `ts#${original.ts}`,
  }));
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.text, '');
  assert.equal(ddb.indexes.has(indexKey('T123', 'tombstone')), false);
  assert.equal(ddb.indexes.has(indexKey('T123', 'secret')), false);
});

test('tombstone revision prefers Slack event timestamp over event_time', async () => {
  const ddb = memoryDdb();
  const handler = makeHandler(ddb);
  const original = { type: 'message', channel: 'C123', user: 'U123', ts: '1710000001.000000', text: 'before deletion' };
  await handler(event({ event: original }));
  await handler(event({
    event_time: 1710000009,
    event: {
      type: 'message',
      subtype: 'message_changed',
      channel: 'C123',
      ts: '1710000005.000000',
      previous_message: original,
      message: { subtype: 'tombstone', ts: original.ts },
    },
  }));

  assert.equal(ddb.records.get(keyOf({
    pk: 'workspace#T123#channel#C123',
    sk: `ts#${original.ts}`,
  })).revision_ts, 1710000005);
});

test('a deletion arriving before the original post leaves a tombstone', async () => {
  const ddb = memoryDdb();
  const handler = makeHandler(ddb);
  await handler(event({
    event: {
      type: 'message',
      subtype: 'message_deleted',
      channel: 'C123',
      ts: '1710000004.000000',
      deleted_ts: '1710000001.000000',
    },
  }));
  await handler(event({
    event: { type: 'message', channel: 'C123', user: 'U123', ts: '1710000001.000000', text: 'late original' },
  }));

  const item = ddb.records.get('workspace#T123#channel#C123\0ts#1710000001.000000');
  assert.equal(item.deleted, true);
  assert.equal(item.text, '');
  assert.equal(ddb.indexes.size, 0);
});

test('replayed message event repairs a failed index sync without restoring old state', async () => {
  const ddb = memoryDdb();
  const handler = makeHandler({
    ...ddb,
    send: async (command) => {
      if (command.constructor.name === 'TransactWriteCommand' && !ddb.failedOnce) {
        ddb.failedOnce = true;
        throw Object.assign(new Error('temporary index failure'), { name: 'ProvisionedThroughputExceededException' });
      }
      return ddb.send(command);
    },
  });
  const message = { type: 'message', channel: 'C123', user: 'U123', ts: '1710000001.000000', text: 'retry needle' };
  const request = event({ event: message });

  await assert.rejects(handler(request), /temporary index failure/);
  assert.equal(ddb.indexes.size, 0);
  await handler(request);
  assert.equal(ddb.indexes.has(indexKey('T123', 'needle')), true);
});
