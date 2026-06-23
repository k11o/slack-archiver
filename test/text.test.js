const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeText, tokenize } = require('../src/common/text');

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
