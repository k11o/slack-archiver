function normalizeText(input) {
  return String(input || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(input) {
  return tokenizeWith(input, isIndexableToken);
}

function tokenizeLegacy(input) {
  return tokenizeWith(input, () => true);
}

function tokenizeWith(input, accepts) {
  const text = normalizeText(input);
  const tokens = new Set();

  for (const match of text.matchAll(/[a-z0-9_./:#@-]{2,}/g)) {
    if (accepts(match[0])) tokens.add(match[0]);
  }

  const japanese = text.replace(/[a-z0-9_./:#@\s-]/g, '');
  for (let i = 0; i < japanese.length - 1; i += 1) {
    tokens.add(japanese.slice(i, i + 2));
  }

  return [...tokens].slice(0, 100);
}

function isIndexableToken(token) {
  // shortcut: tokens over 1 KiB are skipped; hash them if long literals need searchable coverage.
  return typeof token === 'string' && Buffer.byteLength(token) <= 1024;
}

module.exports = { normalizeText, tokenize, tokenizeLegacy, isIndexableToken };
