const assert = require('node:assert/strict');
const test = require('node:test');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createMcpHandler, isAllowedOrigin } = require('../src/mcp/handler');
const { createMcpAuthenticator, REQUIRED_SCOPE } = require('../src/mcp/auth');

const RESOURCE = 'https://archive.example/mcp';

test('MCP access tokens are bound to the MCP client, resource, scope, and Slack workspace', async () => {
  const inputs = [];
  const authenticate = createMcpAuthenticator({
    issuer: 'https://cognito-idp.ap-northeast-1.amazonaws.com/pool',
    clientId: 'mcp-client',
    resource: RESOURCE,
    cognitoDomain: 'https://auth.example',
    allowedSlackTeamIds: 'T123',
    verifyToken: async (input) => {
      inputs.push(input);
      return {
        token_use: 'access',
        client_id: 'mcp-client',
        scope: `openid ${REQUIRED_SCOPE}`,
        sub: 'user-1',
        exp: 1900000000,
      };
    },
    loadUserInfo: async ({ token }) => {
      assert.equal(token, 'valid-access-token');
      return { sub: 'user-1', 'https://slack.com/team_id': 'T123' };
    },
  });

  const auth = await authenticate({ headers: { authorization: 'Bearer valid-access-token' } });
  assert.equal(auth.teamId, 'T123');
  assert.equal(auth.authInfo.resource.toString(), RESOURCE);
  assert.equal(inputs[0].audience, RESOURCE);
});

test('MCP auth rejects ID tokens, wrong OAuth clients, mismatched identity, and denied workspaces', async () => {
  const makeAuth = ({ claims, userInfo, allowedSlackTeamIds = '' }) => createMcpAuthenticator({
    issuer: 'issuer',
    clientId: 'mcp-client',
    resource: RESOURCE,
    cognitoDomain: 'https://auth.example',
    allowedSlackTeamIds,
    verifyToken: async () => claims,
    loadUserInfo: async () => userInfo,
  })({ headers: { authorization: 'Bearer token' } });
  const claims = {
    token_use: 'access',
    client_id: 'mcp-client',
    scope: `openid ${REQUIRED_SCOPE}`,
    sub: 'user-1',
    exp: 1900000000,
  };

  assert.equal((await makeAuth({ claims: { ...claims, token_use: 'id' }, userInfo: { sub: 'user-1' } })).statusCode, 401);
  assert.equal((await makeAuth({ claims: { ...claims, exp: Math.floor(Date.now() / 1000) - 1 }, userInfo: { sub: 'user-1' } })).statusCode, 401);
  assert.equal((await makeAuth({ claims: { ...claims, client_id: 'web-client' }, userInfo: { sub: 'user-1' } })).statusCode, 401);
  assert.equal((await makeAuth({ claims: { ...claims, scope: REQUIRED_SCOPE }, userInfo: { sub: 'user-1' } })).statusCode, 401);
  assert.equal((await makeAuth({ claims, userInfo: { sub: 'other-user', 'https://slack.com/team_id': 'T123' } })).statusCode, 401);
  assert.equal((await makeAuth({ claims, userInfo: { sub: 'user-1', 'https://slack.com/team_id': 'T456' }, allowedSlackTeamIds: 'T123' })).statusCode, 403);
  assert.equal((await makeAuth({ claims, userInfo: { sub: 'user-1', 'custom:slack_team_id': 'T123' } })).teamId, 'T123');
  assert.equal((await makeAuth({ claims, userInfo: { sub: 'user-1' } })).statusCode, 403);
});

test('MCP Streamable HTTP endpoint works with the official SDK client', async () => {
  process.env.WEB_BASE_URL = 'https://archive.example';
  const toolCalls = [];
  const handler = createMcpHandler({
    resource: RESOURCE,
    issuer: 'https://cognito-idp.ap-northeast-1.amazonaws.com/pool',
    authenticate: async () => ({
      teamId: 'T123',
      authInfo: {
        token: 'verified-access-token',
        clientId: 'mcp-client',
        scopes: [REQUIRED_SCOPE],
        resource: new URL(RESOURCE),
        extra: { teamId: 'T123' },
      },
    }),
    ddbSend: async () => ({}),
    loadBotToken: async () => 'bot-token',
    listChannels: async () => [{ id: 'C123', name: 'general', is_archived: false }],
    serialize: async ({ messages, teamId }) => messages.map((message) => ({
      team_id: teamId,
      channel_id: message.channel_id,
      ts: message.ts,
      text: message.text,
      archive_url: `${RESOURCE}/../web?channel_id=${message.channel_id}&ts=${message.ts}`,
    })),
    search: async (input) => {
      toolCalls.push(input);
      return {
        messages: [{ channel_id: 'C123', ts: '1710000001.000000', text: 'needle' }],
        next_cursor: null,
      };
    },
    getMessage: async ({ teamId, channelId, ts }) => ({ team_id: teamId, channel_id: channelId, ts, text: 'one message' }),
    getThread: async ({ teamId, channelId, rootTs }) => ({
      root: rootTs === '1710000003.000000'
        ? null
        : { team_id: teamId, channel_id: channelId, ts: rootTs, text: 'thread root' },
      replies: [{ team_id: teamId, channel_id: channelId, ts: '1710000002.000000', thread_ts: rootTs, text: 'reply' }],
      next_cursor: null,
    }),
  });

  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    requestInit: { headers: { authorization: 'Bearer test-token' } },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const response = await handler({
        rawPath: url.pathname,
        rawQueryString: url.search.slice(1),
        requestContext: { http: { method: request.method } },
        headers: Object.fromEntries(request.headers.entries()),
        body: request.method === 'POST' ? await request.text() : undefined,
        isBase64Encoded: false,
      });
      return new Response(response.body || null, { status: response.statusCode, headers: response.headers });
    },
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      'get_message',
      'get_thread',
      'list_channels',
      'search_messages',
    ]);
    const result = await client.callTool({
      name: 'search_messages',
      arguments: { query: 'needle', team_id: 'T_OTHER' },
    });
    assert.equal(result.structuredContent.results[0].team_id, 'T123');
    assert.equal(toolCalls[0].teamId, 'T123');
    assert.equal(toolCalls[0].team_id, undefined);
    const message = await client.callTool({
      name: 'get_message',
      arguments: { channel_id: 'C123', ts: '1710000001.000000' },
    });
    assert.equal(message.structuredContent.message.text, 'one message');
    const legacyPublicChannelMessage = await client.callTool({
      name: 'get_message',
      arguments: { channel_id: 'G123', ts: '1710000001.000000' },
    });
    assert.equal(legacyPublicChannelMessage.structuredContent.message.channel_id, 'G123');
    const thread = await client.callTool({
      name: 'get_thread',
      arguments: { channel_id: 'C123', root_ts: '1710000001.000000' },
    });
    assert.equal(thread.structuredContent.root.text, 'thread root');
    assert.equal(thread.structuredContent.replies.length, 1);
    const deletedRoot = await client.callTool({
      name: 'get_thread',
      arguments: { channel_id: 'C123', root_ts: '1710000003.000000' },
    });
    assert.equal(deletedRoot.structuredContent.root, null);
    assert.equal(deletedRoot.structuredContent.replies.length, 1);
    const channels = await client.callTool({ name: 'list_channels', arguments: {} });
    assert.equal(channels.structuredContent.channels[0].channel_name, 'general');
  } finally {
    await client.close();
  }
});

test('MCP bounds the serialized Lambda response envelope', async () => {
  process.env.WEB_BASE_URL = 'https://archive.example';
  const text = '"'.repeat(600 * 1024);
  const handler = createMcpHandler({
    resource: RESOURCE,
    issuer: 'https://cognito-idp.ap-northeast-1.amazonaws.com/pool',
    authenticate: async () => ({
      teamId: 'T123',
      authInfo: { extra: { teamId: 'T123' } },
    }),
    ddbSend: async () => ({}),
    loadBotToken: async () => 'bot-token',
    listChannels: async () => [],
    serialize: async () => [{ text }],
    search: async () => ({ messages: [{}], next_cursor: null }),
  });
  let responseStatus;
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const response = await handler({
        rawPath: url.pathname,
        requestContext: { http: { method: request.method } },
        headers: Object.fromEntries(request.headers.entries()),
        body: request.method === 'POST' ? await request.text() : undefined,
      });
      responseStatus = response.statusCode;
      return new Response(response.body || null, { status: response.statusCode, headers: response.headers });
    },
  });
  const client = new Client({ name: 'size-test', version: '1.0.0' });

  try {
    await client.connect(transport);
    await assert.rejects(client.callTool({ name: 'search_messages', arguments: { query: 'needle' } }));
    assert.equal(responseStatus, 413);
  } finally {
    await client.close();
  }
});

test('MCP handler rejects missing or non-HTTPS resource configuration', () => {
  assert.throws(() => createMcpHandler({}), /MCP resource URL is required/);
  assert.throws(() => createMcpHandler({ resource: 'http://archive.example/mcp' }), /must use HTTPS/);
});

test('MCP publishes protected-resource metadata and enforces Origin', async () => {
  const handler = createMcpHandler({
    resource: RESOURCE,
    issuer: 'https://cognito-idp.ap-northeast-1.amazonaws.com/pool',
    allowedOrigins: 'https://client.example',
    authenticate: async () => ({ error: 'unauthorized', statusCode: 401 }),
  });
  const metadata = await handler({
    rawPath: '/.well-known/oauth-protected-resource/mcp',
    requestContext: { http: { method: 'GET' } },
    headers: {},
  });
  const challenge = await handler({
    rawPath: '/mcp',
    requestContext: { http: { method: 'POST' } },
    headers: { origin: 'https://client.example' },
  });
  const badOrigin = await handler({
    rawPath: '/mcp',
    requestContext: { http: { method: 'POST' } },
    headers: { origin: 'https://evil.example' },
  });
  const unsupportedMethod = await handler({
    rawPath: '/mcp',
    requestContext: { http: { method: 'GET' } },
    headers: {},
  });

  assert.deepEqual(JSON.parse(metadata.body), {
    resource: RESOURCE,
    authorization_servers: ['https://cognito-idp.ap-northeast-1.amazonaws.com/pool'],
    scopes_supported: ['openid', 'profile', 'email', REQUIRED_SCOPE],
    bearer_methods_supported: ['header'],
  });
  assert.match(challenge.headers['www-authenticate'], /oauth-protected-resource\/mcp/);
  assert.equal(badOrigin.statusCode, 403);
  assert.equal(unsupportedMethod.statusCode, 405);
});

test('MCP origin validation permits no Origin and configured client origins only', () => {
  const allowed = new Set(['https://archive.example', 'https://client.example']);
  assert.equal(isAllowedOrigin({ headers: { host: 'archive.example' } }, allowed, 'archive.example'), true);
  assert.equal(isAllowedOrigin({ headers: { host: 'archive.example', origin: 'https://client.example' } }, allowed, 'archive.example'), true);
  assert.equal(isAllowedOrigin({ headers: { host: 'evil.example' } }, allowed, 'archive.example'), false);
});
