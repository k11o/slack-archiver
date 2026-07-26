const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createChannelsHandler,
  createExportHandler,
  createExportStatusHandler,
  createExportWorker,
  csvCell,
  isExportableMessage,
  listSlackChannels,
  writeChannelCsv,
} = require('../src/export/handler');
const { resolveUserId } = require('../src/web/auth');

process.env.MESSAGES_TABLE = 'messages-table';
process.env.EXPORT_JOBS_TABLE = 'export-jobs-table';
process.env.EXPORT_BUCKET = 'export-bucket';

const authenticatedClaims = {
  'custom:slack_team_id': 'T123',
  'custom:slack_user_id': 'U_REQUESTER',
};

test('resolveUserId accepts matching Slack user claims and rejects mismatches', () => {
  assert.equal(resolveUserId({ 'custom:slack_user_id': 'U1' }), 'U1');
  assert.equal(resolveUserId({
    'custom:slack_user_id': 'U1',
    'https://slack.com/user_id': 'U1',
  }), 'U1');
  assert.equal(resolveUserId({
    'custom:slack_user_id': 'U1',
    'https://slack.com/user_id': 'U2',
  }), null);
});

test('listSlackChannels follows Slack pagination and returns a sorted public-channel list', async () => {
  const cursors = [];
  const channels = await listSlackChannels({
    botToken: 'xoxb-token',
    slackRequest: async ({ params }) => {
      cursors.push(params.cursor);
      if (!params.cursor) {
        return {
          channels: [{ id: 'C2', name: 'random', is_archived: false }],
          response_metadata: { next_cursor: 'next' },
        };
      }
      return {
        channels: [{ id: 'C1', name: 'general', is_archived: true }],
        response_metadata: { next_cursor: '' },
      };
    },
  });

  assert.deepEqual(cursors, [undefined, 'next']);
  assert.deepEqual(channels, [
    { id: 'C1', name: 'general', is_archived: true },
    { id: 'C2', name: 'random', is_archived: false },
  ]);
});

test('channel API scopes Slack channel discovery to the authenticated workspace token', async () => {
  const handler = createChannelsHandler({
    verifyAuth: async () => authenticatedClaims,
    loadBotToken: async ({ teamId }) => {
      assert.equal(teamId, 'T123');
      return 'xoxb-token';
    },
    listChannels: async ({ botToken }) => {
      assert.equal(botToken, 'xoxb-token');
      return [{ id: 'C1', name: 'general', is_archived: false }];
    },
  });

  const response = await handler({ headers: {} });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    channels: [{ id: 'C1', name: 'general', is_archived: false }],
  });
});

test('export creation records workspace and owner before invoking the worker', async () => {
  const commands = [];
  const invoked = [];
  const handler = createExportHandler({
    verifyAuth: async () => authenticatedClaims,
    createJobId: () => 'job-1',
    now: () => new Date('2026-07-26T00:00:00.000Z'),
    ddbSend: async (command) => {
      commands.push(command);
      if (command.constructor.name === 'QueryCommand') {
        assert.equal(
          command.input.ExpressionAttributeValues[':pk'],
          'workspace#T123#channel#C123',
        );
        return { Items: [{ team_id: 'T123', channel_name: 'stored-name' }] };
      }
      return {};
    },
    invokeWorker: async (job) => invoked.push(job),
  });

  const response = await handler(jsonEvent({
    channel_id: 'C123',
    channel_name: 'general',
  }));
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 202);
  assert.equal(body.job.job_id, 'job-1');
  assert.equal(body.job.status, 'queued');
  const put = commands.find((command) => command.constructor.name === 'PutCommand');
  assert.equal(put.input.Item.team_id, 'T123');
  assert.equal(put.input.Item.user_id, 'U_REQUESTER');
  assert.equal(put.input.Item.channel_id, 'C123');
  assert.equal(invoked.length, 1);
});

test('export creation rejects channels with no messages in the authenticated workspace', async () => {
  const handler = createExportHandler({
    verifyAuth: async () => authenticatedClaims,
    ddbSend: async () => ({ Items: [] }),
    invokeWorker: async () => {
      throw new Error('missing channels must not invoke a worker');
    },
  });

  const response = await handler(jsonEvent({ channel_id: 'CNOTFOUND' }));

  assert.equal(response.statusCode, 404);
  assert.deepEqual(JSON.parse(response.body), { error: 'channel_not_archived' });
});

test('export status hides jobs owned by another Slack user', async () => {
  const handler = createExportStatusHandler({
    verifyAuth: async () => authenticatedClaims,
    ddbSend: async () => ({
      Item: {
        job_id: 'job-1',
        team_id: 'T123',
        user_id: 'U_OTHER',
        status: 'completed',
        object_key: 'secret.csv',
      },
    }),
    createDownloadUrl: async () => {
      throw new Error('unauthorized jobs must not receive a download URL');
    },
  });

  const response = await handler({ headers: {}, pathParameters: { jobId: 'job-1' } });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(JSON.parse(response.body), { error: 'export_not_found' });
});

test('completed export status returns a short-lived download URL to its owner', async () => {
  const handler = createExportStatusHandler({
    verifyAuth: async () => authenticatedClaims,
    ddbSend: async () => ({
      Item: {
        job_id: 'job-1',
        team_id: 'T123',
        user_id: 'U_REQUESTER',
        channel_id: 'C1',
        channel_name: 'general',
        status: 'completed',
        object_key: 'exports/T123/U_REQUESTER/job-1.csv',
        message_count: 2,
      },
    }),
    createDownloadUrl: async (job) => {
      assert.equal(job.object_key, 'exports/T123/U_REQUESTER/job-1.csv');
      return 'https://download.example/signed';
    },
  });

  const response = await handler({ headers: {}, pathParameters: { jobId: 'job-1' } });
  const job = JSON.parse(response.body).job;

  assert.equal(response.statusCode, 200);
  assert.equal(job.download_url, 'https://download.example/signed');
  assert.equal(job.download_expires_in, 900);
});

test('writeChannelCsv paginates in timestamp order and preserves multiline Japanese text', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'slack-export-test-'));
  const filePath = path.join(directory, 'messages.csv');
  let page = 0;
  try {
    const count = await writeChannelCsv({
      filePath,
      teamId: 'T123',
      channelId: 'C1',
      channelName: 'general',
      userNames: new Map([['U1', 'Alice']]),
      ddbSend: async (command) => {
        assert.equal(command.constructor.name, 'QueryCommand');
        assert.equal(command.input.ScanIndexForward, true);
        page += 1;
        if (page === 1) {
          return {
            Items: [
              message({ ts: '1710000001.000000', text: 'こんにちは,\n"Slack"', user_id: 'U1' }),
              { ...message({ ts: '1710000002.000000', text: 'deleted' }), deleted: true },
              { ...message({ ts: '1710000002.500000', text: 'bot' }), subtype: 'bot_message' },
            ],
            LastEvaluatedKey: { pk: 'page-2' },
          };
        }
        assert.deepEqual(command.input.ExclusiveStartKey, { pk: 'page-2' });
        return {
          Items: [message({ ts: '1710000003.000000', text: 'second', user_id: 'U2' })],
        };
      },
    });
    const csv = await readFile(filePath, 'utf8');

    assert.equal(count, 2);
    assert.equal(page, 2);
    assert.ok(csv.startsWith('\uFEFFworkspace_id,channel_id'));
    assert.match(csv, /"Alice"/);
    assert.match(csv, /"こんにちは,\n""Slack"""/);
    assert.match(csv, /"U2"/);
    assert.doesNotMatch(csv, /deleted/);
    assert.doesNotMatch(csv, /"bot"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('isExportableMessage excludes bot, app, generated, deleted, and cross-workspace rows', () => {
  const input = (overrides = {}) => ({
    message: message(overrides),
    teamId: 'T123',
    channelId: 'C1',
  });
  assert.equal(isExportableMessage(input()), true);
  assert.equal(isExportableMessage(input({ deleted: true })), false);
  assert.equal(isExportableMessage(input({ subtype: 'bot_message' })), false);
  assert.equal(isExportableMessage(input({ app_id: 'A1' })), false);
  assert.equal(isExportableMessage(input({ team_id: 'T_OTHER' })), false);
  assert.equal(isExportableMessage(input({ text: 'Alice の検索: `needle` (1件)' })), false);
});

test('export worker uploads the generated CSV and records completion metadata', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'slack-export-worker-test-'));
  const commands = [];
  const uploads = [];
  try {
    const worker = createExportWorker({
      tempDirectory: directory,
      now: () => new Date('2026-07-26T00:00:00.000Z'),
      loadBotToken: async () => 'xoxb-token',
      loadUserNames: async () => new Map([['U1', 'Alice']]),
      writeCsv: async ({ filePath, userNames }) => {
        assert.equal(userNames.get('U1'), 'Alice');
        await writeFile(filePath, '\uFEFFheader\nrow\n');
        return 1;
      },
      ddbSend: async (command) => {
        commands.push(command);
        return {};
      },
      s3Send: async (command) => {
        uploads.push(command);
        return {};
      },
    });

    const result = await worker({ job: exportJob() });

    assert.deepEqual(result, { job_id: 'job-1', status: 'completed', message_count: 1 });
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].input.Bucket, 'export-bucket');
    assert.equal(uploads[0].input.Key, 'exports/T123/U_REQUESTER/job-1.csv');
    assert.equal(uploads[0].input.ServerSideEncryption, 'AES256');
    const updates = commands.filter((command) => command.constructor.name === 'UpdateCommand');
    assert.equal(updates.length, 2);
    assert.equal(updates[0].input.ExpressionAttributeValues[':status'], 'running');
    assert.equal(updates[1].input.ExpressionAttributeValues[':status'], 'completed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('export worker records a bounded failure when CSV generation fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'slack-export-worker-failure-test-'));
  const commands = [];
  try {
    const worker = createExportWorker({
      tempDirectory: directory,
      loadBotToken: async () => {
        throw new Error('Slack unavailable');
      },
      writeCsv: async () => {
        throw new Error('disk full');
      },
      ddbSend: async (command) => {
        commands.push(command);
        return {};
      },
      s3Send: async () => {
        throw new Error('failed exports must not upload');
      },
    });

    await assert.rejects(worker({ job: exportJob() }), /disk full/);

    const updates = commands.filter((command) => command.constructor.name === 'UpdateCommand');
    assert.equal(updates.length, 2);
    assert.equal(updates[0].input.ExpressionAttributeValues[':status'], 'running');
    assert.equal(updates[1].input.ExpressionAttributeValues[':status'], 'failed');
    assert.equal(updates[1].input.ExpressionAttributeValues[':message'], 'disk full');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('csvCell quotes commas, newlines, and quotes without changing message content', () => {
  assert.equal(csvCell('one,\ntwo "quoted"'), '"one,\ntwo ""quoted"""');
});

test('csvCell prevents archived text from becoming a spreadsheet formula', () => {
  assert.equal(csvCell('=HYPERLINK("https://example.invalid")'), '"\'=HYPERLINK(""https://example.invalid"")"');
  assert.equal(csvCell('@SUM(1,2)'), '"\'@SUM(1,2)"');
});

function jsonEvent(body) {
  return {
    headers: {},
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function message(overrides = {}) {
  return {
    team_id: 'T123',
    channel_id: 'C1',
    ts: '1710000001.000000',
    text: 'hello',
    user_id: 'U1',
    thread_ts: null,
    deleted: false,
    created_at: '2024-03-09T16:00:01.000Z',
    updated_at: '2024-03-09T16:00:01.000Z',
    ...overrides,
  };
}

function exportJob() {
  return {
    job_id: 'job-1',
    team_id: 'T123',
    user_id: 'U_REQUESTER',
    channel_id: 'C1',
    channel_name: 'general',
  };
}
