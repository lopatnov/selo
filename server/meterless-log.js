'use strict';

/**
 * In-memory ring buffer of Meterless requests.
 *
 * Every request stores the three parts the operator cares about:
 *   ask   — the full prompt sent to the model (system + user);
 *   think — the reasoning the model returned (never posted as a comment);
 *   answer— the cleaned text that became the comment.
 *
 * The same records are printed to the console and served by
 * `GET /api/meterless/log`, so the UI can show exactly what the console shows.
 */

const MAX_TEXT_LENGTH = 8000;

const REDACTIONS = [
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***'],
  [/([#?]k=)[^\s&#]+/gi, '$1***']
];

function clampText(value) {
  if (typeof value !== 'string') return '';
  let text = value;
  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return `${text.slice(0, MAX_TEXT_LENGTH)}\n…[truncated]`;
  }
  return text;
}

function createMeterlessLog({ limit = 200 } = {}) {
  const entries = [];
  let sequence = 0;

  function push(entry = {}) {
    sequence += 1;
    const record = {
      id: Number.isInteger(entry.id) ? entry.id : sequence,
      at: entry.at || new Date().toISOString(),
      newsId: entry.newsId || null,
      userName: typeof entry.userName === 'string' ? entry.userName : '',
      model: typeof entry.model === 'string' ? entry.model : '',
      durationMs: Number.isFinite(entry.durationMs) ? entry.durationMs : null,
      ask: clampText(entry.ask),
      think: clampText(entry.think),
      answer: clampText(entry.answer),
      error: entry.error ? clampText(entry.error) : null
    };

    entries.unshift(record);
    if (entries.length > limit) entries.length = limit;
    return record;
  }

  function list({ newsId = null, limit: max = null } = {}) {
    let result = newsId ? entries.filter(entry => entry.newsId === newsId) : entries.slice();
    if (Number.isInteger(max) && max > 0) result = result.slice(0, max);
    return result;
  }

  function clear({ newsId = null } = {}) {
    if (!newsId) {
      entries.length = 0;
      return;
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index].newsId === newsId) entries.splice(index, 1);
    }
  }

  return {
    push,
    list,
    clear,
    get size() {
      return entries.length;
    },
    get sequence() {
      return sequence;
    }
  };
}

module.exports = {
  MAX_TEXT_LENGTH,
  clampText,
  createMeterlessLog
};
