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

async function getSlackChannel({ botToken, channelId, slackRequest = slackApi }) {
  try {
    const payload = await slackRequest({
      botToken,
      method: 'conversations.info',
      params: { channel: channelId },
    });
    return payload.channel || null;
  } catch (error) {
    if (['channel_not_found', 'not_in_channel'].includes(error.slackError)) return null;
    throw error;
  }
}

async function slackApi({ botToken, method, params = {}, fetchImpl = fetch, sleep = wait }) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${botToken}` } });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload.ok) return payload;

    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterSeconds = retryAfterHeader === null ? NaN : Number(retryAfterHeader);
    const rateLimited = response.status === 429 || payload.error === 'ratelimited';
    const error = Object.assign(new Error(`Slack ${method} failed: ${payload.error || response.status}`), {
      statusCode: response.ok ? 502 : response.status,
      slackError: payload.error,
    });
    if (rateLimited && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      error.retryAfterSeconds = retryAfterSeconds;
      if (attempt === 0 && retryAfterSeconds <= 3) {
        await sleep(retryAfterSeconds * 1000);
        continue;
      }
    }
    throw error;
  }
  throw new Error(`Slack ${method} failed after retry`);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

module.exports = { listSlackChannels, getSlackChannel, slackApi };
