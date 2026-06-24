const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createHandler,
  createWorker,
  formatHitThreadMessage,
  formatSlackMessageText,
  isArchiverGeneratedMessage,
  loadMessageContext,
  loadUserNames,
  searchMessages,
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

test('search skips bot messages and continues to human results', async () => {
  process.env.SEARCH_INDEX_TABLE = 'index-table';
  process.env.MESSAGES_TABLE = 'messages-table';

  const botHit = message({ ts: '1710000005.000000', text: 'needle from bot' });
  botHit.subtype = 'bot_message';
  botHit.bot_id = 'B123';
  const humanHit = message({ ts: '1710000006.000000', text: 'needle from human' });
  const messages = new Map([
    [botHit.sk, botHit],
    [humanHit.sk, humanHit],
  ]);

  const results = await searchMessages({
    query: 'needle',
    ddbSend: async (command) => {
      if (command.constructor.name === 'QueryCommand') {
        return {
          Items: [
            { message_pk: botHit.pk, message_sk: botHit.sk },
            { message_pk: humanHit.pk, message_sk: humanHit.sk },
          ],
        };
      }
      if (command.constructor.name === 'GetCommand') {
        return { Item: messages.get(command.input.Key.sk) };
      }
      throw new Error(`unexpected command: ${command.constructor.name}`);
    },
  });

  assert.deepEqual(results.map((item) => item.text), ['needle from human']);
});

test('search skips previously archived search result messages', async () => {
  process.env.SEARCH_INDEX_TABLE = 'index-table';
  process.env.MESSAGES_TABLE = 'messages-table';

  const generatedParent = message({ ts: '1710000005.000000', text: 'alice の検索: `needle` (3件)' });
  const generatedThread = message({ ts: '1710000006.000000', text: '*1/3* <#C123> <!date^1710000005^{date_short_pretty} {time}|1710000005.000000> alice\n→ <!date^1710000005^{date_short_pretty} {time}|1710000005.000000> alice: needle' });
  const humanHit = message({ ts: '1710000007.000000', text: 'needle from human' });
  const messages = new Map([
    [generatedParent.sk, generatedParent],
    [generatedThread.sk, generatedThread],
    [humanHit.sk, humanHit],
  ]);

  const results = await searchMessages({
    query: 'needle',
    ddbSend: async (command) => {
      if (command.constructor.name === 'QueryCommand') {
        return {
          Items: [
            { message_pk: generatedParent.pk, message_sk: generatedParent.sk },
            { message_pk: generatedThread.pk, message_sk: generatedThread.sk },
            { message_pk: humanHit.pk, message_sk: humanHit.sk },
          ],
        };
      }
      if (command.constructor.name === 'GetCommand') {
        return { Item: messages.get(command.input.Key.sk) };
      }
      throw new Error(`unexpected command: ${command.constructor.name}`);
    },
  });

  assert.deepEqual(results.map((item) => item.text), ['needle from human']);
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

test('loadMessageContext excludes generated search messages from surrounding context', async () => {
  process.env.MESSAGES_TABLE = 'messages-table';
  const hit = message({ ts: '1710000005.000000', text: 'needle' });
  const generated = message({ ts: '1710000004.000000', text: 'alice の検索: `needle` (1件)' });
  const human = message({ ts: '1710000006.000000', text: 'human context' });

  const context = await loadMessageContext({
    message: hit,
    ddbSend: async (command) => {
      if (command.input.KeyConditionExpression.includes('sk <')) return { Items: [generated] };
      return { Items: [human] };
    },
  });

  assert.deepEqual(context.map((item) => item.text), ['needle', 'human context']);
});

test('loadMessageContext excludes thread replies from top-level timeline context', async () => {
  process.env.MESSAGES_TABLE = 'messages-table';
  const hit = message({ ts: '1710000005.000000', text: 'top-level hit' });
  const threadReply = message({ ts: '1710000004.000000', thread_ts: '1710000001.000000', text: 'reply in another thread' });
  const topLevelBefore = message({ ts: '1710000003.000000', text: 'top-level before' });
  const topLevelAfter = message({ ts: '1710000006.000000', text: 'top-level after' });

  const context = await loadMessageContext({
    message: hit,
    ddbSend: async (command) => {
      if (command.input.KeyConditionExpression.includes('sk <')) return { Items: [threadReply, topLevelBefore] };
      return { Items: [topLevelAfter] };
    },
  });

  assert.deepEqual(context.map((item) => item.text), ['top-level before', 'top-level hit', 'top-level after']);
});

test('loadMessageContext keeps only the same thread for threaded hits', async () => {
  process.env.MESSAGES_TABLE = 'messages-table';
  const threadTs = '1710000001.000000';
  const root = message({ ts: threadTs, text: 'thread root' });
  const unrelatedTopLevel = message({ ts: '1710000003.000000', text: 'unrelated top-level' });
  const previousReply = message({ ts: '1710000004.000000', thread_ts: threadTs, text: 'previous reply' });
  const hit = message({ ts: '1710000005.000000', thread_ts: threadTs, text: 'threaded hit' });
  const nextReply = message({ ts: '1710000006.000000', thread_ts: threadTs, text: 'next reply' });
  const unrelatedReply = message({ ts: '1710000007.000000', thread_ts: '1710000002.000000', text: 'other thread reply' });

  const context = await loadMessageContext({
    message: hit,
    ddbSend: async (command) => {
      if (command.input.KeyConditionExpression.includes('sk <')) return { Items: [previousReply, unrelatedTopLevel, root] };
      return { Items: [nextReply, unrelatedReply] };
    },
  });

  assert.deepEqual(context.map((item) => item.text), ['thread root', 'previous reply', 'threaded hit', 'next reply']);
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

test('formatSlackMessageText renders Slack links and dates as readable text', () => {
  const text = formatSlackMessageText(
    'see <https://example.com/path?a=1&amp;b=2|example link> at <!date^1710000005^{date_short_pretty} {time}|2024-03-09 16:00> in <#C123|general>',
  );

  assert.equal(text, 'see example link (https://example.com/path?a=1&amp;b=2) at 2024-03-09 16:00 in #general');
});

test('formatSlackMessageText renders standard emoji shortnames', () => {
  assert.equal(
    formatSlackMessageText('q92#fa^hfyK@yG0 :heavy_plus_sign: :herb: :custom_unknown:'),
    'q92#fa^hfyK@yG0 \u2795 \u{1F33F} :custom_unknown:',
  );
});

test('isArchiverGeneratedMessage detects parent and threaded result posts', () => {
  assert.equal(isArchiverGeneratedMessage('alice の検索: `needle` (3件)'), true);
  assert.equal(isArchiverGeneratedMessage('*1/3* <#C123> <!date^1710000005^{date_short_pretty} {time}|1710000005.000000> alice'), true);
  assert.equal(isArchiverGeneratedMessage('ordinary message with needle'), false);
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

function message({ ts, text, thread_ts = null }) {
  return {
    pk: 'workspace#T123#channel#C123',
    sk: `ts#${ts}`,
    team_id: 'T123',
    channel_id: 'C123',
    user_id: 'U123',
    ts,
    thread_ts,
    text,
    normalized_text: text.toLowerCase(),
  };
}
