'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  APP_SETTINGS_LIMITS,
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
  normalizePipeline
} = require('./app-settings');

test('a state file without settings gets the documented defaults', () => {
  assert.deepEqual(normalizeAppSettings({}), { ...DEFAULT_APP_SETTINGS });
  assert.deepEqual(normalizeAppSettings(null), { ...DEFAULT_APP_SETTINGS });
  assert.deepEqual(normalizeAppSettings(undefined), { ...DEFAULT_APP_SETTINGS });
  assert.equal(DEFAULT_APP_SETTINGS.agentsPerNews, 1);
  assert.equal(DEFAULT_APP_SETTINGS.parallelLanes, 1);
  assert.deepEqual(DEFAULT_APP_SETTINGS.pipeline, {
    analyze: true,
    discuss: true,
    summarize: false
  });
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

test('parallelLanes is clamped to 1..5', () => {
  assert.equal(normalizeAppSettings({ parallelLanes: 0 }).parallelLanes, 1);
  assert.equal(normalizeAppSettings({ parallelLanes: 4 }).parallelLanes, 4);
  assert.equal(normalizeAppSettings({ parallelLanes: 99 }).parallelLanes, 5);
  assert.equal(
    normalizeAppSettings({ parallelLanes: -2 }).parallelLanes,
    APP_SETTINGS_LIMITS.parallelLanes.min
  );
});

test('parallelLanes above agentsPerNews raises the roster, never a dead cap', () => {
  const raised = normalizeAppSettings({ agentsPerNews: 1, parallelLanes: 3 });
  assert.equal(raised.agentsPerNews, 3);
  assert.equal(raised.parallelLanes, 3);

  const kept = normalizeAppSettings({ agentsPerNews: 5, parallelLanes: 2 });
  assert.equal(kept.agentsPerNews, 5);
  assert.equal(kept.parallelLanes, 2);
});

test('form strings are understood and unknown keys are dropped', () => {
  const settings = normalizeAppSettings({ agentsPerNews: '4', somethingElse: 'x' });
  assert.deepEqual(settings, {
    agentsPerNews: 4,
    parallelLanes: 1,
    pipeline: { analyze: true, discuss: true, summarize: false },
    raceSummary: false,
    raceAttempts: 5
  });
});

test('a garbage value falls back to the default', () => {
  assert.equal(normalizeAppSettings({ agentsPerNews: 'many' }).agentsPerNews, 1);
  assert.equal(normalizeAppSettings({ agentsPerNews: NaN }).agentsPerNews, 1);
  assert.equal(normalizeAppSettings({ parallelLanes: 'many' }).parallelLanes, 1);
});

test('a partial pipeline update keeps the other phases', () => {
  const settings = normalizeAppSettings({
    pipeline: { summarize: true }
  });
  assert.deepEqual(settings.pipeline, {
    analyze: true,
    discuss: true,
    summarize: true
  });
});

test('pipeline booleans accept strings and fall back on garbage', () => {
  assert.deepEqual(normalizePipeline({ analyze: 'off', discuss: '1', summarize: 'yes' }), {
    analyze: false,
    discuss: true,
    summarize: true
  });
  assert.deepEqual(normalizePipeline({ analyze: 'maybe' }).analyze, true);
  assert.deepEqual(normalizePipeline(null), {
    analyze: true,
    discuss: true,
    summarize: false
  });
});

test('the summary race is off by default and its attempts are clamped to 2..12', () => {
  assert.equal(DEFAULT_APP_SETTINGS.raceSummary, false);
  assert.equal(DEFAULT_APP_SETTINGS.raceAttempts, 5);
  assert.equal(normalizeAppSettings({ raceAttempts: 1 }).raceAttempts, 2);
  assert.equal(normalizeAppSettings({ raceAttempts: 99 }).raceAttempts, 12);
  assert.equal(normalizeAppSettings({ raceAttempts: '6' }).raceAttempts, 6);
  assert.equal(normalizeAppSettings({ raceAttempts: 'lots' }).raceAttempts, 5);
});

test('raceSummary accepts booleans and form strings and falls back on garbage', () => {
  assert.equal(normalizeAppSettings({ raceSummary: true }).raceSummary, true);
  assert.equal(normalizeAppSettings({ raceSummary: 'on' }).raceSummary, true);
  assert.equal(normalizeAppSettings({ raceSummary: 'off' }).raceSummary, false);
  assert.equal(normalizeAppSettings({ raceSummary: 'maybe' }).raceSummary, false);
  // A saved state without the setting keeps working.
  assert.equal(normalizeAppSettings({ agentsPerNews: 2 }).raceSummary, false);
});
