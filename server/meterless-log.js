'use strict';

/**
 * Ring buffer of Meterless requests.
 *
 * Every request stores the three parts the operator cares about:
 *   ask   — the full prompt sent to the model (system + user);
 *   think — the reasoning the model returned (never posted as a comment);
 *   answer— the cleaned text that became the comment.
 *
 * The same records are printed to the console and served by
 * `GET /api/meterless/log`, so the UI can show exactly what the console shows.
 *
 * The buffer is persisted to JSON when a `file` is given (the app passes
 * `server/data/meterless-log.json`). It used to be memory-only, which is why
 * the **Ask** / **Thinking** toggles under a comment went empty after every
 * server restart: the comment kept its `logEntryId`, but the entry itself was
 * gone. Without a `file` the log stays in memory, so tests remain hermetic.
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_TEXT_LENGTH = 8000;

const REDACTIONS = [
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***'],
  [/([#?]k=)[^\s&#]+/gi, '$1***']
];

function defaultLogFile() {
  return process.env.SELO_METERLESS_LOG_FILE || path.join(__dirname, 'data', 'meterless-log.json');
}

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

function createMeterlessLog({ limit = 200, file = null } = {}) {
  const entries = [];
  let sequence = 0;

  function readFile() {
    if (!file) return;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`Could not read the Meterless log (${error.code || 'error'}); starting empty.`);
      }
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      const saved = Array.isArray(parsed?.entries) ? parsed.entries : [];
      entries.length = 0;
      for (const entry of saved.slice(0, limit)) {
        if (!entry || typeof entry !== 'object') continue;
        entries.push({
          id: Number.isInteger(entry.id) ? entry.id : entries.length + 1,
          at: typeof entry.at === 'string' ? entry.at : new Date().toISOString(),
          newsId: typeof entry.newsId === 'string' ? entry.newsId : null,
          userName: typeof entry.userName === 'string' ? entry.userName : '',
          model: typeof entry.model === 'string' ? entry.model : '',
          durationMs: Number.isFinite(entry.durationMs) ? entry.durationMs : null,
          ask: typeof entry.ask === 'string' ? entry.ask : '',
          think: typeof entry.think === 'string' ? entry.think : '',
          answer: typeof entry.answer === 'string' ? entry.answer : '',
          error: typeof entry.error === 'string' ? entry.error : null
        });
      }
      const highest = entries.reduce((max, entry) => Math.max(max, entry.id), 0);
      const savedSequence = Number.isInteger(parsed?.sequence) ? parsed.sequence : 0;
      sequence = Math.max(highest, savedSequence);
    } catch {
      console.warn('The Meterless log file is not valid JSON; starting empty.');
    }
  }

  function saveNow() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ sequence, entries }, null, 2)}\n`, {
        mode: 0o600
      });
      fs.renameSync(tmp, file);
    } catch (error) {
      console.error('Could not save the Meterless log:', error.message);
    }
  }

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
    // Written immediately: an entry is created once per model answer (rare),
    // and losing it means losing the only copy of the prompt and the reasoning.
    saveNow();
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
    } else {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index].newsId === newsId) entries.splice(index, 1);
      }
    }
    saveNow();
  }

  /** Kept for callers that flush on shutdown; entries are already on disk. */
  function flush() {
    saveNow();
  }

  readFile();

  return {
    file,
    push,
    list,
    clear,
    flush,
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
  createMeterlessLog,
  defaultLogFile
};
