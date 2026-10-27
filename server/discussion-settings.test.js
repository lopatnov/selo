'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_DISCUSSION_SETTINGS,
  LIMITS,
  canPostMessage,
  nextDelayMs,
  normalizeDiscussionSettings
} = require('./discussion-settings');

test('a user without settings gets the documented defaults', () => {
  assert.deepEqual(normalizeDiscussionSettings({}), { ...DEFAULT_DISCUSSION_SETTINGS });
  assert.deepEqual(normalizeDiscussionSettings(null), { ...DEFAULT_DISCUSSION_SETTINGS });
  assert.deepEqual(normalizeDiscussionSettings(undefined), { ...DEFAULT_DISCUSSION_SETTINGS });
});

test('form strings are parsed and numbers are clamped', () => {
  const settings = normalizeDiscussionSettings({
    sendImmediately: 'false',
    delayMinSec: '-10',
    delayMaxSec: '999999',
    maxMessagesPerNews: '0',
    maxConsecutiveMessages: '0'
  });

  assert.equal(settings.sendImmediately, false);
  assert.equal(settings.delayMinSec, LIMITS.delayMinSec.min);
  assert.equal(settings.delayMaxSec, LIMITS.delayMaxSec.max);
  assert.equal(settings.maxMessagesPerNews, LIMITS.maxMessagesPerNews.min);
  assert.equal(settings.maxConsecutiveMessages, LIMITS.maxConsecutiveMessages.min);
});

test('a reversed delay range is swapped instead of rejected', () => {
  const settings = normalizeDiscussionSettings({ delayMinSec: 40, delayMaxSec: 10 });
  assert.equal(settings.delayMinSec, 10);
  assert.equal(settings.delayMaxSec, 40);
});

test('checkbox values coming from a form are understood', () => {
  for (const value of [true, 'true', '1', 'yes', 'on']) {
    assert.equal(normalizeDiscussionSettings({ sendImmediately: value }).sendImmediately, true);
  }
  for (const value of [false, 'false', '0', 'no', 'off', '']) {
    assert.equal(normalizeDiscussionSettings({ sendImmediately: value }).sendImmediately, false);
  }
});

test('an immediate personality never waits', () => {
  assert.equal(nextDelayMs({ sendImmediately: true, delayMinSec: 30, delayMaxSec: 60 }), 0);
});

test('a paced personality waits inside its own range', () => {
  const settings = { sendImmediately: false, delayMinSec: 10, delayMaxSec: 20 };
  assert.equal(nextDelayMs(settings, () => 0), 10_000);
  assert.equal(nextDelayMs(settings, () => 1), 20_000);
  assert.equal(nextDelayMs(settings, () => 0.5), 15_000);
});

test('a single-value delay range is exact', () => {
  assert.equal(nextDelayMs({ sendImmediately: false, delayMinSec: 7, delayMaxSec: 7 }), 7000);
});

test('canPostMessage enforces per-news and consecutive limits', () => {
  const settings = { maxMessagesPerNews: 3, maxConsecutiveMessages: 2 };

  assert.deepEqual(canPostMessage({ messageCount: 0, consecutiveCount: 0, settings }), {
    allowed: true,
    reason: ''
  });
  assert.deepEqual(canPostMessage({ messageCount: 3, consecutiveCount: 0, settings }), {
    allowed: false,
    reason: 'max_messages_per_news'
  });
  assert.deepEqual(canPostMessage({ messageCount: 1, consecutiveCount: 2, settings }), {
    allowed: false,
    reason: 'max_consecutive_messages'
  });
  assert.equal(canPostMessage({ messageCount: 2, consecutiveCount: 1, settings }).allowed, true);
});
