const assert = require('node:assert/strict');
const test = require('node:test');
const { createSearchHandler, renderPage, resolveTeamId } = require('../src/web/handler');
const { decodeIdToken, formatWorkspaceLabel } = require('../src/web/workspace');

test('resolveTeamId accepts the namespaced team_id claim', () => {
  assert.equal(resolveTeamId({ 'https://slack.com/team_id': 'T_NS' }), 'T_NS');
});

test('resolveTeamId accepts the custom team_id claim', () => {
  assert.equal(resolveTeamId({ 'custom:slack_team_id': 'T_CUSTOM' }), 'T_CUSTOM');
});

test('resolveTeamId returns the team id when both claims agree', () => {
  assert.equal(resolveTeamId({
    'custom:slack_team_id': 'T_SAME',
    'https://slack.com/team_id': 'T_SAME',
  }), 'T_SAME');
});

test('resolveTeamId rejects mismatched team claims', () => {
  assert.equal(resolveTeamId({
    'custom:slack_team_id': 'T_ONE',
    'https://slack.com/team_id': 'T_TWO',
  }), null);
});

test('resolveTeamId returns null when no team claim is present', () => {
  assert.equal(resolveTeamId({}), null);
  assert.equal(resolveTeamId({ email: 'user@example.com' }), null);
});

test('web search rejects users outside the optional Slack workspace allowlist', async () => {
  const handler = createSearchHandler({
    allowedSlackTeamIds: 'T_ALLOWED',
    getBotToken: async () => 'xoxb-token',
    ddbSend: async () => {
      throw new Error('forbidden requests should not hit DynamoDB');
    },
    verifyAuth: async () => ({ 'custom:slack_team_id': 'T_OTHER' }),
  });

  const response = await handler(eventWithQuery({ q: 'hello' }));

  assert.equal(response.statusCode, 403);
  assert.deepEqual(JSON.parse(response.body), { error: 'forbidden_workspace' });
});

test('web search scopes results to the logged-in Slack workspace', async () => {
  const hit = message({ ts: '1710000001.000000', text: 'hello world' });
  const handler = createSearchHandler({
    getBotToken: async ({ teamId }) => {
      assert.equal(teamId, 'T_LOGIN');
      return 'xoxb-token';
    },
    ddbSend: async () => null,
    verifyAuth: async () => ({ 'custom:slack_team_id': 'T_LOGIN' }),
    search: async ({ query, teamId }) => {
      assert.equal(query, 'hello');
      assert.equal(teamId, 'T_LOGIN');
      return [hit];
    },
    loadContext: async () => [hit],
    formatResult: async ({ context }) => ({
      channel_name: '#general',
      user_name: 'alice',
      time: '2024-03-09T16:00:01.000Z',
      text: 'hello world',
      context,
    }),
  });

  const response = await handler(eventWithQuery({ q: 'hello' }));
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].channel_name, '#general');
  assert.equal(body.results[0].user_name, 'alice');
});

test('web search scopes results using the namespaced team_id claim', async () => {
  const hit = message({ ts: '1710000001.000000', text: 'hello world' });
  const handler = createSearchHandler({
    getBotToken: async ({ teamId }) => {
      assert.equal(teamId, 'T_NS');
      return 'xoxb-token';
    },
    ddbSend: async () => null,
    verifyAuth: async () => ({ 'https://slack.com/team_id': 'T_NS' }),
    search: async ({ query, teamId }) => {
      assert.equal(query, 'hello');
      assert.equal(teamId, 'T_NS');
      return [hit];
    },
    loadContext: async () => [hit],
    formatResult: async ({ context }) => ({
      channel_name: '#general',
      user_name: 'alice',
      time: '2024-03-09T16:00:01.000Z',
      text: 'hello world',
      context,
    }),
  });

  const response = await handler(eventWithQuery({ q: 'hello' }));
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).results.length, 1);
});

test('web search rejects mismatched team claims before any DynamoDB call', async () => {
  const handler = createSearchHandler({
    getBotToken: async () => {
      throw new Error('mismatched claims should not load a bot token');
    },
    ddbSend: async () => {
      throw new Error('mismatched claims should not hit DynamoDB');
    },
    verifyAuth: async () => ({
      'custom:slack_team_id': 'T_ONE',
      'https://slack.com/team_id': 'T_TWO',
    }),
  });

  const response = await handler(eventWithQuery({ q: 'hello' }));

  assert.equal(response.statusCode, 403);
  assert.deepEqual(JSON.parse(response.body), { error: 'forbidden_workspace' });
});

test('web search returns unauthorized when token verification fails', async () => {
  const handler = createSearchHandler({
    allowedSlackTeamIds: 'T_ALLOWED',
    getBotToken: async () => 'xoxb-token',
    ddbSend: async () => {
      throw new Error('unauthorized requests should not hit DynamoDB');
    },
    verifyAuth: async () => {
      throw Object.assign(new Error('bad token'), { statusCode: 401 });
    },
  });

  const response = await handler(eventWithQuery({ q: 'hello' }));

  assert.equal(response.statusCode, 401);
  assert.deepEqual(JSON.parse(response.body), { error: 'unauthorized' });
});

test('renderPage includes Cognito and API configuration', () => {
  const page = renderPage({
    cognitoDomain: 'https://example.auth.ap-northeast-1.amazoncognito.com',
    clientId: 'client-id',
    redirectUri: 'https://api.example/web/callback',
    searchUrl: 'https://api.example/api/search',
  });

  assert.match(page, /Slack Archiver/);
  assert.match(page, /bootstrap@5\.3\.8/);
  assert.match(page, /client-id/);
  assert.match(page, /https:\/\/api\.example\/api\/search/);
});

test('renderPage shows the authenticated Slack workspace in the header', () => {
  const page = renderPage({
    cognitoDomain: 'https://example.auth.ap-northeast-1.amazoncognito.com',
    clientId: 'client-id',
    redirectUri: 'https://api.example/web/callback',
    searchUrl: 'https://api.example/api/search',
  });

  assert.match(page, /id="workspaceLabel"/);
  assert.match(page, /formatWorkspaceLabel/);
  assert.match(page, /custom:slack_team_name/);
  assert.match(page, /custom:slack_team_id/);
});

test('decodeIdToken returns claims for a valid JWT', () => {
  const token = makeJwt({ 'custom:slack_team_id': 'T123', sub: 'U123' });
  assert.deepEqual(decodeIdToken(token), { 'custom:slack_team_id': 'T123', sub: 'U123' });
});

test('decodeIdToken returns null for invalid tokens', () => {
  assert.equal(decodeIdToken('not-a-jwt'), null);
  assert.equal(decodeIdToken('a.b'), null);
  assert.equal(decodeIdToken(null), null);
  assert.equal(decodeIdToken(undefined), null);
});

test('formatWorkspaceLabel shows team name and id when both are present', () => {
  const token = makeJwt({
    'custom:slack_team_name': 'My Workspace',
    'custom:slack_team_id': 'T123',
  });
  assert.equal(formatWorkspaceLabel(token), 'My Workspace (T123)');
});

test('formatWorkspaceLabel falls back to team id when team name is missing', () => {
  const token = makeJwt({ 'custom:slack_team_id': 'T123' });
  assert.equal(formatWorkspaceLabel(token), 'T123');
});

test('formatWorkspaceLabel uses namespaced claims when custom claims are absent', () => {
  const token = makeJwt({
    'https://slack.com/team_name': 'NS Workspace',
    'https://slack.com/team_id': 'T_NS',
  });
  assert.equal(formatWorkspaceLabel(token), 'NS Workspace (T_NS)');
});

test('formatWorkspaceLabel rejects mismatched team id claims', () => {
  const token = makeJwt({
    'custom:slack_team_id': 'T_ONE',
    'https://slack.com/team_id': 'T_TWO',
  });
  assert.equal(formatWorkspaceLabel(token), 'Slack workspace account required');
});

test('formatWorkspaceLabel drops team name when name claims mismatch but id claims agree', () => {
  const token = makeJwt({
    'custom:slack_team_name': 'Name A',
    'https://slack.com/team_name': 'Name B',
    'custom:slack_team_id': 'T123',
    'https://slack.com/team_id': 'T123',
  });
  assert.equal(formatWorkspaceLabel(token), 'T123');
});

test('formatWorkspaceLabel returns placeholder when no team id is present', () => {
  const token = makeJwt({ 'custom:slack_team_name': 'Lonely Workspace' });
  assert.equal(formatWorkspaceLabel(token), 'Slack workspace account required');
});

test('formatWorkspaceLabel returns placeholder when no token is provided', () => {
  assert.equal(formatWorkspaceLabel(null), 'Slack workspace account required');
  assert.equal(formatWorkspaceLabel(undefined), 'Slack workspace account required');
});

function makeJwt(payload) {
  const header = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

function eventWithQuery(queryStringParameters = {}) {
  return {
    queryStringParameters,
    headers: {},
  };
}

function message({ ts, text }) {
  return {
    pk: 'workspace#T_ALLOWED#channel#C123',
    sk: `ts#${ts}`,
    team_id: 'T_ALLOWED',
    channel_id: 'C123',
    user_id: 'U123',
    ts,
    text,
    normalized_text: text,
  };
}
