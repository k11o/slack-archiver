const crypto = require('crypto');

function verifySlackSignature({ signingSecret, timestamp, signature, rawBody, maxSkewSeconds = 300 }) {
  if (!signingSecret || !timestamp || !signature || rawBody == null) return false;

  const now = Math.floor(Date.now() / 1000);
  const requestTime = Number(timestamp);
  if (!Number.isFinite(requestTime) || Math.abs(now - requestTime) > maxSkewSeconds) {
    return false;
  }

  const base = `v0:${timestamp}:${rawBody}`;
  const digest = 'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');

  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseBody(event) {
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  const contentType = event.headers?.['content-type'] || event.headers?.['Content-Type'] || '';
  if (contentType.includes('application/json')) {
    return { rawBody, body: JSON.parse(rawBody || '{}') };
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    return { rawBody, body: Object.fromEntries(new URLSearchParams(rawBody)) };
  }

  return { rawBody, body: rawBody };
}

module.exports = { verifySlackSignature, parseBody };
