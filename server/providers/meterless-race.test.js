'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ProviderError } = require('./meterless-runtime');
const { candidateSeqs, countLanes, describeAttempt, runRace } = require('./meterless-race');

/** A fake runtime whose job moves through the given statuses, one per poll. */
function fakeRuntime({ statuses = ['completed'], job = {}, attempts = {}, submitError = null } = {}) {
  const calls = { submit: [], get: 0, attempt: [], cancel: 0 };
  let poll = 0;
  return {
    calls,
    async submitRace(options) {
      calls.submit.push(options);
      if (submitError) throw submitError;
      return { id: 'job_test', job: { id: 'job_test' } };
    },
    async getJob(id) {
      assert.equal(id, 'job_test');
      calls.get += 1;
      const status = statuses[Math.min(poll, statuses.length - 1)];
      poll += 1;
      return { id, status, ...job };
    },
    async getJobAttempt(id, seq) {
      calls.attempt.push(seq);
      const attempt = attempts[seq];
      if (attempt instanceof Error) throw attempt;
      return attempt ?? null;
    },
    async cancelJob() {
      calls.cancel += 1;
      return {};
    }
  };
}

/** A clock the fake sleep advances, so a timeout needs no real waiting. */
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async ms => {
      time += ms;
    }
  };
}

const lane = (name, text, extra = {}) => ({
  lane: name,
  text,
  model: { lane: name, requested: name, resolved: `${name}-resolved`, honored: true },
  ...extra
});

test('submits a best-of-n race and returns the winning attempt, with its lane', async () => {
  const runtime = fakeRuntime({
    statuses: ['running', 'running', 'completed'],
    job: { winner_seq: 3, generated: 4, lane_stats: { 'gpt-4o-mini': {}, 'nemotron-3-5-lightning-3': {}, 'laguna-s-2-1-free': {} } },
    attempts: { 3: lane('gpt-4o-mini', '  The winning summary.  ') }
  });
  const clock = fakeClock();

  const result = await runRace(runtime, {
    messages: [{ role: 'user', content: 'Summarise' }],
    attempts: 4,
    title: 'Summary',
    ...clock
  });

  assert.deepEqual(runtime.calls.submit, [
    { messages: [{ role: 'user', content: 'Summarise' }], attempts: 4, title: 'Summary' }
  ]);
  assert.equal(runtime.calls.get, 3, 'polled until the job completed');
  assert.deepEqual(runtime.calls.attempt, [3], 'only the winner was read');
  assert.equal(result.text, 'The winning summary.');
  assert.equal(result.lane, 'gpt-4o-mini');
  assert.equal(result.model, 'gpt-4o-mini-resolved');
  assert.equal(result.jobId, 'job_test');
  assert.equal(result.seq, 3);
  assert.equal(result.attempts, 4);
  assert.equal(result.lanes, 3);
  assert.equal(result.partial, false);
  assert.equal(runtime.calls.cancel, 0);
});

test('without a winner, the first attempt that has an answer is used', async () => {
  const runtime = fakeRuntime({
    job: { winner_seq: null, generated: 3 },
    attempts: {
      1: lane('a', '   '),
      2: new Error('attempt not found'),
      3: lane('c', 'Third wins.')
    }
  });

  const result = await runRace(runtime, { messages: [{ role: 'user', content: 'x' }], attempts: 3, ...fakeClock() });

  assert.equal(result.text, 'Third wins.');
  assert.equal(result.seq, 3);
  assert.deepEqual(runtime.calls.attempt, [1, 2, 3]);
});

test('an attempt the runtime marks as failed is not used', async () => {
  const runtime = fakeRuntime({
    job: { winner_seq: 1, generated: 2 },
    attempts: { 1: lane('a', 'broken', { ok: false }), 2: lane('b', 'fine') }
  });

  const result = await runRace(runtime, { messages: [{ role: 'user', content: 'x' }], attempts: 2, ...fakeClock() });
  assert.equal(result.text, 'fine');
});

test('a race that outlives its deadline is cancelled and the attempts that landed are used', async () => {
  const runtime = fakeRuntime({
    statuses: ['running'],
    job: { generated: 2 },
    attempts: { 1: lane('slow', ''), 2: lane('quick', 'Landed in time.') }
  });

  const result = await runRace(runtime, {
    messages: [{ role: 'user', content: 'x' }],
    attempts: 4,
    timeoutMs: 10_000,
    pollMs: 2_000,
    ...fakeClock()
  });

  assert.equal(runtime.calls.cancel, 1, 'the unwanted race stops spending tokens');
  assert.equal(result.text, 'Landed in time.');
  assert.equal(result.partial, true);
  assert.ok(runtime.calls.get >= 5, 'polled every 2 s until the deadline');
});

test('a race with nothing usable at the deadline is a race_timeout, after cancelling it', async () => {
  const runtime = fakeRuntime({ statuses: ['queued'], job: { generated: 0 } });

  await assert.rejects(
    () =>
      runRace(runtime, {
        messages: [{ role: 'user', content: 'x' }],
        attempts: 2,
        timeoutMs: 6_000,
        pollMs: 2_000,
        ...fakeClock()
      }),
    error => error instanceof ProviderError && error.code === 'race_timeout'
  );
  assert.equal(runtime.calls.cancel, 1);
});

test('a job that errored or was cancelled is a race_failed', async () => {
  for (const status of ['errored', 'failed', 'cancelled']) {
    const runtime = fakeRuntime({ statuses: ['running', status] });
    await assert.rejects(
      () => runRace(runtime, { messages: [{ role: 'user', content: 'x' }], attempts: 2, ...fakeClock() }),
      error => error instanceof ProviderError && error.code === 'race_failed' && error.message.includes(status),
      status
    );
  }
});

test('a completed job whose attempts all lack an answer is a race_empty', async () => {
  const runtime = fakeRuntime({ job: { generated: 2 }, attempts: { 1: lane('a', ''), 2: lane('b', '   ') } });

  await assert.rejects(
    () => runRace(runtime, { messages: [{ role: 'user', content: 'x' }], attempts: 2, ...fakeClock() }),
    error => error instanceof ProviderError && error.code === 'race_empty'
  );
});

test('what the runtime refuses at submit time reaches the caller untouched', async () => {
  const refusal = new ProviderError('invalid_job', 'Meterless Runtime refused the job request: n must be a positive number');
  const runtime = fakeRuntime({ submitError: refusal });

  await assert.rejects(
    () => runRace(runtime, { messages: [{ role: 'user', content: 'x' }], attempts: 2, ...fakeClock() }),
    error => error === refusal
  );
  assert.equal(runtime.calls.get, 0);
});

test('a provider that cannot race says so', async () => {
  await assert.rejects(
    () => runRace({}, { messages: [{ role: 'user', content: 'x' }], attempts: 2 }),
    error => error instanceof ProviderError && error.code === 'race_unsupported'
  );
});

test('candidateSeqs puts the winner and the runner-up first and never repeats a number', () => {
  assert.deepEqual(candidateSeqs({ winner_seq: 3, runner_up_seq: 2, generated: 4 }, 4), [3, 2, 1, 4]);
  assert.deepEqual(candidateSeqs({}, 3), [1, 2, 3]);
  assert.deepEqual(candidateSeqs({ generated: 5 }, 3), [1, 2, 3, 4, 5]);
});

test('describeAttempt and countLanes cope with the shapes the runtime uses', () => {
  assert.deepEqual(describeAttempt({ lane: 'gpt-4o-mini', model: { resolved: 'gpt-4o-mini-2024' } }), {
    lane: 'gpt-4o-mini',
    model: 'gpt-4o-mini-2024'
  });
  assert.deepEqual(describeAttempt({ lane: 'a', model: 'plain-model-id' }), { lane: 'a', model: 'plain-model-id' });
  assert.deepEqual(describeAttempt({ lane: 'only-lane' }), { lane: 'only-lane', model: 'only-lane' });
  assert.deepEqual(describeAttempt(null), { lane: null, model: null });

  assert.equal(countLanes({ lane_stats: { a: {}, b: {} } }), 2);
  assert.equal(countLanes({ lane_stats: [{}, {}, {}] }), 3);
  assert.equal(countLanes({}), null);
});
