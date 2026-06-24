const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { DynamoDBDocumentClient, GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { emojify } = require('node-emoji');
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
const CONTEXT_PAGE_LIMIT = 25;

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
    if (result.Item && isSearchableMessage(result.Item, query)) messages.push(result.Item);
    if (messages.length >= MAX_HITS) break;
  }
  return messages;
}

function isSearchableMessage(message, query) {
  if (!message.normalized_text?.includes(query)) return false;
  if (message.deleted) return false;
  return !isBotMessage(message);
}

function isBotMessage(message) {
  return message.subtype === 'bot_message'
    || Boolean(message.bot_id)
    || Boolean(message.bot_profile)
    || Boolean(message.app_id)
    || isArchiverGeneratedMessage(message.text);
}

function isArchiverGeneratedMessage(text) {
  const value = decodeSlackEntities(text).trim();
  return / の検索: `[^`]*` \(\d+件/.test(value)
    || /^\*\d+\/\d+\* <#[A-Z0-9]+(?:\|[^>]+)?> <!date\^\d+/.test(value);
}

async function loadMessageContext({ message, ddbSend }) {
  const [before, after] = await Promise.all([
    loadDirectionalContext({ message, ddbSend, before: true }),
    loadDirectionalContext({ message, ddbSend, before: false }),
  ]);

  return [
    ...before.reverse(),
    message,
    ...after,
  ].filter((item) => item.sk === message.sk || (item && !item.deleted && !isBotMessage(item)));
}

async function loadDirectionalContext({ message, ddbSend, before }) {
  const items = [];
  let exclusiveStartKey;

  while (items.length < CONTEXT_SIZE) {
    const input = {
      TableName: process.env.MESSAGES_TABLE,
      KeyConditionExpression: before ? 'pk = :pk AND sk < :sk' : 'pk = :pk AND sk > :sk',
      ExpressionAttributeValues: { ':pk': message.pk, ':sk': message.sk },
      ScanIndexForward: !before,
      Limit: CONTEXT_PAGE_LIMIT,
    };
    if (exclusiveStartKey) input.ExclusiveStartKey = exclusiveStartKey;

    const result = await ddbSend(new QueryCommand(input));

    for (const item of result.Items || []) {
      if (!item.deleted && !isBotMessage(item) && isSameConversation(message, item)) {
        items.push(item);
        if (items.length >= CONTEXT_SIZE) break;
      }
    }

    if (!result.LastEvaluatedKey) break;
    exclusiveStartKey = result.LastEvaluatedKey;
  }

  return items;
}

function isSameConversation(reference, candidate) {
  if (reference.pk !== candidate.pk) return false;
  const referenceThreadTs = getReplyThreadTs(reference);
  if (!referenceThreadTs) return !getReplyThreadTs(candidate);
  return candidate.ts === referenceThreadTs || candidate.thread_ts === referenceThreadTs;
}

function getReplyThreadTs(message) {
  return message.thread_ts && message.thread_ts !== message.ts ? message.thread_ts : null;
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
  return escapeSlackText(emojify(renderSlackMessageText(text, userNames)));
}

function renderSlackMessageText(text, userNames = new Map()) {
  return decodeSlackEntities(text)
    .replace(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g, (_match, userId) => (
      userNames.get(userId) || sanitizeDisplayName(userId)
    ))
    .replace(/<#([A-Z0-9]+)(?:\|([^>]+))?>/g, (_match, channelId, channelName) => (
      channelName ? `#${channelName}` : `#${channelId}`
    ))
    .replace(/<!date\^(\d+)\^[^|>]*(?:\|([^>]*))?>/g, (_match, seconds, fallback) => (
      fallback || formatLocalTime(seconds)
    ))
    .replace(/<((?:https?|mailto):[^>|]+)\|([^>]+)>/g, (_match, url, label) => (
      label === url ? url : `${label} (${url})`
    ))
    .replace(/<((?:https?|mailto):[^>]+)>/g, (_match, url) => url)
    .replace(/<!([^>|]+)(?:\|([^>]+))?>/g, (_match, token, label) => label || token);
}

function decodeSlackEntities(value) {
  let text = String(value || '');
  for (let i = 0; i < 3; i += 1) {
    const decoded = text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    if (decoded === text) return decoded;
    text = decoded;
  }
  return text;
}

function formatLocalTime(seconds) {
  const date = new Date(Number(seconds) * 1000);
  if (Number.isNaN(date.getTime())) return '(unknown time)';
  return date.toISOString().replace('T', ' ').slice(0, 16);
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
exports.isArchiverGeneratedMessage = isArchiverGeneratedMessage;
exports.main = createHandler({
  getSigningSecret,
  invokeWorker: invokeSearchWorker,
});
exports.worker = createWorker({
  getBotToken,
  ddbSend: (command) => ddb.send(command),
  slackPost: postSlackMessage,
});
