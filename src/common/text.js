function normalizeText(input) {
  return String(input || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(input) {
  const text = normalizeText(input);
  const tokens = new Set();

  for (const match of text.matchAll(/[a-z0-9_./:#@-]{2,}/g)) {
    tokens.add(match[0]);
  }

  const japanese = text.replace(/[a-z0-9_./:#@\s-]/g, '');
  for (let i = 0; i < japanese.length - 1; i += 1) {
    tokens.add(japanese.slice(i, i + 2));
  }

  return [...tokens].slice(0, 100);
}

module.exports = { normalizeText, tokenize };
