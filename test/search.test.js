const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createHandler,
  createWorker,
  formatHitThreadMessage,
  formatSlackMessageText,
  loadMessageContext,
  loadUserNames,
} = require('../src/search/handler');
const { signedSlackEvent } = require('./helpers');

test('search handler invokes the worker and returns immediately', async () => {
  const invocations = [];
  const handler = createHandler({
    getSigningSecret: async () => 'test-secret',
    invokeWorker: async (payload) => {
      invocations.push(payload);
    },
  });

  const body = new URLSearchParams({
    channel_id: 'C123',
    user_id: 'U999',
    response_url: 'https://hooks.slack.test/response',
    text: 'needle',
  }).toString();

  const response = await handler(signedSlackEvent({ body }));

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, '');
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].body.text, 'needle');
});

test('search worker posts a parent message and threaded hit details', async () => {
  process.env.SEARCH_INDEX_TABLE = 'index-table';
  process.env.MESSAGES_TABLE = 'messages-table';

  const slackMessages = [];
  const hit = message({ ts: '1710000005.000000', text: 'needle appears here <@U555>' });
  const worker = createWorker({
    getBotToken: async () => 'xoxb-token',
    ddbSend: async (command) => {
      if (command.constructor.name === 'QueryCommand' && command.input.TableName === 'index-table') {
        return { Items: [{ message_pk: hit.pk, message_sk: hit.sk }] };
      }
      if (command.constructor.name === 'GetCommand') {
        return { Item: hit };
      }
      if (command.constructor.name === 'QueryCommand' && command.input.ExpressionAttributeValues[':sk'] === hit.sk) {
        const operator = command.input.KeyConditionExpression.includes('sk <') ? 'before' : 'after';
        return {
          Items: operator === 'before'
            ? [message({ ts: '1710000004.000000', text: 'before' })]
            : [message({ ts: '1710000006.000000', text: 'after' })],
        };
      }
      throw new Error(`unexpected command: ${command.constructor.name}`);
    },
    slackPost: async ({ message: posted }) => {
      slackMessages.push(posted);
      return { ok: true, ts: slackMessages.length === 1 ? '1710000010.000000' : `1710000010.00000${slackMessages.length}` };
    },
    slackUserInfo: async ({ userId }) => ({
      U123: 'alice',
      U555: 'bob',
      U999: 'requester',
    })[userId],
  });

  const response = await worker({
    body: {
      channel_id: 'C123',
      user_id: 'U999',
      response_url: 'https://hooks.slack.test/response',
      text: 'needle',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, '');
  assert.equal(slackMessages.length, 2);
  assert.equal(slackMessages[0].channel, 'C123');
  assert.match(slackMessages[0].text, /requester の検索/);
  assert.doesNotMatch(slackMessages[0].text, /<@|@requester/);
  assert.equal(slackMessages[1].channel, 'C123');
  assert.equal(slackMessages[1].thread_ts, '1710000010.000000');
  assert.match(slackMessages[1].text, /<#C123>/);
  assert.match(slackMessages[1].text, /alice/);
  assert.match(slackMessages[1].text, /bob/);
  assert.doesNotMatch(slackMessages[1].text, /<@|@alice|@bob/);
  assert.match(slackMessages[1].text, /→ .*needle appears here/);
});

test('search worker reports misses through response_url', async () => {
  process.env.SEARCH_INDEX_TABLE = 'index-table';

  const responses = [];
  const worker = createWorker({
    getBotToken: async () => 'xoxb-token',
    ddbSend: async () => ({ Items: [] }),
    slackPost: async () => {
      throw new Error('misses should not post channel messages');
    },
    responsePost: async (payload) => {
      responses.push(payload);
    },
  });

  const response = await worker({
    body: {
      response_url: 'https://hooks.slack.test/response',
      text: 'missing',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].responseUrl, 'https://hooks.slack.test/response');
  assert.deepEqual(responses[0].body, {
    response_type: 'ephemeral',
    text: '見つかりませんでした: missing',
  });
});

test('loadMessageContext returns five previous messages, hit, and five following messages in order', async () => {
  process.env.MESSAGES_TABLE = 'messages-table';
  const hit = message({ ts: '1710000005.000000', text: 'hit' });
  const before = [0, 1, 2, 3, 4].map((offset) => message({ ts: `171000000${offset}.000000`, text: `before ${offset}` }));
  const after = [6, 7, 8, 9, 10].map((offset) => message({ ts: `17100000${offset.toString().padStart(2, '0')}.000000`, text: `after ${offset}` }));

  const context = await loadMessageContext({
    message: hit,
    ddbSend: async (command) => {
      if (command.input.KeyConditionExpression.includes('sk <')) {
        return { Items: [...before].reverse() };
      }
      return { Items: after };
    },
  });

  assert.deepEqual(context.map((item) => item.text), [
    'before 0',
    'before 1',
    'before 2',
    'before 3',
    'before 4',
    'hit',
    'after 6',
    'after 7',
    'after 8',
    'after 9',
    'after 10',
  ]);
});

test('formatHitThreadMessage includes channel, user, time, and hit marker', () => {
  const hit = message({ ts: '1710000005.000000', text: '<needle> & context' });
  const userNames = new Map([['U123', 'alice']]);
  const text = formatHitThreadMessage({ hit, context: [hit], index: 0, total: 1, userNames });

  assert.match(text, /<#C123>/);
  assert.match(text, /alice/);
  assert.doesNotMatch(text, /<@|@alice/);
  assert.match(text, /<!date\^1710000005/);
  assert.match(text, /→/);
  assert.match(text, /&lt;needle&gt; &amp; context/);
});

test('formatSlackMessageText renders user mentions as plain display names', () => {
  const userNames = new Map([['U123', 'alice'], ['U555', 'bob']]);

  assert.equal(formatSlackMessageText('hi <@U123> and <@U555|bob>', userNames), 'hi alice and bob');
  assert.equal(formatSlackMessageText('hi <@U999>', userNames), 'hi U999');
});

test('loadUserNames resolves senders and mentioned users', async () => {
  const names = await loadUserNames({
    botToken: 'xoxb-token',
    messages: [
      message({ ts: '1710000005.000000', text: 'hello <@U555>' }),
    ],
    slackUserInfo: async ({ userId }) => ({
      U123: '@alice',
      U555: 'bob',
    })[userId],
  });

  assert.equal(names.get('U123'), 'alice');
  assert.equal(names.get('U555'), 'bob');
});

function message({ ts, text }) {
  return {
    pk: 'workspace#T123#channel#C123',
    sk: `ts#${ts}`,
    team_id: 'T123',
    channel_id: 'C123',
    user_id: 'U123',
    ts,
    text,
    normalized_text: text.toLowerCase(),
  };
}
