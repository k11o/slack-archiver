const { SSMClient, PutParameterCommand } = require('@aws-sdk/client-ssm');

const ssm = new SSMClient({});

const REQUIRED_SCOPES = ['channels:history', 'channels:read', 'commands', 'chat:write', 'users:read'];

function createHandler({
  exchangeCode,
  putBotToken,
  successPage,
  errorPage,
}) {
  return async (event) => {
    const params = new URLSearchParams(event.queryStringParameters || {});
    const code = params.get('code');
    const error = params.get('error');

    if (error) return errorPage({ message: params.get('error_description') || error });
    if (!code) return errorPage({ message: 'Missing authorization code' });

    let tokenResponse;
    try {
      tokenResponse = await exchangeCode({ code, redirectUri: process.env.SLACK_INSTALL_REDIRECT_URI });
    } catch (err) {
      return errorPage({ message: `Token exchange failed: ${err.message}` });
    }

    const teamId = tokenResponse.team?.id;
    const botToken = tokenResponse.access_token;
    const scopes = tokenResponse.scope ? tokenResponse.scope.split(',') : [];

    if (!teamId || !botToken) {
      return errorPage({ message: 'Token response missing team_id or access_token' });
    }

    if (!hasRequiredScopes(scopes)) {
      return errorPage({ message: `Granted scopes insufficient. Required: ${REQUIRED_SCOPES.join(', ')}. Got: ${scopes.join(', ')}` });
    }

    try {
      await putBotToken({ teamId, botToken });
    } catch (err) {
      return errorPage({ message: `Failed to store bot token: ${err.message}` });
    }

    return successPage({ teamId });
  };
}

function hasRequiredScopes(granted) {
  return REQUIRED_SCOPES.every((scope) => granted.includes(scope));
}

async function exchangeSlackCode({ code, redirectUri, clientId, clientSecret, fetchImpl }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });
  const response = await (fetchImpl || fetch)('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error || 'oauth.v2.access failed');
  return payload;
}

async function putBotToken({ teamId, botToken }) {
  const prefix = process.env.SLACK_BOT_TOKEN_PARAM_PREFIX || '/slack-archiver/workspaces/';
  const name = `${prefix.replace(/\/?$/, '/')}${teamId}/slack-bot-token`;
  await ssm.send(new PutParameterCommand({
    Name: name,
    Type: 'SecureString',
    Value: botToken,
    Overwrite: true,
  }));
}

function renderInstallPage({ teamId, message, isError }) {
  const escapedTeam = String(teamId || '').replace(/[<>&"]/g, '');
  const escapedMsg = String(message || '').replace(/[<>&"]/g, '');
  const status = isError
    ? `<div class="alert alert-danger">Installation failed: ${escapedMsg}</div>`
    : `<div class="alert alert-success">Workspace <code>${escapedTeam}</code> is now configured. You can close this page and invite the app to the channels you want to archive.</div>`;
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Slack Archiver Install</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:64px auto;padding:0 16px;color:#1d1d1f}code{background:#f5f5f7;padding:2px 6px;border-radius:4px}</style></head><body><h1>Slack Archiver</h1>${status}</body></html>`,
  };
}

const main = createHandler({
  exchangeCode: ({ code, redirectUri }) => exchangeSlackCode({
    code,
    redirectUri,
    clientId: process.env.SLACK_APP_CLIENT_ID,
    clientSecret: process.env.SLACK_APP_CLIENT_SECRET,
  }),
  putBotToken,
  successPage: ({ teamId }) => renderInstallPage({ teamId, isError: false }),
  errorPage: ({ message }) => renderInstallPage({ message, isError: true }),
});

exports.createHandler = createHandler;
exports.exchangeSlackCode = exchangeSlackCode;
exports.hasRequiredScopes = hasRequiredScopes;
exports.putBotToken = putBotToken;
exports.renderInstallPage = renderInstallPage;
exports.main = main;