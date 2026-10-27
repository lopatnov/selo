'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  APP_SETTINGS_LIMITS,
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings
} = require('./app-settings');

test('a state file without settings gets the documented defaults', () => {
  assert.deepEqual(normalizeAppSettings({}), { ...DEFAULT_APP_SETTINGS });
  assert.deepEqual(normalizeAppSettings(null), { ...DEFAULT_APP_SETTINGS });
  assert.deepEqual(normalizeAppSettings(undefined), { ...DEFAULT_APP_SETTINGS });
  assert.equal(DEFAULT_APP_SETTINGS.agentsPerNews, 1);
});

test('agentsPerNews is clamped to 1..5', () => {
  assert.equal(normalizeAppSettings({ agentsPerNews: 0 }).agentsPerNews, 1);
  assert.equal(normalizeAppSettings({ agentsPerNews: 3 }).agentsPerNews, 3);
  assert.equal(normalizeAppSettings({ agentsPerNews: 99 }).agentsPerNews, 5);
  assert.equal(
    normalizeAppSettings({ agentsPerNews: -4 }).agentsPerNews,
    APP_SETTINGS_LIMITS.agentsPerNews.min
  );
});

test('form strings are understood and unknown keys are dropped', () => {
  const settings = normalizeAppSettings({ agentsPerNews: '4', somethingElse: 'x' });
  assert.deepEqual(settings, { agentsPerNews: 4 });
});

test('a garbage value falls back to the default', () => {
  assert.equal(normalizeAppSettings({ agentsPerNews: 'many' }).agentsPerNews, 1);
  assert.equal(normalizeAppSettings({ agentsPerNews: NaN }).agentsPerNews, 1);
});
