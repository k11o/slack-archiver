const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { verifySlackSignature } = require('../src/common/slack');

test('verifySlackSignature accepts a valid Slack HMAC signature', () => {
  const signingSecret = 'secret';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = 'token=ignored&text=hello';
  const base = `v0:${timestamp}:${rawBody}`;
  const signature = 'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');

  assert.equal(verifySlackSignature({ signingSecret, timestamp, signature, rawBody }), true);
});

test('verifySlackSignature rejects stale timestamps and bad signatures', () => {
  const signingSecret = 'secret';
  const timestamp = String(Math.floor(Date.now() / 1000) - 301);
  const rawBody = 'token=ignored&text=hello';

  assert.equal(verifySlackSignature({
    signingSecret,
    timestamp,
    signature: 'v0=' + '0'.repeat(64),
    rawBody,
  }), false);
});
