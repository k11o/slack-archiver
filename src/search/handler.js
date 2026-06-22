const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
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

exports.main = async (event) => {
  const { rawBody, body } = parseBody(event);
  const signingSecret = await getSigningSecret();
  const ok = verifySlackSignature({
    signingSecret,
    timestamp: event.headers?.['x-slack-request-timestamp'] || event.headers?.['X-Slack-Request-Timestamp'],
    signature: event.headers?.['x-slack-signature'] || event.headers?.['X-Slack-Signature'],
    rawBody,
  });

  if (!ok) return { statusCode: 401, body: 'invalid signature' };

  const query = normalizeText(body.text || '');
  if (!query) {
    return json({ response_type: 'ephemeral', text: '検索語を指定してください。例: `/archive aws lambda`' });
  }

  const tokens = tokenize(query).slice(0, 5);
  const candidates = new Map();

  for (const token of tokens) {
    const result = await ddb.send(new QueryCommand({
      TableName: process.env.SEARCH_INDEX_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `token#${token}` },
      ScanIndexForward: false,
      Limit: 25,
    }));

    for (const item of result.Items || []) {
      const key = `${item.message_pk}|${item.message_sk}`;
      candidates.set(key, { pk: item.message_pk, sk: item.message_sk });
    }
  }

  const messages = [];
  for (const candidate of [...candidates.values()].slice(0, 10)) {
    const result = await ddb.send(new GetCommand({
      TableName: process.env.MESSAGES_TABLE,
      Key: { pk: candidate.pk, sk: candidate.sk },
    }));
    if (result.Item && result.Item.normalized_text.includes(query)) messages.push(result.Item);
  }

  if (!messages.length) {
    return json({ response_type: 'ephemeral', text: `見つかりませんでした: ${query}` });
  }

  return json({
    response_type: 'ephemeral',
    text: messages.map((m) => `• <#${m.channel_id}> ${m.text}`).join('\n'),
  });
};

function json(body) {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}
