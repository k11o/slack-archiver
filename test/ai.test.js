const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createAiApiHandler,
  archiveUrl,
  parseJsonBody,
} = require('../src/ai/handler');
const {
  searchArchivedMessages,
  getArchivedMessage,
  getArchivedThread,
} = require('../src/ai/service');

const TEAM_ID = 'T123';
const CHANNEL_ID = 'C123';
const TS = '1710000001.000000';

function message(overrides = {}) {
  return {
    pk: `workspace#${TEAM_ID}#channel#${CHANNEL_ID}`,
    sk: `ts#${TS}`,
    message_id: `${TEAM_ID}:${CHANNEL_ID}:${TS}`,
    team_id: TEAM_ID,
    channel_id: CHANNEL_ID,
    channel_name: 'general',
    user_id: 'U123',
    ts: TS,
    thread_ts: null,
    text: 'hello needle world',
    normalized_text: 'hello needle world',
    search_tokens: ['hello', 'needle', 'world'],
    ...overrides,
  };
}

function indexEntry(token, ts = TS) {
  return {
    pk: `workspace#${TEAM_ID}#token#${token}`,
    sk: `workspace#${TEAM_ID}#channel#${CHANNEL_ID}#ts#${ts}`,
    team_id: TEAM_ID,
    message_pk: `workspace#${TEAM_ID}#channel#${CHANNEL_ID}`,
    message_sk: `ts#${ts}`,
  };
}

test('searchArchivedMessages returns filtered results and a workspace-bound continuation cursor', async () => {
  process.env.SEARCH_INDEX_TABLE = 'index-table';
  process.env.MESSAGES_TABLE = 'messages-table';
  const first = message({ ts: '1710000002.000000', sk: 'ts#1710000002.000000', text: 'needle and slack', normalized_text: 'needle and slack', search_tokens: ['needle', 'and', 'slack'] });
  const second = message({ ts: '1710000001.000000', text: 'needle from another team' });
  const calls = [];
  const result = await searchArchivedMessages({
    query: 'needle slack',
    mode: 'and',
    teamId: TEAM_ID,
    limit: 2,
    cursorSecret: 'test-cursor-secret',
    ddbSend: async (command) => {
      calls.push(command);
      if (command.constructor.name === 'QueryCommand') {
        assert.equal(command.input.ExpressionAttributeValues[':pk'], 'workspace#T123#token#needle');
        return {
          Items: [indexEntry('needle', first.ts), indexEntry('needle', second.ts)],
          LastEvaluatedKey: {
            pk: 'workspace#T123#token#needle',
            sk: 'workspace#T123#channel#CPRIVATE#ts#1710000003.000000',
          },
        };
      }
      return { Item: command.input.Key.sk === first.sk ? first : { ...second, team_id: 'T_OTHER' } };
    },
  });

  assert.deepEqual(result.messages.map((item) => item.ts), [first.ts]);
  assert.ok(result.next_cursor);
  assert.doesNotMatch(Buffer.from(result.next_cursor, 'base64url').toString('utf8'), /CPRIVATE/);
  assert.equal(calls.filter((command) => command.constructor.name === 'GetCommand').length, 2);
});

test('searchArchivedMessages resumes only the same query and team', async () => {
  process.env.SEARCH_INDEX_TABLE = 'index-table';
  process.env.MESSAGES_TABLE = 'messages-table';
  const cursorSecret = 'test-cursor-secret';
  const firstPage = await searchArchivedMessages({
    query: 'needle',
    teamId: TEAM_ID,
    cursorSecret,
    ddbSend: async () => ({ Items: [], LastEvaluatedKey: { pk: 'workspace#T123#token#needle', sk: 'previous' } }),
  });
  const cursor = firstPage.next_cursor;
  let query;
  const page = await searchArchivedMessages({
    query: 'needle',
    teamId: TEAM_ID,
    cursor,
    cursorSecret,
    ddbSend: async (command) => {
      if (command.constructor.name === 'QueryCommand') {
        query = command.input;
        return { Items: [], LastEvaluatedKey: null };
      }
      throw new Error('no message lookups expected');
    },
  });

  assert.deepEqual(query.ExclusiveStartKey, { pk: 'workspace#T123#token#needle', sk: 'previous' });
  assert.equal(page.next_cursor, null);
  await assert.rejects(
    searchArchivedMessages({
      query: 'other',
      teamId: TEAM_ID,
      cursor,
      cursorSecret,
      ddbSend: async () => ({}),
    }),
    { code: 'invalid_cursor' },
  );
  await assert.rejects(
    searchArchivedMessages({
      query: 'needle',
      teamId: TEAM_ID,
      cursor: Buffer.from('null').toString('base64url'),
      cursorSecret,
      ddbSend: async () => { throw new Error('invalid cursors must not query'); },
    }),
    { code: 'invalid_cursor' },
  );
});

test('getArchivedMessage rejects non-channel IDs and hides deleted records', async () => {
  process.env.MESSAGES_TABLE = 'messages-table';
  let calls = 0;
  const ddbSend = async () => {
    calls += 1;
    return { Item: message({ deleted: true, text: '' }) };
  };

  assert.equal(await getArchivedMessage({ teamId: TEAM_ID, channelId: 'D123', ts: TS, ddbSend }), null);
  assert.equal(await getArchivedMessage({ teamId: TEAM_ID, channelId: CHANNEL_ID, ts: TS, ddbSend }), null);
  assert.equal(calls, 1);
});

test('archive service accepts legacy G-prefixed IDs for public channels', async () => {
  process.env.MESSAGES_TABLE = 'messages-table';
  const publicChannelMessage = message({
    pk: `workspace#${TEAM_ID}#channel#G123`,
    channel_id: 'G123',
  });
  const result = await getArchivedMessage({
    teamId: TEAM_ID,
    channelId: 'G123',
    ts: TS,
    ddbSend: async () => ({ Item: publicChannelMessage }),
  });

  assert.equal(result, publicChannelMessage);
});

test('getArchivedThread returns public replies with a continuation cursor', async () => {
  process.env.MESSAGES_TABLE = 'messages-table';
  const root = message();
  const reply = message({
    ts: '1710000002.000000',
    sk: 'ts#1710000002.000000',
    thread_ts: TS,
    text: 'first reply',
  });
  const calls = [];
  const result = await getArchivedThread({
    teamId: TEAM_ID,
    channelId: CHANNEL_ID,
    rootTs: TS,
    limit: 1,
    cursorSecret: 'test-cursor-secret',
    ddbSend: async (command) => {
      calls.push(command);
      if (command.constructor.name === 'GetCommand') return { Item: root };
      return {
        Items: [reply, message({ ts: '1710000003.000000', thread_ts: 'other-thread' })],
        LastEvaluatedKey: { pk: root.pk, sk: 'ts#1710000003.000000' },
      };
    },
  });

  assert.equal(result.root, root);
  assert.deepEqual(result.replies, [reply]);
  assert.ok(result.next_cursor);
  assert.equal(calls[1].input.Limit, 1);
  assert.equal(calls[1].input.ExpressionAttributeValues[':root_key'], `ts#${TS}`);
  assert.equal(calls[1].input.ExpressionAttributeValues[':root_ts'], TS);
  assert.equal(calls[1].input.ConsistentRead, true);
});

test('getArchivedThread returns replies when its root was deleted', async () => {
  process.env.MESSAGES_TABLE = 'messages-table';
  const reply = message({ ts: '1710000002.000000', sk: 'ts#1710000002.000000', thread_ts: TS });
  const result = await getArchivedThread({
    teamId: TEAM_ID,
    channelId: CHANNEL_ID,
    rootTs: TS,
    cursorSecret: 'test-cursor-secret',
    ddbSend: async (command) => command.constructor.name === 'GetCommand'
      ? {}
      : { Items: [reply], LastEvaluatedKey: null },
  });

  assert.equal(result.root, null);
  assert.deepEqual(result.replies, [reply]);
});

test('AI thread API returns replies when the archived root is deleted', async () => {
  const reply = message({ ts: '1710000002.000000', thread_ts: TS, text: 'reply remains' });
  const handler = createAiApiHandler({
    verifyAuth: async () => ({ 'https://slack.com/team_id': TEAM_ID }),
    getThread: async () => ({ root: null, replies: [reply], next_cursor: null }),
    loadBotToken: async () => 'bot-token',
    listChannels: async () => [{ id: CHANNEL_ID, name: 'general' }],
    loadNames: async () => new Map(),
    webBaseUrl: 'https://archive.example',
  });
  const response = await handler(apiEvent({
    method: 'GET',
    path: `/api/ai/threads/${CHANNEL_ID}/${TS}`,
    pathParameters: { channelId: CHANNEL_ID, rootTs: TS },
  }));

  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).root, null);
  assert.equal(JSON.parse(response.body).replies[0].text, 'reply remains');
});

test('AI search API uses the verified workspace and returns authenticated archive links', async () => {
  const hit = message();
  const handler = createAiApiHandler({
    verifyAuth: async () => ({ 'https://slack.com/team_id': 'T_LOGIN' }),
    ddbSend: async () => ({}),
    loadBotToken: async ({ teamId }) => {
      assert.equal(teamId, 'T_LOGIN');
      return 'bot-token';
    },
    listChannels: async () => [{ id: CHANNEL_ID, name: 'general' }],
    loadNames: async () => new Map([['U123', 'alice']]),
    search: async (input) => {
      assert.equal(input.teamId, 'T_LOGIN');
      assert.equal(input.query, 'needle');
      return { messages: [hit], next_cursor: 'next' };
    },
    webBaseUrl: 'https://archive.example',
  });
  const response = await handler(apiEvent({
    method: 'POST',
    path: '/api/ai/search',
    body: { query: 'needle', team_id: 'T_OTHER' },
  }));
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.results[0].team_id, 'T_LOGIN');
  assert.equal(body.results[0].user_name, 'alice');
  assert.equal(body.results[0].archive_url, `https://archive.example/web?channel_id=${CHANNEL_ID}&ts=${TS}`);
  assert.equal(body.next_cursor, 'next');
});

test('AI API bounds the serialized Lambda response envelope', async () => {
  const text = '"'.repeat(2 * 1024 * 1024);
  const handler = createAiApiHandler({
    verifyAuth: async () => ({ 'https://slack.com/team_id': TEAM_ID }),
    search: async () => ({
      messages: [message({ text }), message({ ...message(), ts: '1710000002.000000', text })],
      next_cursor: null,
    }),
    loadBotToken: async () => 'bot-token',
    listChannels: async () => [{ id: CHANNEL_ID, name: 'general' }],
    loadNames: async () => new Map(),
    webBaseUrl: 'https://archive.example',
  });
  const response = await handler(apiEvent({ method: 'POST', path: '/api/ai/search', body: { query: 'hello' } }));

  assert.equal(response.statusCode, 413);
  assert.deepEqual(JSON.parse(response.body), { error: 'response_too_large' });
});

test('AI API omits archived channels that Slack no longer reports as public', async () => {
  const privateMessage = message({ channel_id: 'C_PRIVATE' });
  const handler = createAiApiHandler({
    verifyAuth: async () => ({ 'https://slack.com/team_id': TEAM_ID }),
    loadBotToken: async () => 'bot-token',
    listChannels: async () => [{ id: CHANNEL_ID, name: 'general' }],
    search: async () => ({ messages: [privateMessage], next_cursor: null }),
    webBaseUrl: 'https://archive.example',
  });
  const response = await handler(apiEvent({ method: 'POST', path: '/api/ai/search', body: { query: 'needle' } }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body).results, []);
});

test('AI API falls back to IDs when Slack display-name lookup is unavailable', async () => {
  const handler = createAiApiHandler({
    verifyAuth: async () => ({ 'https://slack.com/team_id': TEAM_ID }),
    search: async () => ({ messages: [message({ channel_name: null })], next_cursor: null }),
    loadBotToken: async () => 'bot-token',
    listChannels: async () => [{ id: CHANNEL_ID, name: 'general' }],
    loadNames: async () => { throw new Error('Slack user lookup unavailable'); },
    webBaseUrl: 'https://archive.example',
  });
  const response = await handler(apiEvent({ method: 'POST', path: '/api/ai/search', body: { query: 'needle' } }));
  const result = JSON.parse(response.body).results[0];

  assert.equal(response.statusCode, 200);
  assert.equal(result.user_name, 'U123');
  assert.equal(result.channel_name, 'general');
});

test('AI API rejects unauthenticated requests before querying archived data', async () => {
  const handler = createAiApiHandler({
    verifyAuth: async () => { throw Object.assign(new Error('invalid'), { statusCode: 401 }); },
    ddbSend: async () => { throw new Error('must not query'); },
  });
  const response = await handler(apiEvent({ method: 'GET', path: '/api/ai/messages/C123/1710000001.000000' }));

  assert.equal(response.statusCode, 401);
  assert.deepEqual(JSON.parse(response.body), { error: 'unauthorized' });
});

test('archiveUrl and parseJsonBody handle links and invalid request bodies', () => {
  assert.equal(archiveUrl({ webBaseUrl: 'https://archive.example', channelId: CHANNEL_ID, ts: TS }),
    `https://archive.example/web?channel_id=${CHANNEL_ID}&ts=${TS}`);
  assert.equal(parseJsonBody({ body: '{bad' }), null);
  assert.deepEqual(parseJsonBody({ isBase64Encoded: true, body: Buffer.from('{"query":"q"}').toString('base64') }), { query: 'q' });
});

function apiEvent({ method, path, body = {}, pathParameters = {}, queryStringParameters = {} }) {
  return {
    rawPath: path,
    requestContext: { http: { method } },
    headers: {},
    body: JSON.stringify(body),
    pathParameters,
    queryStringParameters,
  };
}
