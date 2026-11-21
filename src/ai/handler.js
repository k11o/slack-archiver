const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const { loadUserNames } = require('../web/handler');
const { getBotToken, listSlackChannels } = require('../export/handler');
const { authenticateWebRequest, verifyCognitoJwt } = require('../web/auth');
const {
  searchArchivedMessages,
  getArchivedMessage,
  getArchivedThread,
} = require('./service');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function createAiApiHandler({
  allowedSlackTeamIds,
  verifyAuth = verifyCognitoJwt,
  ddbSend,
  loadBotToken = getBotToken,
  listChannels = listSlackChannels,
  loadNames = loadUserNames,
  search = searchArchivedMessages,
  getMessage = getArchivedMessage,
  getThread = getArchivedThread,
  webBaseUrl = process.env.WEB_BASE_URL,
}) {
  return async (event) => {
    const auth = await authenticateWebRequest({
      event,
      allowedSlackTeamIds,
      verifyAuth,
    });
    if (auth.error) return json({ error: auth.error }, auth.statusCode);

    const method = event.requestContext?.http?.method || '';
    const path = event.rawPath || '';
    try {
      if (method === 'POST' && path.endsWith('/api/ai/search')) {
        const body = parseJsonBody(event);
        if (!body) return json({ error: 'invalid_json' }, 400);
        const result = await search({
          query: body.query,
          mode: body.mode || 'phrase',
          teamId: auth.teamId,
          channelId: body.channel_id,
          after: body.after,
          before: body.before,
          limit: body.limit,
          cursor: body.cursor,
          ddbSend,
        });
        return json({
          results: await serializeMessages({
            messages: result.messages,
            teamId: auth.teamId,
            loadBotToken,
            listChannels,
            loadNames,
            webBaseUrl,
          }),
          next_cursor: result.next_cursor,
        });
      }

      if (method === 'GET' && path.endsWith('/api/ai/channels')) {
        const botToken = await loadBotToken({ teamId: auth.teamId });
        const channels = await listChannels({ botToken });
        return json({
          channels: channels.map((channel) => ({
            channel_id: channel.id,
            channel_name: channel.name,
            is_archived: Boolean(channel.is_archived),
          })),
        });
      }

      const messageParams = event.pathParameters || {};
      if (method === 'GET' && path.includes('/api/ai/messages/')) {
        const message = await getMessage({
          teamId: auth.teamId,
          channelId: messageParams.channelId || messageParams.channel_id,
          ts: messageParams.ts,
          ddbSend,
        });
        if (!message) return json({ error: 'message_not_found' }, 404);
        const [result] = await serializeMessages({
          messages: [message],
          teamId: auth.teamId,
          loadBotToken,
          listChannels,
          loadNames,
          webBaseUrl,
        });
        if (!result) return json({ error: 'message_not_found' }, 404);
        return json({ message: result });
      }

      if (method === 'GET' && path.includes('/api/ai/threads/')) {
        const result = await getThread({
          teamId: auth.teamId,
          channelId: messageParams.channelId || messageParams.channel_id,
          rootTs: messageParams.rootTs || messageParams.root_ts,
          limit: event.queryStringParameters?.limit,
          cursor: event.queryStringParameters?.cursor,
          ddbSend,
        });
        if (!result) return json({ error: 'thread_not_found' }, 404);
        const hasRoot = Boolean(result.root);
        const serialized = await serializeMessages({
          messages: [...(hasRoot ? [result.root] : []), ...result.replies],
          teamId: auth.teamId,
          loadBotToken,
          listChannels,
          loadNames,
          webBaseUrl,
        });
        if ((hasRoot && !serialized[0])
          || (!serialized.length && !result.next_cursor && !event.queryStringParameters?.cursor)) {
          return json({ error: 'thread_not_found' }, 404);
        }
        return json({
          root: hasRoot ? serialized[0] : null,
          replies: serialized.slice(hasRoot ? 1 : 0),
          next_cursor: result.next_cursor,
        });
      }

      return json({ error: 'not_found' }, 404);
    } catch (error) {
      if (error.statusCode) return json({ error: error.code || 'invalid_request' }, error.statusCode);
      return json({ error: 'internal_error' }, 500);
    }
  };
}

async function serializeMessages({
  messages,
  teamId,
  loadBotToken,
  listChannels,
  loadNames = loadUserNames,
  webBaseUrl,
}) {
  if (!messages.length) return [];
  let botToken;
  let channels;
  try {
    botToken = await loadBotToken({ teamId });
    channels = await listChannels({ botToken });
  } catch {
    throw Object.assign(new Error('channel visibility unavailable'), {
      statusCode: 503,
      code: 'channel_visibility_unavailable',
    });
  }
  const channelNames = new Map((channels || []).map((channel) => [channel.id, channel.name]));
  const publicMessages = messages.filter((message) => channelNames.has(message.channel_id));
  if (!publicMessages.length) return [];

  let names = new Map();
  try {
    names = await loadNames({ botToken, teamId, messages: publicMessages });
  } catch {
    names = new Map();
  }

  return publicMessages.map((message) => ({
    message_id: message.message_id || `${teamId}:${message.channel_id}:${message.ts}`,
    team_id: teamId,
    channel_id: message.channel_id,
    channel_name: channelNames.get(message.channel_id) || message.channel_id,
    user_id: message.user_id || null,
    user_name: names.get(message.user_id) || message.user_id || '(unknown user)',
    ts: message.ts,
    thread_ts: message.thread_ts || null,
    text: message.text || '',
    time: slackTsToIso(message.ts),
    archive_url: archiveUrl({ webBaseUrl, channelId: message.channel_id, ts: message.ts }),
  }));
}

function archiveUrl({ webBaseUrl, channelId, ts }) {
  if (!webBaseUrl) return null;
  const url = new URL('/web', webBaseUrl);
  url.searchParams.set('channel_id', channelId);
  url.searchParams.set('ts', ts);
  return url.toString();
}

function slackTsToIso(ts) {
  const seconds = Number.parseFloat(ts || '0');
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function parseJsonBody(event) {
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : event.body || '{}';
    const body = JSON.parse(raw);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function json(body, statusCode = 200) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  let response = { statusCode, headers, body: JSON.stringify(body) };
  if (Buffer.byteLength(JSON.stringify(response)) > MAX_RESPONSE_BYTES) {
    response = { statusCode: 413, headers, body: JSON.stringify({ error: 'response_too_large' }) };
  }
  return response;
}

const aiApi = createAiApiHandler({
  allowedSlackTeamIds: process.env.ALLOWED_SLACK_TEAM_IDS,
  ddbSend: (command) => ddb.send(command),
});

module.exports = {
  createAiApiHandler,
  serializeMessages,
  archiveUrl,
  parseJsonBody,
  aiApi,
  main: aiApi,
};
