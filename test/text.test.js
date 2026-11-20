const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeText, tokenize, tokenizeLegacy } = require('../src/common/text');

test('normalizeText normalizes width, case, and whitespace', () => {
  assert.equal(normalizeText('  ＡＷＳ   Lambda  '), 'aws lambda');
});

test('tokenize emits ASCII terms and Japanese bigrams', () => {
  const tokens = tokenize('AWS Lambda 今日は検索テスト');

  assert.ok(tokens.includes('aws'));
  assert.ok(tokens.includes('lambda'));
  assert.ok(tokens.includes('今日'));
  assert.ok(tokens.includes('検索'));
});

test('tokenize skips ASCII terms too large for DynamoDB partition keys', () => {
  const tokens = tokenize(`${'a'.repeat(1025)} searchable`);
  assert.deepEqual(tokens, ['searchable']);
});

test('legacy tokenization preserves oversized terms so edits can remove old index entries', () => {
  const token = 'a'.repeat(1025);
  assert.deepEqual(tokenizeLegacy(token), [token]);
  assert.deepEqual(tokenize(token), []);
});
