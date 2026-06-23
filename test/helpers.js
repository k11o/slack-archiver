const crypto = require('crypto');

function signedSlackEvent({ body, signingSecret = 'test-secret', timestamp = Math.floor(Date.now() / 1000) }) {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const base = `v0:${timestamp}:${rawBody}`;
  const signature = 'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');

  return {
    body: rawBody,
    isBase64Encoded: false,
    headers: {
      'content-type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json',
      'x-slack-request-timestamp': String(timestamp),
      'x-slack-signature': signature,
    },
  };
}

module.exports = { signedSlackEvent };
