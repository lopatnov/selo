'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { MAX_TEXT_LENGTH, clampText, createMeterlessLog } = require('./meterless-log');

test('records newest first and keeps only the newest `limit` entries', () => {
  const log = createMeterlessLog({ limit: 2 });

  log.push({ newsId: 'n1', ask: 'a1', answer: 'x' });
  log.push({ newsId: 'n1', ask: 'a2', answer: 'y' });
  const newest = log.push({ newsId: 'n2', ask: 'a3', answer: 'z' });

  const entries = log.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, newest.id);
  assert.deepEqual(entries.map(entry => entry.ask), ['a3', 'a2']);
  assert.equal(log.size, 2);
});

test('entries carry ask / think / answer and the news id', () => {
  const log = createMeterlessLog();

  const entry = log.push({
    newsId: 'news-1',
    userName: 'Alice',
    model: 'meterless/auto',
    durationMs: 1234,
    ask: 'the prompt',
    think: 'the reasoning',
    answer: 'the answer'
  });

  assert.equal(entry.newsId, 'news-1');
  assert.equal(entry.userName, 'Alice');
  assert.equal(entry.model, 'meterless/auto');
  assert.equal(entry.durationMs, 1234);
  assert.equal(entry.ask, 'the prompt');
  assert.equal(entry.think, 'the reasoning');
  assert.equal(entry.answer, 'the answer');
  assert.equal(entry.error, null);
  assert.equal(typeof entry.at, 'string');
});

test('list filters by news id and honours a limit', () => {
  const log = createMeterlessLog();
  log.push({ newsId: 'n1', ask: '1' });
  log.push({ newsId: 'n2', ask: '2' });
  log.push({ newsId: 'n1', ask: '3' });

  assert.deepEqual(log.list({ newsId: 'n1' }).map(entry => entry.ask), ['3', '1']);
  assert.deepEqual(log.list({ newsId: 'n1', limit: 1 }).map(entry => entry.ask), ['3']);
  assert.equal(log.list({ newsId: 'missing' }).length, 0);
});

test('clear removes only the given news id', () => {
  const log = createMeterlessLog();
  log.push({ newsId: 'n1', ask: '1' });
  log.push({ newsId: 'n2', ask: '2' });

  log.clear({ newsId: 'n1' });
  assert.deepEqual(log.list().map(entry => entry.ask), ['2']);

  log.clear();
  assert.equal(log.list().length, 0);
});

test('bearer tokens are redacted and long text is truncated', () => {
  assert.equal(clampText('Authorization: Bearer abc.def-123'), 'Authorization: Bearer ***');
  assert.equal(clampText('http://host:8088/connect#k=secret'), 'http://host:8088/connect#k=***');

  const long = clampText('x'.repeat(MAX_TEXT_LENGTH + 10));
  assert.ok(long.length > MAX_TEXT_LENGTH);
  assert.match(long, /\[truncated\]$/);
});

test('an entry survives a restart when a file is given', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selo-log-'));
  const file = path.join(dir, 'meterless-log.json');

  const first = createMeterlessLog({ limit: 10, file });
  const entry = first.push({
    newsId: 'n1',
    userName: 'Alice',
    model: 'meterless/auto',
    ask: 'the prompt',
    think: 'the reasoning',
    answer: 'the answer'
  });
  first.flush();

  // A fresh process reads the same file: this is what makes the Ask and
  // Thinking toggles work after a restart.
  const second = createMeterlessLog({ limit: 10, file });
  const restored = second.list({ newsId: 'n1' });
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, entry.id);
  assert.equal(restored[0].ask, 'the prompt');
  assert.equal(restored[0].think, 'the reasoning');
  assert.equal(restored[0].answer, 'the answer');

  // New ids keep increasing across restarts.
  const next = second.push({ newsId: 'n1', ask: 'again' });
  assert.ok(next.id > entry.id);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('clear is persisted too, and no file means a private in-memory log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selo-log-'));
  const file = path.join(dir, 'meterless-log.json');

  const first = createMeterlessLog({ limit: 10, file });
  first.push({ newsId: 'n1', ask: 'a' });
  first.clear({ newsId: 'n1' });
  first.flush();
  assert.equal(createMeterlessLog({ limit: 10, file }).list().length, 0);

  // Without a file the log must not leak into the shared data directory.
  const privateLog = createMeterlessLog({ limit: 10 });
  privateLog.push({ newsId: 'n2', ask: 'b' });
  privateLog.flush();
  assert.equal(privateLog.list().length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('non-string fields do not break the record', () => {
  const log = createMeterlessLog();
  const entry = log.push({ ask: undefined, think: null, answer: 42, durationMs: 'nope' });

  assert.equal(entry.ask, '');
  assert.equal(entry.think, '');
  assert.equal(entry.answer, '');
  assert.equal(entry.durationMs, null);
});
