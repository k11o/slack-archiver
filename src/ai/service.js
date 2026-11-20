const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('node:crypto');
const { GetParameterCommand, SSMClient } = require('@aws-sdk/client-ssm');
const { GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { normalizeText, tokenize } = require('../common/text');
const { isArchiverGeneratedMessage } = require('../search/handler');

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_QUERY_LENGTH = 500;
const ssm = new SSMClient({});
let cachedCursorSecret;

async function getCursorSecret() {
  if (cachedCursorSecret) return cachedCursorSecret;
  const result = await ssm.send(new GetParameterCommand({
    Name: process.env.SLACK_SIGNING_SECRET_PARAM || '/slack-archiver/slack-signing-secret',
    WithDecryption: true,
  }));
  cachedCursorSecret = result.Parameter.Value;
  return cachedCursorSecret;
}

async function searchArchivedMessages({
  query,
  mode = 'phrase',
  teamId,
  channelId,
  after,
  before,
  limit = DEFAULT_PAGE_SIZE,
  cursor,
  cursorSecret: suppliedCursorSecret,
  ddbSend,
}) {
  const input = validateSearchInput({ query, mode, teamId, channelId, after, before, limit });
  const cursorSecret = suppliedCursorSecret || await getCursorSecret();
  // shortcut: candidate lookup requires an exact indexed token; use n-grams if partial-word search is needed.
  const anchorToken = [...input.tokens].sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
  const indexPk = `workspace#${teamId}#token#${anchorToken}`;
  const lastKey = decodeCursor(cursor, {
    kind: 'search',
    teamId,
    query: input.query,
    mode: input.mode,
    channelId: input.channelId,
    after: input.after,
    before: input.before,
    anchorToken,
    indexPk,
  }, cursorSecret);
  const page = await ddbSend(new QueryCommand({
    TableName: process.env.SEARCH_INDEX_TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': indexPk },
    ScanIndexForward: false,
    Limit: input.limit,
    ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
  }));

  const results = [];
  for (const entry of page.Items || []) {
    if (entry.team_id && entry.team_id !== teamId) continue;
    if (channelId && !entry.message_pk?.endsWith(`#channel#${channelId}`)) continue;
    const loaded = await ddbSend(new GetCommand({
      TableName: process.env.MESSAGES_TABLE,
      Key: { pk: entry.message_pk, sk: entry.message_sk },
      ConsistentRead: true,
    }));
    const message = loaded.Item;
    if (!message || !isPublicHumanMessage(message, teamId)) continue;
    if (input.channelId && message.channel_id !== input.channelId) continue;
    if (!isWithinDateRange(message.ts, input.afterMs, input.beforeMs)) continue;
    if (!matchesQuery(message, input)) continue;
    results.push(message);
  }

  results.sort((a, b) => Number.parseFloat(b.ts) - Number.parseFloat(a.ts));
  return {
    messages: results,
    next_cursor: page.LastEvaluatedKey
      ? encodeCursor({
        kind: 'search',
        teamId,
        query: input.query,
        mode: input.mode,
        channelId: input.channelId,
        after: input.after,
        before: input.before,
        anchorToken,
        indexPk,
        key: page.LastEvaluatedKey,
      }, cursorSecret)
      : null,
  };
}

async function getArchivedMessage({ teamId, channelId, ts, ddbSend }) {
  if (!teamId || !isPublicChannelId(channelId) || !isSlackTimestamp(ts)) return null;
  const result = await ddbSend(new GetCommand({
    TableName: process.env.MESSAGES_TABLE,
    Key: {
      pk: `workspace#${teamId}#channel#${channelId}`,
      sk: `ts#${ts}`,
    },
    ConsistentRead: true,
  }));
  return result.Item && isPublicHumanMessage(result.Item, teamId) ? result.Item : null;
}

async function getArchivedThread({
  teamId,
  channelId,
  rootTs,
  limit = DEFAULT_PAGE_SIZE,
  cursor,
  cursorSecret: suppliedCursorSecret,
  ddbSend,
}) {
  if (!teamId || !isPublicChannelId(channelId) || !isSlackTimestamp(rootTs)) {
    throw apiError(400, 'invalid_thread');
  }
  const pageSize = validatePageSize(limit);
  const cursorSecret = suppliedCursorSecret || await getCursorSecret();
  const root = await getArchivedMessage({ teamId, channelId, ts: rootTs, ddbSend });
  if (!root) return null;

  const pk = `workspace#${teamId}#channel#${channelId}`;
  const lastKey = decodeCursor(cursor, { kind: 'thread', teamId, channelId, rootTs, pk }, cursorSecret);
  const page = await ddbSend(new QueryCommand({
    TableName: process.env.MESSAGES_TABLE,
    KeyConditionExpression: 'pk = :pk AND sk > :root_key',
    FilterExpression: '#thread_ts = :root_ts AND (attribute_not_exists(#deleted) OR #deleted = :false)',
    ExpressionAttributeNames: { '#thread_ts': 'thread_ts', '#deleted': 'deleted' },
    ExpressionAttributeValues: {
      ':pk': pk,
      ':root_key': `ts#${rootTs}`,
      ':root_ts': rootTs,
      ':false': false,
    },
    ConsistentRead: true,
    ScanIndexForward: true,
    Limit: pageSize,
    ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
  }));

  const replies = (page.Items || [])
    .filter((message) => isPublicHumanMessage(message, teamId)
      && message.channel_id === channelId
      && message.thread_ts === rootTs);
  return {
    root,
    replies,
    next_cursor: page.LastEvaluatedKey
      ? encodeCursor({ kind: 'thread', teamId, channelId, rootTs, pk, key: page.LastEvaluatedKey }, cursorSecret)
      : null,
  };
}

function validateSearchInput({ query, mode, teamId, channelId, after, before, limit }) {
  if (typeof query !== 'string' || query.length > MAX_QUERY_LENGTH) throw apiError(400, 'invalid_query');
  const normalizedQuery = normalizeText(query);
  if (!teamId || !normalizedQuery || normalizedQuery.length > MAX_QUERY_LENGTH) {
    throw apiError(400, 'invalid_query');
  }
  if (mode !== 'phrase' && mode !== 'and') throw apiError(400, 'invalid_mode');
  if (channelId !== undefined && !isPublicChannelId(channelId)) throw apiError(400, 'invalid_channel_id');
  const tokens = tokenize(normalizedQuery);
  if (!tokens.length) throw apiError(400, 'query_has_no_searchable_terms');

  const afterMs = parseDate(after, 'after');
  const beforeMs = parseDate(before, 'before');
  if (afterMs !== null && beforeMs !== null && afterMs > beforeMs) {
    throw apiError(400, 'invalid_date_range');
  }
  return {
    query: normalizedQuery,
    mode,
    channelId,
    after: after || null,
    before: before || null,
    afterMs,
    beforeMs,
    tokens,
    limit: validatePageSize(limit),
  };
}

function validatePageSize(value) {
  const size = value === undefined ? DEFAULT_PAGE_SIZE : Number(value);
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
    throw apiError(400, 'invalid_limit');
  }
  return size;
}

function parseDate(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw apiError(400, `invalid_${name}`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw apiError(400, `invalid_${name}`);
  return milliseconds;
}

function matchesQuery(message, input) {
  const normalizedText = message.normalized_text || normalizeText(message.text || '');
  if (input.mode === 'phrase') return normalizedText.includes(input.query);
  const indexedTokens = message.search_tokens || tokenize(message.text || '');
  return input.tokens.every((token) => indexedTokens.includes(token));
}

function isPublicHumanMessage(message, teamId) {
  return message.team_id === teamId
    && isPublicChannelId(message.channel_id)
    && !message.deleted
    && !message.subtype
    && !message.bot_id
    && !message.app_id
    && !message.bot_profile
    && !isArchiverGeneratedMessage(message.text);
}

function isPublicChannelId(channelId) {
  return typeof channelId === 'string' && /^C[A-Z0-9]{2,}$/.test(channelId);
}

function isSlackTimestamp(value) {
  return typeof value === 'string' && /^\d{1,12}\.\d{6}$/.test(value);
}

function isWithinDateRange(ts, afterMs, beforeMs) {
  const milliseconds = Number.parseFloat(ts) * 1000;
  return Number.isFinite(milliseconds)
    && (afterMs === null || milliseconds >= afterMs)
    && (beforeMs === null || milliseconds <= beforeMs);
}

function encodeCursor(state, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function decodeCursor(cursor, expected, secret) {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  if (typeof cursor !== 'string' || cursor.length > 8192) throw apiError(400, 'invalid_cursor');
  let state;
  try {
    const encoded = Buffer.from(cursor, 'base64url');
    if (encoded.length < 29) throw new Error('invalid cursor');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      createHash('sha256').update(secret).digest(),
      encoded.subarray(0, 12),
    );
    decipher.setAuthTag(encoded.subarray(12, 28));
    state = JSON.parse(Buffer.concat([
      decipher.update(encoded.subarray(28)),
      decipher.final(),
    ]).toString('utf8'));
  } catch {
    throw apiError(400, 'invalid_cursor');
  }

  if (!state || typeof state !== 'object' || Array.isArray(state)) throw apiError(400, 'invalid_cursor');
  for (const [key, value] of Object.entries(expected)) {
    if (state[key] !== value) throw apiError(400, 'invalid_cursor');
  }
  if (!state.key || typeof state.key !== 'object' || typeof state.key.pk !== 'string'
    || typeof state.key.sk !== 'string'
    || (state.key.pk !== expected.indexPk && state.key.pk !== expected.pk)) {
    throw apiError(400, 'invalid_cursor');
  }
  return { pk: state.key.pk, sk: state.key.sk };
}

function apiError(statusCode, code) {
  return Object.assign(new Error(code), { statusCode, code });
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_QUERY_LENGTH,
  searchArchivedMessages,
  getArchivedMessage,
  getArchivedThread,
  validateSearchInput,
  validatePageSize,
  isPublicHumanMessage,
  isPublicChannelId,
  isSlackTimestamp,
  apiError,
};
