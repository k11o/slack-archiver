const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { DynamoDBDocumentClient, GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { parseBody, verifySlackSignature } = require('../common/slack');
const { normalizeText, tokenize } = require('../common/text');

const ssm = new SSMClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});
let cachedSigningSecret;
let cachedBotToken;
const userCache = new Map();

const MAX_QUERY_TOKENS = 5;
const MAX_CANDIDATES = 20;
const MAX_HITS = 5;
const CONTEXT_SIZE = 5;

async function getSigningSecret() {
  if (cachedSigningSecret) return cachedSigningSecret;
  const result = await ssm.send(new GetParameterCommand({
    Name: process.env.SLACK_SIGNING_SECRET_PARAM,
    WithDecryption: true,
  }));
  cachedSigningSecret = result.Parameter.Value;
  return cachedSigningSecret;
}

async function getBotToken() {
  if (cachedBotToken) return cachedBotToken;
  const result = await ssm.send(new GetParameterCommand({
    Name: process.env.SLACK_BOT_TOKEN_PARAM,
    WithDecryption: true,
  }));
  cachedBotToken = result.Parameter.Value;
  return cachedBotToken;
}

async function postSlackMessage({ botToken, message }) {
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${botToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(message),
  });

  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(`Slack chat.postMessage failed: ${payload.error || response.status}`);
  }
  return payload;
}

async function fetchSlackUser({ botToken, userId }) {
  if (userCache.has(userId)) return userCache.get(userId);

  const response = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${botToken}`,
    },
  });

  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    return null;
  }

  const name = payload.user?.profile?.display_name_normalized
    || payload.user?.profile?.display_name
    || payload.user?.profile?.real_name_normalized
    || payload.user?.profile?.real_name
    || payload.user?.real_name
    || payload.user?.name
    || null;
  userCache.set(userId, name);
  return name;
}

async function invokeSearchWorker({ body }) {
  await lambda.send(new InvokeCommand({
    FunctionName: process.env.SEARCH_WORKER_FUNCTION_NAME,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ body })),
  }));
}

function createHandler({ getSigningSecret: loadSigningSecret, invokeWorker = invokeSearchWorker }) {
  return async (event) => {
    const { rawBody, body } = parseBody(event);
    const signingSecret = await loadSigningSecret();
    const ok = verifySlackSignature({
      signingSecret,
      timestamp: event.headers?.['x-slack-request-timestamp'] || event.headers?.['X-Slack-Request-Timestamp'],
      signature: event.headers?.['x-slack-signature'] || event.headers?.['X-Slack-Signature'],
      rawBody,
    });

    if (!ok) return { statusCode: 401, body: 'invalid signature' };

    const query = normalizeText(body.text || '');
    if (!query) {
      return json({ response_type: 'ephemeral', text: '検索語を指定してください。例: `/hi-nick aws lambda`' });
    }

    await invokeWorker({ body });
    return empty();
  };
}

function createWorker({ getBotToken: loadBotToken, ddbSend, slackPost, slackUserInfo = fetchSlackUser, responsePost = postResponseUrl }) {
  return async (event) => {
    const body = event.body || {};
    const query = normalizeText(body.text || '');
    const hits = await searchMessages({ query, ddbSend });
    if (!hits.length) {
      await responsePost({
        responseUrl: body.response_url,
        body: { response_type: 'ephemeral', text: `見つかりませんでした: ${query}` },
      });
      return empty();
    }

    const botToken = await loadBotToken();
    const requesterName = await resolveUserName({ botToken, userId: body.user_id, slackUserInfo });
    const parent = await slackPost({
      botToken,
      message: {
        channel: body.channel_id,
        text: `${requesterName} の検索: \`${escapeSlackText(query)}\` (${hits.length}件${hits.length === MAX_HITS ? '、上限まで表示' : ''})`,
        unfurl_links: false,
        unfurl_media: false,
      },
    });

    for (const [index, hit] of hits.entries()) {
      const context = await loadMessageContext({ message: hit, ddbSend });
      const userNames = await loadUserNames({ botToken, messages: context, slackUserInfo });
      await slackPost({
        botToken,
        message: {
          channel: body.channel_id,
          thread_ts: parent.ts,
          text: formatHitThreadMessage({ hit, context, index, total: hits.length, userNames }),
          unfurl_links: false,
          unfurl_media: false,
        },
      });
    }

    return empty();
  };
}

async function postResponseUrl({ responseUrl, body }) {
  if (!responseUrl) return null;
  const response = await fetch(responseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Slack response_url failed: ${response.status}`);
  }
  return response;
}

async function searchMessages({ query, ddbSend }) {
  const tokens = tokenize(query).slice(0, MAX_QUERY_TOKENS);
  const candidates = new Map();

  for (const token of tokens) {
    const result = await ddbSend(new QueryCommand({
      TableName: process.env.SEARCH_INDEX_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `token#${token}` },
      ScanIndexForward: false,
      Limit: 25,
    }));

    for (const item of result.Items || []) {
      const key = `${item.message_pk}|${item.message_sk}`;
      const candidate = candidates.get(key) || { pk: item.message_pk, sk: item.message_sk, score: 0 };
      candidate.score += 1;
      candidates.set(key, candidate);
    }
  }

  const rankedCandidates = [...candidates.values()]
    .sort((a, b) => b.score - a.score || b.sk.localeCompare(a.sk))
    .slice(0, MAX_CANDIDATES);
  const messages = [];
  for (const candidate of rankedCandidates) {
    const result = await ddbSend(new GetCommand({
      TableName: process.env.MESSAGES_TABLE,
      Key: { pk: candidate.pk, sk: candidate.sk },
    }));
    if (result.Item && result.Item.normalized_text.includes(query)) messages.push(result.Item);
    if (messages.length >= MAX_HITS) break;
  }
  return messages;
}

async function loadMessageContext({ message, ddbSend }) {
  const [before, after] = await Promise.all([
    ddbSend(new QueryCommand({
      TableName: process.env.MESSAGES_TABLE,
      KeyConditionExpression: 'pk = :pk AND sk < :sk',
      ExpressionAttributeValues: { ':pk': message.pk, ':sk': message.sk },
      ScanIndexForward: false,
      Limit: CONTEXT_SIZE,
    })),
    ddbSend(new QueryCommand({
      TableName: process.env.MESSAGES_TABLE,
      KeyConditionExpression: 'pk = :pk AND sk > :sk',
      ExpressionAttributeValues: { ':pk': message.pk, ':sk': message.sk },
      ScanIndexForward: true,
      Limit: CONTEXT_SIZE,
    })),
  ]);

  return [
    ...(before.Items || []).reverse(),
    message,
    ...(after.Items || []),
  ];
}

async function loadUserNames({ botToken, messages, slackUserInfo }) {
  const ids = new Set();
  for (const message of messages) {
    if (message.user_id) ids.add(message.user_id);
    for (const mentioned of extractMentionedUserIds(message.text || '')) ids.add(mentioned);
  }

  const entries = await Promise.all([...ids].map(async (userId) => [
    userId,
    await resolveUserName({ botToken, userId, slackUserInfo }),
  ]));
  return new Map(entries);
}

async function resolveUserName({ botToken, userId, slackUserInfo }) {
  if (!userId) return '(unknown user)';
  const name = await slackUserInfo({ botToken, userId });
  return sanitizeDisplayName(name || userId);
}

function extractMentionedUserIds(text) {
  return [...String(text || '').matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g)].map((match) => match[1]);
}

function formatHitThreadMessage({ hit, context, index, total, userNames = new Map() }) {
  const header = `*${index + 1}/${total}* <#${hit.channel_id}> ${formatSlackDate(hit.ts)} ${formatSlackUser(hit.user_id, userNames)}`;
  const lines = context.map((message) => {
    const marker = message.pk === hit.pk && message.sk === hit.sk ? '→' : ' ';
    return `${marker} ${formatSlackDate(message.ts)} ${formatSlackUser(message.user_id, userNames)}: ${formatSlackMessageText(message.text || '', userNames)}`;
  });

  return `${header}\n${lines.join('\n')}`;
}

function formatSlackDate(ts) {
  const seconds = Math.floor(Number.parseFloat(ts || '0'));
  if (!Number.isFinite(seconds) || seconds <= 0) return '(unknown time)';
  return `<!date^${seconds}^{date_short_pretty} {time}|${ts}>`;
}

function formatSlackUser(userId, userNames = new Map()) {
  if (!userId) return '(unknown user)';
  return userNames.get(userId) || sanitizeDisplayName(userId);
}

function formatSlackMessageText(text, userNames = new Map()) {
  return escapeSlackText(String(text || '').replace(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g, (_match, userId) => (
    userNames.get(userId) || sanitizeDisplayName(userId)
  )));
}

function sanitizeDisplayName(value) {
  return String(value || '')
    .replace(/^@+/, '')
    .replace(/[<>]/g, '')
    .trim() || '(unknown user)';
}

function escapeSlackText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function json(body) {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function empty() {
  return {
    statusCode: 200,
    body: '',
  };
}

exports.createHandler = createHandler;
exports.createWorker = createWorker;
exports.searchMessages = searchMessages;
exports.loadMessageContext = loadMessageContext;
exports.loadUserNames = loadUserNames;
exports.formatHitThreadMessage = formatHitThreadMessage;
exports.formatSlackMessageText = formatSlackMessageText;
exports.main = createHandler({
  getSigningSecret,
  invokeWorker: invokeSearchWorker,
});
exports.worker = createWorker({
  getBotToken,
  ddbSend: (command) => ddb.send(command),
  slackPost: postSlackMessage,
});
