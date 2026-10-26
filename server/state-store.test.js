'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_COMMENTS,
  MAX_NEWS,
  createStateStore,
  emptyState,
  normalize
} = require('./state-store');

function tempStateFile(name = 'state.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selo-state-'));
  return { dir, file: path.join(dir, name) };
}

const sample = {
  participantId: 'p-1',
  rssSources: [
    { id: 's-1', name: 'TechCrunch', url: 'https://techcrunch.com/feed/' },
    { id: 's-2', name: 'Habr', url: 'https://habr.com/ru/rss/all/all/' }
  ],
  users: [{ id: 'p-1', name: 'Local User', isAI: false }],
  news: [{ id: 'n-1', title: 'Hello', link: 'https://example.com/1' }],
  comments: [{ id: 'c-1', newsId: 'n-1', text: 'Nice' }]
};

test('a missing file reads as empty state', () => {
  const { file } = tempStateFile();
  const store = createStateStore(file);
  const state = store.read();

  assert.deepEqual(state, emptyState());
  assert.deepEqual(state.rssSources, []);
});

test('writeNow then read round-trips every collection', () => {
  const { dir, file } = tempStateFile();
  const store = createStateStore(file);

  store.writeNow(sample);
  const state = store.read();

  assert.equal(state.participantId, 'p-1');
  assert.deepEqual(state.rssSources.map(source => source.id), ['s-1', 's-2']);
  assert.equal(state.users.length, 1);
  assert.equal(state.news.length, 1);
  assert.equal(state.comments.length, 1);
  assert.equal(typeof state.updatedAt, 'string');

  // Atomic write: no tmp file left behind.
  assert.deepEqual(
    fs.readdirSync(dir).filter(name => name !== 'state.json'),
    []
  );
});

test('write is debounced and flush persists the last snapshot', () => {
  const { file } = tempStateFile();
  const store = createStateStore(file);

  store.write({ ...sample, rssSources: [] });
  store.write(sample);
  assert.equal(fs.existsSync(file), false, 'nothing is written until the debounce elapses');

  assert.equal(store.flush(), true);
  assert.deepEqual(store.read().rssSources.map(source => source.id), ['s-1', 's-2']);
});

test('a corrupt file does not throw and normalisation drops junk', () => {
  const { file } = tempStateFile();
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(createStateStore(file).read(), emptyState());

  const normalized = normalize({
    rssSources: [{ id: 'ok', url: 'https://example.com/rss' }, { name: 'no url' }, 'nope'],
    users: [{ name: 'no id' }, { id: 'u-1' }],
    news: 'not an array',
    comments: [{ id: 'c-1' }, null],
    participantId: 42
  });

  assert.equal(normalized.rssSources.length, 1);
  assert.equal(normalized.users.length, 1);
  assert.deepEqual(normalized.news, []);
  assert.equal(normalized.comments.length, 1);
  assert.equal(normalized.participantId, null);
});

test('news and comments are capped so the file stays bounded', () => {
  const news = Array.from({ length: MAX_NEWS + 50 }, (_, index) => ({ id: `n-${index}` }));
  const comments = Array.from({ length: MAX_COMMENTS + 50 }, (_, index) => ({ id: `c-${index}` }));
  const state = normalize({ news, comments });

  assert.equal(state.news.length, MAX_NEWS);
  assert.equal(state.comments.length, MAX_COMMENTS);
  // Comments keep the newest ones.
  assert.equal(state.comments.at(-1).id, `c-${comments.length - 1}`);
});

test('SELO_STATE_FILE wins over the default path', () => {
  const { file } = tempStateFile('custom.json');
  const previous = process.env.SELO_STATE_FILE;
  process.env.SELO_STATE_FILE = file;
  try {
    assert.equal(createStateStore().filePath, file);
  } finally {
    if (previous === undefined) delete process.env.SELO_STATE_FILE;
    else process.env.SELO_STATE_FILE = previous;
  }
});
