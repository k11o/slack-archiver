const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');
const { parseBody, verifySlackSignature } = require('../common/slack');
const { normalizeText, tokenize, tokenizeLegacy, isIndexableToken } = require('../common/text');

const ssm = new SSMClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const MAX_INDEX_RETRIES = 3;
const MAX_TRANSACTION_WRITES = 49;
let cachedSigningSecret;

async function getSigningSecret() {
  if (cachedSigningSecret) return cachedSigningSecret;
  const result = await ssm.send(new GetParameterCommand({
    Name: process.env.SLACK_SIGNING_SECRET_PARAM,
    WithDecryption: true,
  }));
  cachedSigningSecret = result.Parameter.Value;
  return cachedSigningSecret;
}

function createHandler({ getSigningSecret: loadSigningSecret, ddbSend }) {
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

    if (body.type === 'url_verification') {
      return { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: body.challenge };
    }

    const slackEvent = body.event;
    if (!slackEvent || slackEvent.type !== 'message') return { statusCode: 200, body: 'ignored' };

    const teamId = body.team_id || slackEvent.team;
    const channelId = slackEvent.channel;
    if (!teamId) return { statusCode: 200, body: 'ignored' };

    const incoming = toMessageChange({ body, slackEvent, teamId, channelId });
    if (!incoming) return { statusCode: 200, body: 'ignored' };

    const message = await writeNewerMessage({ incoming, ddbSend });
    await reconcileSearchIndex({ message, ddbSend });
    return { statusCode: 200, body: 'ok' };
  };
}

function toMessageChange({ body, slackEvent, teamId, channelId }) {
  if (slackEvent.channel_type === 'group' || slackEvent.message?.channel_type === 'group'
    || slackEvent.previous_message?.channel_type === 'group') return null;
  if (!/^C[A-Z0-9]+$/.test(channelId || '')
    && !(/^G[A-Z0-9]+$/.test(channelId || '')
      && [slackEvent.channel_type, slackEvent.message?.channel_type, slackEvent.previous_message?.channel_type]
        .includes('channel'))) return null;
  if (slackEvent.subtype === 'message_deleted') {
    const ts = slackEvent.deleted_ts;
    const revisionTs = parseSlackTimestamp(slackEvent.ts) || Number(body.event_time) || 0;
    if (!ts || !revisionTs) return null;
    return {
      kind: 'delete',
      teamId,
      channelId,
      ts,
      revisionTs,
      eventId: body.event_id || null,
      message: slackEvent.previous_message || {},
    };
  }

  if (slackEvent.subtype === 'message_changed') {
    const message = slackEvent.message;
    if (!message) return null;
    if (message.subtype === 'tombstone') {
      const revisionTs = parseSlackTimestamp(message.edited?.ts)
        || parseSlackTimestamp(slackEvent.ts)
        || Number(body.event_time)
        || 0;
      if (!message.ts || !revisionTs) return null;
      return {
        kind: 'delete',
        teamId,
        channelId,
        ts: message.ts,
        revisionTs,
        eventId: body.event_id || null,
        message: slackEvent.previous_message || {},
      };
    }
    if (isIgnoredMessageEvent(message)) return null;
    const revisionTs = parseSlackTimestamp(message.edited?.ts)
      || Number(body.event_time)
      || parseSlackTimestamp(slackEvent.ts)
      || 0;
    if (!message.ts || !revisionTs) return null;
    return {
      kind: 'upsert',
      teamId,
      channelId,
      ts: message.ts,
      revisionTs,
      eventId: body.event_id || null,
      message,
    };
  }

  if (isIgnoredMessageEvent(slackEvent) || !slackEvent.ts) return null;
  const revisionTs = parseSlackTimestamp(slackEvent.ts);
  if (!revisionTs) return null;
  return {
    kind: 'upsert',
    teamId,
    channelId,
    ts: slackEvent.ts,
    revisionTs,
    eventId: body.event_id || null,
    message: slackEvent,
  };
}

async function writeNewerMessage({ incoming, ddbSend, now = () => new Date() }) {
  const { teamId, channelId, ts } = incoming;
  const pk = `workspace#${teamId}#channel#${channelId}`;
  const sk = `ts#${ts}`;

  for (let attempt = 0; attempt < MAX_INDEX_RETRIES; attempt += 1) {
    const result = await ddbSend(new GetCommand({
      TableName: process.env.MESSAGES_TABLE,
      Key: { pk, sk },
      ConsistentRead: true,
    }));
    const existing = result.Item;

    if (existing?.deleted && incoming.kind !== 'delete') {
      if (existing.revision_ts !== undefined) return normalizeLegacyMessage(existing);
      try {
        return await migrateLegacyMessage({ existing, ddbSend });
      } catch (error) {
        if (error.name !== 'ConditionalCheckFailedException') throw error;
        continue;
      }
    }

    const existingRevision = Number(existing?.revision_ts ?? existing?.ts ?? 0);
    if (existing && incoming.revisionTs <= existingRevision) {
      if (existing.revision_ts === undefined) {
        try {
          return await migrateLegacyMessage({ existing, ddbSend });
        } catch (error) {
          if (error.name !== 'ConditionalCheckFailedException') throw error;
          continue;
        }
      }
      return normalizeLegacyMessage(existing);
    }

    const message = buildMessage({ incoming, existing, pk, sk, now: now() });
    try {
      await ddbSend(new PutCommand({
        TableName: process.env.MESSAGES_TABLE,
        Item: message,
        ConditionExpression: existing
          ? (existing.revision_ts === undefined
            ? 'attribute_not_exists(revision_ts)'
            : 'revision_ts = :existingRevision')
          : 'attribute_not_exists(pk)',
        ...(existing?.revision_ts === undefined ? {} : {
          ExpressionAttributeValues: { ':existingRevision': existing.revision_ts },
        }),
      }));
      return message;
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
    }
  }

  throw new Error('message changed concurrently; retry Slack event');
}

function buildMessage({ incoming, existing, pk, sk, now }) {
  const deleted = incoming.kind === 'delete';
  const text = deleted ? '' : String(incoming.message.text || '');
  const searchTokens = deleted ? [] : tokenize(text);
  const oldIndexTokens = existing?.index_tokens
    || existing?.search_tokens
    || (existing?.deleted ? [] : tokenizeLegacy(existing?.text || ''));

  return {
    ...existing,
    pk,
    sk,
    message_id: `${incoming.teamId}:${incoming.channelId}:${incoming.ts}`,
    team_id: incoming.teamId,
    channel_id: incoming.channelId,
    user_id: incoming.message.user || existing?.user_id || null,
    subtype: deleted ? 'message_deleted' : incoming.message.subtype || null,
    bot_id: deleted ? null : incoming.message.bot_id || null,
    app_id: deleted ? null : incoming.message.app_id || null,
    bot_profile: deleted ? null : incoming.message.bot_profile || null,
    ts: incoming.ts,
    thread_ts: deleted
      ? existing?.thread_ts || null
      : incoming.message.thread_ts || null,
    text,
    normalized_text: normalizeText(text),
    search_tokens: searchTokens,
    // Keep a pending union until all derived index writes have succeeded.
    index_tokens: [...new Set([...oldIndexTokens, ...searchTokens])],
    revision_ts: incoming.revisionTs,
    event_id: incoming.eventId,
    deleted,
    created_at: existing?.created_at || now.toISOString(),
    updated_at: now.toISOString(),
  };
}

async function migrateLegacyMessage({ existing, ddbSend }) {
  const migrated = normalizeLegacyMessage(existing);
  await ddbSend(new PutCommand({
    TableName: process.env.MESSAGES_TABLE,
    Item: migrated,
    ConditionExpression: 'attribute_not_exists(revision_ts)',
  }));
  return migrated;
}

function normalizeLegacyMessage(message) {
  const searchTokens = message.deleted ? [] : (message.search_tokens || tokenize(message.text || ''));
  return {
    ...message,
    revision_ts: Number(message.revision_ts ?? message.ts ?? 0),
    search_tokens: searchTokens,
    index_tokens: message.index_tokens
      || message.search_tokens
      || (message.deleted ? [] : tokenizeLegacy(message.text || '')),
  };
}

async function reconcileSearchIndex({
  message,
  ddbSend,
  messagesTable = process.env.MESSAGES_TABLE,
  indexTable = process.env.SEARCH_INDEX_TABLE,
}) {
  const { pk, sk } = message;
  const key = { pk, sk };
  for (let attempt = 0; attempt < MAX_INDEX_RETRIES; attempt += 1) {
    const result = await ddbSend(new GetCommand({
      TableName: messagesTable,
      Key: key,
      ConsistentRead: true,
    }));
    const current = result.Item;
    if (!current || !current.team_id || !current.channel_id || !current.ts) return 0;
    const legacyRevision = current.revision_ts === undefined;
    const revision = Number(current.revision_ts ?? current.ts ?? 0);
    const revisionCondition = legacyRevision
      ? 'attribute_not_exists(revision_ts)'
      : 'revision_ts = :revision';
    const revisionValues = legacyRevision ? {} : { ':revision': current.revision_ts };

    const desired = (current.deleted ? [] : (current.search_tokens || tokenize(current.text || '')))
      .filter(isIndexableToken);
    const indexed = current.index_tokens
      || (current.deleted ? [] : tokenizeLegacy(current.text || ''));
    const tokenSet = new Set([...indexed, ...desired].filter((token) => (
      desired.includes(token)
      || Buffer.byteLength(`workspace#${current.team_id}#token#${token}`) <= 2048
    )));
    const writes = [...tokenSet].map((token) => {
      const indexKey = {
        pk: `workspace#${current.team_id}#token#${token}`,
        sk: `workspace#${current.team_id}#channel#${current.channel_id}#ts#${current.ts}`,
      };
      if (!desired.includes(token)) {
        return { Delete: { TableName: indexTable, Key: indexKey } };
      }
      return {
        Put: {
          TableName: indexTable,
          Item: {
            ...indexKey,
            token,
            team_id: current.team_id,
            message_pk: current.pk,
            message_sk: current.sk,
            ts: current.ts,
            revision_ts: revision,
          },
        },
      };
    });

    try {
      for (let i = 0; i < writes.length; i += MAX_TRANSACTION_WRITES) {
        await ddbSend(new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: messagesTable,
                Key: key,
                ConditionExpression: revisionCondition,
                ...(legacyRevision ? {} : { ExpressionAttributeValues: revisionValues }),
              },
            },
            ...writes.slice(i, i + MAX_TRANSACTION_WRITES),
          ],
        }));
      }
      await ddbSend(new UpdateCommand({
        TableName: messagesTable,
        Key: key,
        UpdateExpression: legacyRevision
          ? 'SET index_tokens = :tokens, revision_ts = :newRevision'
          : 'SET index_tokens = :tokens',
        ConditionExpression: revisionCondition,
        ExpressionAttributeValues: {
          ':tokens': desired,
          ...revisionValues,
          ...(legacyRevision ? { ':newRevision': revision } : {}),
        }
      }));
      return desired.length;
    } catch (error) {
      if (error.name !== 'TransactionCanceledException'
        && error.name !== 'ConditionalCheckFailedException') throw error;
    }
  }

  throw new Error('search index changed concurrently; retry Slack event');
}

function parseSlackTimestamp(value) {
  const timestamp = Number.parseFloat(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function isIgnoredMessageEvent(slackEvent) {
  return Boolean(
    slackEvent.subtype
    || slackEvent.bot_id
    || slackEvent.app_id
    || slackEvent.bot_profile
  );
}

exports.createHandler = createHandler;
exports.isIgnoredMessageEvent = isIgnoredMessageEvent;
exports.toMessageChange = toMessageChange;
exports.writeNewerMessage = writeNewerMessage;
exports.reconcileSearchIndex = reconcileSearchIndex;
exports.main = createHandler({
  getSigningSecret,
  ddbSend: (command) => ddb.send(command),
});
