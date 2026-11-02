'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { adoptRecords } = require('./state-merge');

function liveState(overrides = {}) {
  return {
    participantId: null,
    rssSources: [],
    users: [],
    news: [],
    comments: [],
    ...overrides
  };
}

const none = { rssSources: [], users: [], news: [], comments: [] };

test('adds the missing records and never touches the ones already held', () => {
  const mine = { id: 'u-1', name: 'mine' };
  const storage = liveState({ users: [mine] });

  adoptRecords(storage, { ...none, users: [{ id: 'u-2', name: 'theirs' }] });

  assert.deepEqual(storage.users.map(user => user.id), ['u-1', 'u-2']);
  assert.equal(storage.users[0], mine);
});

test('a feed already held under another id is not added twice, matched by URL', () => {
  const storage = liveState({ rssSources: [{ id: 'a', url: 'https://example.com/Feed.xml' }] });

  adoptRecords(storage, {
    ...none,
    rssSources: [
      { id: 'b', url: 'https://example.com/feed.xml' },
      { id: 'c', url: 'https://example.com/other.xml' }
    ]
  });

  assert.deepEqual(storage.rssSources.map(source => source.id), ['a', 'c']);
});

test('an article already held under another id is not added twice, matched by link', () => {
  const storage = liveState({ news: [{ id: 'n-1', link: 'https://x/1', fetchedAt: '2026-01-02T00:00:00.000Z' }] });

  adoptRecords(storage, {
    ...none,
    news: [
      { id: 'n-2', link: 'https://x/1', fetchedAt: '2026-01-03T00:00:00.000Z' },
      { id: 'n-3', link: 'https://x/3', fetchedAt: '2026-01-04T00:00:00.000Z' },
      { id: 'n-4', fetchedAt: '2026-01-01T00:00:00.000Z' }
    ]
  });

  assert.deepEqual(storage.news.map(item => item.id), ['n-3', 'n-1', 'n-4']);
});

test('news stay newest first and comments oldest first', () => {
  const storage = liveState({
    news: [{ id: 'n-2', link: 'l2', fetchedAt: '2026-01-02T00:00:00.000Z' }],
    comments: [{ id: 'c-2', timestamp: '2026-01-02T00:00:00.000Z' }]
  });

  adoptRecords(storage, {
    ...none,
    news: [
      { id: 'n-3', link: 'l3', fetchedAt: '2026-01-03T00:00:00.000Z' },
      { id: 'n-1', link: 'l1', fetchedAt: '2026-01-01T00:00:00.000Z' }
    ],
    comments: [
      { id: 'c-3', timestamp: '2026-01-03T00:00:00.000Z' },
      { id: 'c-1', timestamp: '2026-01-01T00:00:00.000Z' }
    ]
  });

  assert.deepEqual(storage.news.map(item => item.id), ['n-3', 'n-2', 'n-1']);
  assert.deepEqual(storage.comments.map(comment => comment.id), ['c-1', 'c-2', 'c-3']);
});

test('the participant is taken from Zetaris only when this server has none', () => {
  const withOne = liveState({ participantId: 'mine' });
  adoptRecords(withOne, none, { participantId: 'theirs' });
  assert.equal(withOne.participantId, 'mine');

  const without = liveState();
  adoptRecords(without, none, { participantId: 'theirs' });
  assert.equal(without.participantId, 'theirs');

  adoptRecords(liveState(), none);
});
