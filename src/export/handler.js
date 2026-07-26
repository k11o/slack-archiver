const { randomUUID } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const { stat, unlink } = require('node:fs/promises');
const { once } = require('node:events');
const path = require('node:path');
const { finished } = require('node:stream/promises');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { isArchiverGeneratedMessage } = require('../search/handler');
const { authenticateWebRequest, verifyCognitoJwt } = require('../web/auth');

const EXPORT_TTL_SECONDS = 24 * 60 * 60;
const DOWNLOAD_URL_SECONDS = 15 * 60;
const CSV_COLUMNS = [
  'workspace_id',
  'channel_id',
  'channel_name',
  'ts',
  'time',
  'user_id',
  'user_name',
  'thread_ts',
  'text',
  'created_at',
  'updated_at',
  'import_source',
];

const ssm = new SSMClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});
const s3 = new S3Client({});
const botTokenCache = new Map();

async function getBotToken({ teamId }) {
  const prefix = process.env.SLACK_BOT_TOKEN_PARAM_PREFIX || '/slack-archiver/workspaces/';
  const name = `${prefix.replace(/\/?$/, '/')}${teamId}/slack-bot-token`;
  if (botTokenCache.has(name)) return botTokenCache.get(name);
  const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  botTokenCache.set(name, result.Parameter.Value);
  return result.Parameter.Value;
}

async function slackApi({ botToken, method, params = {} }) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${botToken}` },
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(`Slack ${method} failed: ${payload.error || response.status}`);
  }
  return payload;
}

async function listSlackChannels({ botToken, slackRequest = slackApi }) {
  const channels = [];
  let cursor;
  do {
    const payload = await slackRequest({
      botToken,
      method: 'conversations.list',
      params: {
        types: 'public_channel',
        exclude_archived: 'false',
        limit: '200',
        cursor,
      },
    });
    for (const channel of payload.channels || []) {
      if (channel.id && channel.name) {
        channels.push({
          id: channel.id,
          name: channel.name,
          is_archived: Boolean(channel.is_archived),
        });
      }
    }
    cursor = payload.response_metadata?.next_cursor || '';
  } while (cursor);
  return channels.sort((a, b) => a.name.localeCompare(b.name));
}

async function listSlackUserNames({ botToken, slackRequest = slackApi }) {
  const names = new Map();
  let cursor;
  do {
    const payload = await slackRequest({
      botToken,
      method: 'users.list',
      params: { limit: '200', cursor },
    });
    for (const user of payload.members || []) {
      if (!user.id) continue;
      const name = user.profile?.display_name_normalized
        || user.profile?.display_name
        || user.profile?.real_name_normalized
        || user.profile?.real_name
        || user.real_name
        || user.name
        || user.id;
      names.set(user.id, sanitizeLabel(name, user.id));
    }
    cursor = payload.response_metadata?.next_cursor || '';
  } while (cursor);
  return names;
}

function createChannelsHandler({
  allowedSlackTeamIds,
  verifyAuth = verifyCognitoJwt,
  loadBotToken = getBotToken,
  listChannels = listSlackChannels,
}) {
  return async (event) => {
    const auth = await authenticateWebRequest({
      event,
      allowedSlackTeamIds,
      verifyAuth,
      requireUser: true,
    });
    if (auth.error) return json({ error: auth.error }, auth.statusCode);

    try {
      const botToken = await loadBotToken({ teamId: auth.teamId });
      return json({ channels: await listChannels({ botToken }) });
    } catch (error) {
      return json({ error: 'channel_list_failed', message: error.message }, 502);
    }
  };
}

function createExportHandler({
  allowedSlackTeamIds,
  verifyAuth = verifyCognitoJwt,
  ddbSend,
  invokeWorker,
  createJobId = randomUUID,
  now = () => new Date(),
}) {
  return async (event) => {
    const auth = await authenticateWebRequest({
      event,
      allowedSlackTeamIds,
      verifyAuth,
      requireUser: true,
    });
    if (auth.error) return json({ error: auth.error }, auth.statusCode);

    const body = parseJsonBody(event);
    if (!body) return json({ error: 'invalid_json' }, 400);
    const channelId = String(body.channel_id || '').trim();
    if (!/^[A-Z0-9]{2,}$/.test(channelId)) {
      return json({ error: 'invalid_channel_id' }, 400);
    }

    const messageResult = await ddbSend(new QueryCommand({
      TableName: process.env.MESSAGES_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': `workspace#${auth.teamId}#channel#${channelId}`,
      },
      Limit: 1,
    }));
    const firstMessage = messageResult.Items?.[0];
    if (!firstMessage || firstMessage.team_id !== auth.teamId) {
      return json({ error: 'channel_not_archived' }, 404);
    }

    const createdAt = now();
    const requestedChannelName = String(body.channel_name || '').trim();
    const job = {
      job_id: createJobId(),
      team_id: auth.teamId,
      user_id: auth.userId,
      channel_id: channelId,
      channel_name: sanitizeLabel(
        requestedChannelName && requestedChannelName !== channelId
          ? requestedChannelName
          : firstMessage.channel_name || channelId,
        channelId,
      ),
      status: 'queued',
      created_at: createdAt.toISOString(),
      updated_at: createdAt.toISOString(),
      expires_at: Math.floor(createdAt.getTime() / 1000) + EXPORT_TTL_SECONDS,
    };
    await ddbSend(new PutCommand({
      TableName: process.env.EXPORT_JOBS_TABLE,
      Item: job,
      ConditionExpression: 'attribute_not_exists(job_id)',
    }));

    try {
      await invokeWorker(job);
    } catch {
      await markJobFailed({
        ddbSend,
        jobId: job.job_id,
        message: 'Failed to start export worker',
        now,
      });
      return json({ error: 'export_start_failed' }, 500);
    }
    return json({ job: publicJob(job) }, 202);
  };
}

function createExportStatusHandler({
  allowedSlackTeamIds,
  verifyAuth = verifyCognitoJwt,
  ddbSend,
  createDownloadUrl,
}) {
  return async (event) => {
    const auth = await authenticateWebRequest({
      event,
      allowedSlackTeamIds,
      verifyAuth,
      requireUser: true,
    });
    if (auth.error) return json({ error: auth.error }, auth.statusCode);

    const jobId = String(event.pathParameters?.jobId || '').trim();
    if (!jobId) return json({ error: 'missing_job_id' }, 400);
    const result = await ddbSend(new GetCommand({
      TableName: process.env.EXPORT_JOBS_TABLE,
      Key: { job_id: jobId },
    }));
    const job = result.Item;
    if (!job || job.team_id !== auth.teamId || job.user_id !== auth.userId) {
      return json({ error: 'export_not_found' }, 404);
    }

    const response = publicJob(job);
    if (job.status === 'completed' && job.object_key) {
      response.download_url = await createDownloadUrl(job);
      response.download_expires_in = DOWNLOAD_URL_SECONDS;
    }
    return json({ job: response });
  };
}

async function invokeExportWorker(job) {
  await lambda.send(new InvokeCommand({
    FunctionName: process.env.EXPORT_WORKER_FUNCTION_NAME,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ job })),
  }));
}

async function createS3DownloadUrl(job) {
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: process.env.EXPORT_BUCKET,
    Key: job.object_key,
  }), { expiresIn: DOWNLOAD_URL_SECONDS });
}

function createExportWorker({
  ddbSend,
  s3Send,
  loadBotToken = getBotToken,
  loadUserNames = listSlackUserNames,
  writeCsv = writeChannelCsv,
  now = () => new Date(),
  tempDirectory = '/tmp',
}) {
  return async (event) => {
    const job = event.job || {};
    const filePath = path.join(tempDirectory, `${job.job_id || 'export'}.csv`);
    try {
      await ddbSend(new UpdateCommand({
        TableName: process.env.EXPORT_JOBS_TABLE,
        Key: { job_id: job.job_id },
        UpdateExpression: 'SET #status = :status, updated_at = :updated',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': 'running',
          ':updated': now().toISOString(),
        },
      }));

      let userNames = new Map();
      try {
        const botToken = await loadBotToken({ teamId: job.team_id });
        userNames = await loadUserNames({ botToken });
      } catch {
        userNames = new Map();
      }

      const messageCount = await writeCsv({
        filePath,
        ddbSend,
        teamId: job.team_id,
        channelId: job.channel_id,
        channelName: job.channel_name,
        userNames,
      });
      const file = await stat(filePath);
      const objectKey = `exports/${job.team_id}/${job.user_id}/${job.job_id}.csv`;
      await s3Send(new PutObjectCommand({
        Bucket: process.env.EXPORT_BUCKET,
        Key: objectKey,
        Body: createReadStream(filePath),
        ContentLength: file.size,
        ContentType: 'text/csv; charset=utf-8',
        ContentDisposition: `attachment; filename="${safeFilename(job.channel_name)}-messages.csv"`,
        ServerSideEncryption: 'AES256',
      }));
      await ddbSend(new UpdateCommand({
        TableName: process.env.EXPORT_JOBS_TABLE,
        Key: { job_id: job.job_id },
        UpdateExpression: 'SET #status = :status, object_key = :objectKey, message_count = :messageCount, file_size = :fileSize, updated_at = :updated REMOVE error_message',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': 'completed',
          ':objectKey': objectKey,
          ':messageCount': messageCount,
          ':fileSize': file.size,
          ':updated': now().toISOString(),
        },
      }));
      return { job_id: job.job_id, status: 'completed', message_count: messageCount };
    } catch (error) {
      await markJobFailed({
        ddbSend,
        jobId: job.job_id,
        message: error.message,
        now,
      });
      throw error;
    } finally {
      await unlink(filePath).catch(() => {});
    }
  };
}

async function writeChannelCsv({
  filePath,
  ddbSend,
  teamId,
  channelId,
  channelName,
  userNames = new Map(),
}) {
  const output = createWriteStream(filePath, { encoding: 'utf8' });
  output.write(`\uFEFF${CSV_COLUMNS.join(',')}\n`);
  let messageCount = 0;
  let exclusiveStartKey;
  try {
    do {
      const input = {
        TableName: process.env.MESSAGES_TABLE,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': `workspace#${teamId}#channel#${channelId}`,
        },
        ScanIndexForward: true,
      };
      if (exclusiveStartKey) input.ExclusiveStartKey = exclusiveStartKey;
      const result = await ddbSend(new QueryCommand(input));
      for (const message of result.Items || []) {
        if (!isExportableMessage({ message, teamId, channelId })) continue;
        const row = {
          workspace_id: teamId,
          channel_id: channelId,
          channel_name: channelName,
          ts: message.ts,
          time: slackTsToIso(message.ts),
          user_id: message.user_id,
          user_name: userNames.get(message.user_id) || message.user_id || '',
          thread_ts: message.thread_ts,
          text: message.text,
          created_at: message.created_at,
          updated_at: message.updated_at,
          import_source: message.import_source || 'slack_events',
        };
        const line = `${CSV_COLUMNS.map((column) => csvCell(row[column])).join(',')}\n`;
        if (!output.write(line)) await once(output, 'drain');
        messageCount += 1;
      }
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    output.end();
    await finished(output);
    return messageCount;
  } catch (error) {
    output.destroy();
    await finished(output).catch(() => {});
    throw error;
  }
}

function isExportableMessage({ message, teamId, channelId }) {
  if (message.team_id !== teamId || message.channel_id !== channelId || message.deleted) return false;
  return !message.subtype
    && !message.bot_id
    && !message.bot_profile
    && !message.app_id
    && !isArchiverGeneratedMessage(message.text);
}

async function markJobFailed({ ddbSend, jobId, message, now = () => new Date() }) {
  if (!jobId) return;
  await ddbSend(new UpdateCommand({
    TableName: process.env.EXPORT_JOBS_TABLE,
    Key: { job_id: jobId },
    UpdateExpression: 'SET #status = :status, error_message = :message, updated_at = :updated',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'failed',
      ':message': String(message || 'Export failed').slice(0, 500),
      ':updated': now().toISOString(),
    },
  }));
}

function parseJsonBody(event) {
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : event.body || '{}';
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function publicJob(job) {
  return {
    job_id: job.job_id,
    channel_id: job.channel_id,
    channel_name: job.channel_name,
    status: job.status,
    message_count: job.message_count,
    file_size: job.file_size,
    error_message: job.error_message,
    created_at: job.created_at,
    updated_at: job.updated_at,
    expires_at: job.expires_at,
  };
}

function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  const spreadsheetSafe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${spreadsheetSafe.replace(/"/g, '""')}"`;
}

function slackTsToIso(ts) {
  const seconds = Number.parseFloat(ts || '0');
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return new Date(seconds * 1000).toISOString();
}

function sanitizeLabel(value, fallback) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 100) || fallback;
}

function safeFilename(value) {
  return String(value || 'channel')
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'channel';
}

function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

exports.CSV_COLUMNS = CSV_COLUMNS;
exports.createChannelsHandler = createChannelsHandler;
exports.createExportHandler = createExportHandler;
exports.createExportStatusHandler = createExportStatusHandler;
exports.createExportWorker = createExportWorker;
exports.csvCell = csvCell;
exports.isExportableMessage = isExportableMessage;
exports.listSlackChannels = listSlackChannels;
exports.listSlackUserNames = listSlackUserNames;
exports.parseJsonBody = parseJsonBody;
exports.safeFilename = safeFilename;
exports.writeChannelCsv = writeChannelCsv;
const channelsHandler = createChannelsHandler({
  allowedSlackTeamIds: process.env.ALLOWED_SLACK_TEAM_IDS,
});
const exportCreateHandler = createExportHandler({
  allowedSlackTeamIds: process.env.ALLOWED_SLACK_TEAM_IDS,
  ddbSend: (command) => ddb.send(command),
  invokeWorker: invokeExportWorker,
});
const exportStatusHandler = createExportStatusHandler({
  allowedSlackTeamIds: process.env.ALLOWED_SLACK_TEAM_IDS,
  ddbSend: (command) => ddb.send(command),
  createDownloadUrl: createS3DownloadUrl,
});
exports.worker = createExportWorker({
  ddbSend: (command) => ddb.send(command),
  s3Send: (command) => s3.send(command),
});
exports.api = async (event) => {
  const method = event.requestContext?.http?.method || '';
  const pathName = event.rawPath || '';
  if (method === 'GET' && pathName.endsWith('/channels')) return channelsHandler(event);
  if (method === 'POST' && pathName.endsWith('/exports')) return exportCreateHandler(event);
  if (method === 'GET' && event.pathParameters?.jobId) return exportStatusHandler(event);
  return json({ error: 'not_found' }, 404);
};
