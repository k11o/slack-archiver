const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { parseBody, verifySlackSignature } = require('../common/slack');
const { normalizeText, tokenize } = require('../common/text');

const ssm = new SSMClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

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
    if (!slackEvent || slackEvent.type !== 'message' || isIgnoredMessageEvent(slackEvent)) {
      return { statusCode: 200, body: 'ignored' };
    }

    const teamId = body.team_id || slackEvent.team;
    const channelId = slackEvent.channel;
    const ts = slackEvent.ts;
    const text = slackEvent.text || '';
    const pk = `workspace#${teamId}#channel#${channelId}`;
    const sk = `ts#${ts}`;
    const normalized = normalizeText(text);
    const now = new Date().toISOString();

    await ddbSend(new PutCommand({
      TableName: process.env.MESSAGES_TABLE,
      Item: {
        pk,
        sk,
        message_id: `${teamId}:${channelId}:${ts}`,
        team_id: teamId,
        channel_id: channelId,
        user_id: slackEvent.user,
        subtype: slackEvent.subtype || null,
        bot_id: slackEvent.bot_id || null,
        app_id: slackEvent.app_id || null,
        bot_profile: slackEvent.bot_profile || null,
        ts,
        thread_ts: slackEvent.thread_ts || null,
        text,
        normalized_text: normalized,
        event_id: body.event_id,
        deleted: false,
        created_at: now,
        updated_at: now,
      },
    }));

    const requests = tokenize(text).map((token) => ({
      PutRequest: {
        Item: {
          pk: `token#${token}`,
          sk: `workspace#${teamId}#channel#${channelId}#ts#${ts}`,
          token,
          message_pk: pk,
          message_sk: sk,
          ts,
        },
      },
    }));

    for (let i = 0; i < requests.length; i += 25) {
      await ddbSend(new BatchWriteCommand({
        RequestItems: {
          [process.env.SEARCH_INDEX_TABLE]: requests.slice(i, i + 25),
        },
      }));
    }

    return { statusCode: 200, body: 'ok' };
  };
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
exports.main = createHandler({
  getSigningSecret,
  ddbSend: (command) => ddb.send(command),
});
