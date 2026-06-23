const assert = require('node:assert/strict');
const test = require('node:test');
const { createHandler } = require('../src/ingest/handler');
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
