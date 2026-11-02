'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createRaceCaller, pickRace } = require('./race-call');

const quiet = { log() {}, warn() {}, error() {} };

function harness({ race, fallbackResult } = {}) {
  const seen = { records: [], begun: [], ended: [], fallbackCalls: [], raceCalls: [] };
  const caller = createRaceCaller({
    runtime: { marker: 'runtime' },
    fallback: async args => {
      seen.fallbackCalls.push(args);
      return fallbackResult ?? { answer: 'plain answer', think: '', entry: { id: 99 }, error: null };
    },
    buildMessages: ({ user, prompt, systemPrompt }) => ({
      system: systemPrompt || `You are ${user.name}`,
      messages: [
        { role: 'system', content: systemPrompt || `You are ${user.name}` },
        { role: 'user', content: prompt }
      ]
    }),
    record: fields => {
      seen.records.push(fields);
      return { id: 7, ...fields };
    },
    activity: {
      begin: details => {
        seen.begun.push(details);
        return `handle-${seen.begun.length}`;
      },
      end: (handle, result) => seen.ended.push({ handle, ...result })
    },
    sanitize: text => {
      const match = /<think>([\s\S]*?)<\/think>/.exec(text);
      return { think: match ? match[1].trim() : '', answer: text.replace(/<think>[\s\S]*?<\/think>/, '').trim() };
    },
    race: async (runtime, options) => {
      seen.raceCalls.push({ runtime, options });
      return race(runtime, options);
    },
    logger: quiet
  });
  return { caller, seen };
}

const user = { id: 'u-1', name: 'Felix', modelName: 'meterless/deep' };
const won = {
  text: 'Summary text.',
  lane: 'gpt-4o-mini',
  model: 'gpt-4o-mini-2024',
  jobId: 'job_9',
  seq: 3,
  attempts: 4,
  lanes: 3,
  partial: false,
  elapsedMs: 12_400
};

test('a won race becomes the answer, logged like a chat call, with the winner on it', async () => {
  const { caller, seen } = harness({ race: async () => won });

  const result = await caller({
    newsId: 'n-1',
    user,
    prompt: 'Summarise the thread',
    systemPrompt: 'You are the summarizer.',
    attempts: 4,
    title: 'Summary · Headline'
  });

  assert.equal(result.answer, 'Summary text.');
  assert.equal(result.error, null);
  assert.equal(result.entry.id, 7);
  assert.deepEqual(result.race, {
    jobId: 'job_9',
    lane: 'gpt-4o-mini',
    model: 'gpt-4o-mini-2024',
    attempts: 4,
    lanes: 3,
    partial: false
  });
  assert.equal(seen.fallbackCalls.length, 0, 'no plain call when the race delivered');

  assert.deepEqual(seen.raceCalls[0].options.messages, [
    { role: 'system', content: 'You are the summarizer.' },
    { role: 'user', content: 'Summarise the thread' }
  ]);
  assert.equal(seen.raceCalls[0].options.attempts, 4);
  assert.equal(seen.raceCalls[0].options.title, 'Summary · Headline');

  const record = seen.records[0];
  assert.equal(record.model, 'race ×4 → gpt-4o-mini');
  assert.match(record.ask, /^\[system\]\nYou are the summarizer\.\n\n\[user\]\nSummarise the thread$/);
  assert.equal(record.answer, 'Summary text.');
  assert.equal(record.error, null);
  assert.equal(record.userName, 'Felix');

  assert.deepEqual(seen.ended, [{ handle: 'handle-1', ok: true }]);
  assert.equal(seen.begun[0].model, 'race ×4');
});

test('reasoning in the winning text is kept apart from the answer', async () => {
  const { caller, seen } = harness({ race: async () => ({ ...won, text: '<think>weighing it</think>Final summary.' }) });

  const result = await caller({ user, prompt: 'p', attempts: 3 });

  assert.equal(result.answer, 'Final summary.');
  assert.equal(result.think, 'weighing it');
  assert.equal(seen.records[0].think, 'weighing it');
});

test('a race that fails falls back to one ordinary chat call and says no race happened', async () => {
  const { caller, seen } = harness({
    race: async () => {
      throw Object.assign(new Error('timed out'), { code: 'race_timeout' });
    }
  });

  const result = await caller({ newsId: 'n-1', user, prompt: 'p', systemPrompt: 's', attempts: 4 });

  assert.equal(result.answer, 'plain answer');
  assert.equal(result.race, null);
  assert.deepEqual(seen.fallbackCalls, [{ newsId: 'n-1', user, prompt: 'p', systemPrompt: 's' }]);
  assert.equal(seen.records.length, 0, 'the fallback logs its own entry');
  assert.deepEqual(seen.ended, [{ handle: 'handle-1', ok: false }], 'the race activity is closed either way');
});

test('a winner that holds only reasoning is not an answer, so the fallback runs', async () => {
  const { caller, seen } = harness({ race: async () => ({ ...won, text: '<think>only thinking</think>' }) });

  const result = await caller({ user, prompt: 'p', attempts: 2 });

  assert.equal(result.answer, 'plain answer');
  assert.equal(result.race, null);
  assert.equal(seen.fallbackCalls.length, 1);
});

test('the fallback failure is passed on as it is, with no race', async () => {
  const failure = { answer: '', think: '', entry: { id: 5 }, error: { code: 'offline', message: 'down', attempts: 3 } };
  const { caller } = harness({
    race: async () => {
      throw new Error('nope');
    },
    fallbackResult: failure
  });

  const result = await caller({ user, prompt: 'p', attempts: 2 });

  assert.equal(result.answer, '');
  assert.deepEqual(result.error, failure.error);
  assert.equal(result.race, null);
});

test('pickRace keeps only safe, bounded fields and needs a job id', () => {
  assert.equal(pickRace(null), null);
  assert.equal(pickRace({ lane: 'x' }), null);
  assert.deepEqual(
    pickRace({ jobId: 'job_1', lane: 'gpt-4o-mini', model: null, attempts: 4, lanes: 0, partial: 'yes', extra: 'dropped' }),
    { jobId: 'job_1', lane: 'gpt-4o-mini', model: null, attempts: 4, lanes: null, partial: false }
  );
  assert.equal(pickRace({ jobId: 'j'.repeat(500) }).jobId.length, 120);
});
