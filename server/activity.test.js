'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createActivityTracker } = require('./activity');

test('a fresh tracker is empty', () => {
  const tracker = createActivityTracker();
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.inFlight, 0);
  assert.equal(snapshot.completed, 0);
  assert.equal(snapshot.failed, 0);
  assert.deepEqual(snapshot.requests, []);
  assert.deepEqual(snapshot.agents, []);
});

test('an in-flight request is reported per agent and model', () => {
  let now = 1000;
  const tracker = createActivityTracker({ now: () => now });

  const first = tracker.begin({ userName: 'Alice', model: 'meterless/auto', newsId: 'n1' });
  now = 2500;
  const second = tracker.begin({ userName: 'Alice', model: 'meterless/auto', newsId: 'n2' });

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.inFlight, 2);
  assert.equal(snapshot.agents.length, 1);
  assert.equal(snapshot.agents[0].userName, 'Alice');
  assert.equal(snapshot.agents[0].model, 'meterless/auto');
  assert.equal(snapshot.agents[0].inFlight, 2);
  // Elapsed time is measured from each request's own start.
  assert.equal(snapshot.requests[0].elapsedMs, 1500);
  assert.equal(snapshot.requests[1].elapsedMs, 0);

  tracker.end(first, { ok: true });
  tracker.end(second, { ok: false });

  const finished = tracker.snapshot();
  assert.equal(finished.inFlight, 0);
  assert.equal(finished.completed, 1);
  assert.equal(finished.failed, 1);
  assert.equal(finished.agents[0].inFlight, 0);
  assert.equal(finished.agents[0].completed, 1);
  assert.equal(finished.agents[0].failed, 1);
});

test('agents are sorted by live load, then by history', () => {
  const tracker = createActivityTracker();
  const alice = tracker.begin({ userName: 'Alice', model: 'meterless/auto' });
  tracker.end(alice, { ok: true });
  tracker.begin({ userName: 'Bob', model: 'meterless/deep' });

  const snapshot = tracker.snapshot();
  assert.deepEqual(
    snapshot.agents.map(agent => agent.userName),
    ['Bob', 'Alice']
  );
});

test('ending an unknown handle is harmless', () => {
  const tracker = createActivityTracker();
  assert.equal(tracker.end(999), null);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.completed, 0);
  assert.equal(snapshot.failed, 0);
});

test('every change notifies the listener with a fresh snapshot', () => {
  const seen = [];
  const tracker = createActivityTracker({ onChange: snapshot => seen.push(snapshot) });

  const handle = tracker.begin({ userName: 'Alice', model: 'meterless/auto' });
  tracker.end(handle, { ok: true });

  assert.equal(seen.length, 2);
  assert.equal(seen[0].inFlight, 1);
  assert.equal(seen[1].inFlight, 0);
  assert.equal(seen[1].completed, 1);
});

test('a throwing listener never breaks the tracker', () => {
  const tracker = createActivityTracker({
    onChange: () => {
      throw new Error('boom');
    }
  });

  const handle = tracker.begin({ userName: 'Alice', model: 'meterless/auto' });
  tracker.end(handle, { ok: true });
  assert.equal(tracker.snapshot().completed, 1);
});
