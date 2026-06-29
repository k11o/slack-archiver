const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createHandler,
  exchangeSlackCode,
  hasRequiredScopes,
  renderInstallPage,
} = require('../src/install/handler');

function eventWithQuery(queryStringParameters = {}) {
  return { queryStringParameters, headers: {} };
}

test('hasRequiredScopes accepts all required scopes and rejects missing ones', () => {
  assert.equal(hasRequiredScopes(['channels:history', 'channels:read', 'commands', 'chat:write', 'users:read']), true);
  assert.equal(hasRequiredScopes(['channels:history', 'channels:read', 'commands', 'chat:write']), false);
  assert.equal(hasRequiredScopes(['chat:write:public']), false);
  assert.equal(hasRequiredScopes([]), false);
});

test('install handler exchanges code, stores bot token, and renders success page', async () => {
  const calls = { put: [], exchange: null };
  const handler = createHandler({
    exchangeCode: async ({ code, redirectUri }) => {
      calls.exchange = { code, redirectUri };
      return {
        ok: true,
        access_token: 'xoxb-new-token',
        team: { id: 'T_NEW' },
        scope: 'channels:history,channels:read,commands,chat:write,users:read',
      };
    },
    putBotToken: async ({ teamId, botToken }) => {
      calls.put.push({ teamId, botToken });
    },
    successPage: ({ teamId }) => renderInstallPage({ teamId, isError: false }),
    errorPage: ({ message }) => renderInstallPage({ message, isError: true }),
  });

  process.env.SLACK_INSTALL_REDIRECT_URI = 'https://api.example/slack/install';
  const response = await handler(eventWithQuery({ code: 'test-code' }));

  assert.equal(calls.exchange.code, 'test-code');
  assert.equal(calls.exchange.redirectUri, 'https://api.example/slack/install');
  assert.deepEqual(calls.put, [{ teamId: 'T_NEW', botToken: 'xoxb-new-token' }]);
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /T_NEW/);
  assert.match(response.body, /alert-success/);
});

test('install handler rejects token response without team_id', async () => {
  const handler = createHandler({
    exchangeCode: async () => ({ ok: true, access_token: 'xoxb', team: {}, scope: 'channels:history,channels:read,commands,chat:write,users:read' }),
    putBotToken: async () => { throw new Error('should not store token without team_id'); },
    successPage: ({ teamId }) => renderInstallPage({ teamId, isError: false }),
    errorPage: ({ message }) => renderInstallPage({ message, isError: true }),
  });

  const response = await handler(eventWithQuery({ code: 'c' }));
  assert.match(response.body, /missing team_id/);
  assert.match(response.body, /alert-danger/);
});

test('install handler rejects token response with insufficient scopes', async () => {
  const handler = createHandler({
    exchangeCode: async () => ({ ok: true, access_token: 'xoxb', team: { id: 'T_NEW' }, scope: 'chat:write,users:read' }),
    putBotToken: async () => { throw new Error('should not store token with insufficient scopes'); },
    successPage: ({ teamId }) => renderInstallPage({ teamId, isError: false }),
    errorPage: ({ message }) => renderInstallPage({ message, isError: true }),
  });

  const response = await handler(eventWithQuery({ code: 'c' }));
  assert.match(response.body, /insufficient/);
});

test('install handler surfaces Slack error parameter', async () => {
  const handler = createHandler({
    exchangeCode: async () => { throw new Error('should not exchange when error param present'); },
    putBotToken: async () => { throw new Error('should not store'); },
    successPage: ({ teamId }) => renderInstallPage({ teamId, isError: false }),
    errorPage: ({ message }) => renderInstallPage({ message, isError: true }),
  });

  const response = await handler(eventWithQuery({ error: 'access_denied', error_description: 'user cancelled' }));
  assert.match(response.body, /user cancelled/);
});

test('install handler rejects missing code', async () => {
  const handler = createHandler({
    exchangeCode: async () => { throw new Error('should not exchange without code'); },
    putBotToken: async () => { throw new Error('should not store'); },
    successPage: ({ teamId }) => renderInstallPage({ teamId, isError: false }),
    errorPage: ({ message }) => renderInstallPage({ message, isError: true }),
  });

  const response = await handler(eventWithQuery({}));
  assert.match(response.body, /Missing authorization code/);
});

test('install handler handles oauth.v2.access failures', async () => {
  const handler = createHandler({
    exchangeCode: async () => { throw new Error('invalid_code'); },
    putBotToken: async () => { throw new Error('should not store'); },
    successPage: ({ teamId }) => renderInstallPage({ teamId, isError: false }),
    errorPage: ({ message }) => renderInstallPage({ message, isError: true }),
  });

  const response = await handler(eventWithQuery({ code: 'bad' }));
  assert.match(response.body, /Token exchange failed: invalid_code/);
});

test('install handler handles SSM write failures', async () => {
  const handler = createHandler({
    exchangeCode: async () => ({ ok: true, access_token: 'xoxb', team: { id: 'T_NEW' }, scope: 'channels:history,channels:read,commands,chat:write,users:read' }),
    putBotToken: async () => { throw new Error('AccessDenied'); },
    successPage: ({ teamId }) => renderInstallPage({ teamId, isError: false }),
    errorPage: ({ message }) => renderInstallPage({ message, isError: true }),
  });

  const response = await handler(eventWithQuery({ code: 'c' }));
  assert.match(response.body, /Failed to store bot token: AccessDenied/);
});

test('exchangeSlackCode posts to oauth.v2.access with client credentials and code', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, init });
    return {
      ok: true,
      json: async () => ({ ok: true, access_token: 'xoxb', team: { id: 'T' }, scope: 'chat:write' }),
    };
  };

  const result = await exchangeSlackCode({
    code: 'abc',
    redirectUri: 'https://api.example/slack/install',
    clientId: 'CID',
    clientSecret: 'SECRET',
    fetchImpl,
  });

  assert.equal(sent[0].url, 'https://slack.com/api/oauth.v2.access');
  assert.equal(sent[0].init.method, 'POST');
  const body = new URLSearchParams(sent[0].init.body);
  assert.equal(body.get('client_id'), 'CID');
  assert.equal(body.get('client_secret'), 'SECRET');
  assert.equal(body.get('code'), 'abc');
  assert.equal(body.get('redirect_uri'), 'https://api.example/slack/install');
  assert.equal(result.access_token, 'xoxb');
});

test('exchangeSlackCode throws when Slack returns ok=false', async () => {
  const fetchImpl = async () => ({ json: async () => ({ ok: false, error: 'bad_auth_code' }) });
  await assert.rejects(
    exchangeSlackCode({ code: 'x', redirectUri: 'u', clientId: 'c', clientSecret: 's', fetchImpl }),
    /bad_auth_code/,
  );
});

test('renderInstallPage escapes HTML in team id and error message', () => {
  const successBody = renderInstallPage({ teamId: '<script>', isError: false });
  assert.doesNotMatch(successBody.body, /<script>/);
  const errorBody = renderInstallPage({ message: '<img src=x>', isError: true });
  assert.doesNotMatch(errorBody.body, /<img src=x>/);
});