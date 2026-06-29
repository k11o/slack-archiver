const assert = require('node:assert/strict');
const test = require('node:test');
const { createHandler, isIgnoredMessageEvent } = require('../src/ingest/handler');
const { signedSlackEvent } = require('./helpers');

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

test('ingest ignores bot and app-generated message events', () => {
  assert.equal(isIgnoredMessageEvent({ subtype: 'bot_message' }), true);
  assert.equal(isIgnoredMessageEvent({ bot_id: 'B123' }), true);
  assert.equal(isIgnoredMessageEvent({ app_id: 'A123' }), true);
  assert.equal(isIgnoredMessageEvent({ bot_profile: { id: 'B123' } }), true);
  assert.equal(isIgnoredMessageEvent({ user: 'U123', text: 'human message' }), false);
});

test('ingest stores message and search index entries scoped by Slack workspace', async () => {
  process.env.MESSAGES_TABLE = 'messages-table';
  process.env.SEARCH_INDEX_TABLE = 'index-table';

  const commands = [];
  const handler = createHandler({
    getSigningSecret: async () => 'test-secret',
    ddbSend: async (command) => {
      commands.push(command);
      return {};
    },
  });

  const response = await handler(signedSlackEvent({
    body: {
      team_id: 'T123',
      event_id: 'Ev123',
      event: {
        type: 'message',
        channel: 'C123',
        user: 'U123',
        ts: '1710000001.000000',
        text: 'hello needle',
      },
    },
  }));

  assert.equal(response.statusCode, 200);
  const put = commands.find((command) => command.constructor.name === 'PutCommand');
  const batch = commands.find((command) => command.constructor.name === 'BatchWriteCommand');
  assert.equal(put.input.Item.pk, 'workspace#T123#channel#C123');
  assert.equal(put.input.Item.team_id, 'T123');
  const indexItems = batch.input.RequestItems['index-table'].map((request) => request.PutRequest.Item);
  assert.ok(indexItems.some((item) => item.pk === 'workspace#T123#token#needle'));
  assert.ok(indexItems.every((item) => item.team_id === 'T123'));
});
