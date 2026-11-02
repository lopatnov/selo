'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createPersistence, hasData } = require('./persistence');
const { emptyState } = require('./state-store');

const quiet = { log() {}, warn() {}, error() {} };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function stateWith(overrides = {}) {
  return { ...emptyState(), ...overrides };
}

/** A local state store that remembers what it was asked to do. */
function fakeLocal(initial = emptyState()) {
  const local = {
    filePath: 'memory://state.json',
    writes: 0,
    flushes: 0,
    mirrored: null,
    read: () => initial,
    write() {
      local.writes += 1;
    },
    flush() {
      local.flushes += 1;
    },
    writeNow(state, options) {
      local.mirrored = { state, options };
    }
  };
  return local;
}

/** A Zetaris store with scripted behaviour. */
function fakeRemote({ stored = null, failWrites = 0, failSchema = 0, hang = false } = {}) {
  const remote = {
    stored,
    schemaCalls: 0,
    saves: [],
    describe: () => ({ database: 'selo', directory: '/file-store/selo', tables: ['users'] }),
    async ensureSchema() {
      remote.schemaCalls += 1;
      if (hang) return new Promise(() => {});
      if (failSchema > 0) {
        failSchema -= 1;
        throw new Error('Zetaris is down');
      }
      return { database: 'selo', created: [] };
    },
    async read() {
      return remote.stored;
    },
    async write(snapshot) {
      if (failWrites > 0) {
        failWrites -= 1;
        throw new Error('Zetaris is down');
      }
      remote.saves.push(snapshot);
      return { savedAt: new Date().toISOString(), uploaded: [], counts: { users: snapshot.users.length } };
    }
  };
  return remote;
}

function build({ local = fakeLocal(), remote = fakeRemote(), snapshot, ...options } = {}) {
  const live = { users: [] };
  const persistence = createPersistence({
    local,
    remote,
    snapshot: snapshot || (() => ({ ...emptyState(), users: live.users, meterlessLog: { sequence: 0, entries: [] } })),
    remoteDebounceMs: 5,
    retryMs: 20,
    bootTimeoutMs: 80,
    logger: quiet,
    ...options
  });
  return { persistence, local, remote, live };
}

test('hasData is true as soon as one collection has a record', () => {
  assert.equal(hasData(emptyState()), false);
  assert.equal(hasData(stateWith({ comments: [{ id: 'c' }] })), true);
  assert.equal(hasData(stateWith({ rssSources: [{ id: 's', url: 'u' }] })), true);
});

test('without Zetaris it is the local file, exactly as before', async () => {
  const saved = stateWith({ users: [{ id: 'u' }], updatedAt: '2026-01-01T00:00:00.000Z' });
  const { persistence, local } = build({ local: fakeLocal(saved), remote: null });

  const { state, source } = await persistence.hydrate();
  assert.equal(state, saved);
  assert.equal(source, 'local');

  persistence.schedule();
  persistence.schedule({ immediate: true });
  await persistence.flush();
  assert.ok(local.writes >= 2);
  assert.ok(local.flushes >= 2);
  assert.equal(persistence.status().backend, 'local');
  assert.equal(persistence.status().health, 'local');
});

test('Zetaris wins at start-up when it is at least as new, and the file is refreshed from it', async () => {
  const remoteState = stateWith({
    users: [{ id: 'from-zetaris' }],
    updatedAt: '2026-02-01T00:00:00.000Z',
    meterlessLog: { sequence: 3, entries: [{ id: 3 }] }
  });
  const { persistence, local, remote } = build({
    local: fakeLocal(stateWith({ users: [{ id: 'from-file' }], updatedAt: '2026-01-01T00:00:00.000Z' })),
    remote: fakeRemote({ stored: remoteState })
  });

  const { state, source } = await persistence.hydrate();
  assert.equal(source, 'zetaris');
  assert.equal(state.users[0].id, 'from-zetaris');
  assert.deepEqual(local.mirrored.options, { keepTimestamp: true });
  assert.equal(local.mirrored.state, remoteState);
  assert.equal(remote.saves.length, 0, 'nothing is pushed back');
  assert.equal(persistence.status().health, 'synced');
  assert.equal(persistence.status().counts.meterless_log, 1);
});

test('an empty Zetaris is filled from the existing local file', async () => {
  const saved = stateWith({ news: [{ id: 'n' }], updatedAt: '2026-01-01T00:00:00.000Z' });
  const { persistence, remote } = build({ local: fakeLocal(saved), remote: fakeRemote({ stored: null }) });

  const { state, source } = await persistence.hydrate();
  assert.equal(source, 'local-migrated');
  assert.equal(state, saved);

  await wait(40);
  assert.equal(remote.saves.length, 1, 'migrated once');
  assert.equal(persistence.status().health, 'synced');
});

test('a local file with only a Meterless log still counts as data to migrate', async () => {
  const { persistence, remote } = build({
    remote: fakeRemote({ stored: null }),
    snapshot: () => ({ ...emptyState(), meterlessLog: { sequence: 1, entries: [{ id: 1 }] } })
  });
  const { source } = await persistence.hydrate();
  assert.equal(source, 'local-migrated');
  await wait(40);
  assert.equal(remote.saves.length, 1);
});

test('both empty is a clean first start', async () => {
  const { persistence, remote } = build({ remote: fakeRemote({ stored: null }) });
  const { source } = await persistence.hydrate();
  assert.equal(source, 'empty');
  await wait(30);
  assert.equal(remote.saves.length, 0);
});

test('a local file newer than Zetaris wins and is pushed (Zetaris was down at the last save)', async () => {
  const { persistence, remote } = build({
    local: fakeLocal(stateWith({ users: [{ id: 'file' }], updatedAt: '2026-03-01T00:00:00.000Z' })),
    remote: fakeRemote({ stored: stateWith({ users: [{ id: 'old' }], updatedAt: '2026-02-01T00:00:00.000Z' }) })
  });

  const { state, source } = await persistence.hydrate();
  assert.equal(source, 'local-newer');
  assert.equal(state.users[0].id, 'file');
  await wait(40);
  assert.equal(remote.saves.length, 1);
});

test('an unreachable Zetaris at start-up falls back to the file and recovers later', async () => {
  const saved = stateWith({ users: [{ id: 'file' }], updatedAt: '2026-01-01T00:00:00.000Z' });
  const remote = fakeRemote({ stored: null, failSchema: 1 });
  const { persistence } = build({ local: fakeLocal(saved), remote });

  const { state, source } = await persistence.hydrate();
  assert.equal(source, 'local-fallback');
  assert.equal(state, saved);
  assert.equal(persistence.status().health, 'degraded');
  assert.match(persistence.status().lastError, /Zetaris is down/);

  // The retry timer reaches Zetaris, sets the schema up and saves.
  await wait(120);
  assert.ok(remote.saves.length >= 1);
  assert.equal(persistence.status().health, 'synced');
  assert.equal(persistence.status().lastError, null);
  assert.equal(persistence.status().source, 'local-resynced');
});

test('a Zetaris that hangs does not keep the app from starting', async () => {
  const remote = fakeRemote({ hang: true });
  const { persistence } = build({ remote, bootTimeoutMs: 30 });

  const started = Date.now();
  const { source } = await persistence.hydrate();
  assert.equal(source, 'local-fallback');
  assert.ok(Date.now() - started < 1000);
  assert.match(persistence.status().lastError, /did not answer within/);
});

test('a burst of changes is one Zetaris write, and always of the latest data', async () => {
  const { persistence, remote, live } = build({ remote: fakeRemote({ stored: null }) });
  await persistence.hydrate();

  for (let i = 1; i <= 25; i += 1) {
    live.users.push({ id: `u-${i}` });
    persistence.schedule();
  }
  await wait(60);

  assert.equal(remote.saves.length, 1);
  assert.equal(remote.saves[0].users.length, 25);
});

test('immediate saves reach Zetaris without waiting for the debounce, and never overlap', async () => {
  const remote = fakeRemote({ stored: null });
  let running = 0;
  let peak = 0;
  const write = remote.write;
  remote.write = async snapshot => {
    running += 1;
    peak = Math.max(peak, running);
    await wait(15);
    const result = await write(snapshot);
    running -= 1;
    return result;
  };
  const { persistence, live } = build({ remote, remoteDebounceMs: 10_000 });
  await persistence.hydrate();

  for (let i = 1; i <= 5; i += 1) {
    live.users.push({ id: `u-${i}` });
    persistence.schedule({ immediate: true });
    await wait(4);
  }
  await wait(80);

  assert.equal(peak, 1);
  assert.equal(remote.saves.at(-1).users.length, 5, 'the last write has everything');
});

test('a refused write keeps the data dirty, is retried, and clears when it works', async () => {
  const remote = fakeRemote({ stored: null, failWrites: 2 });
  const { persistence, local, live } = build({ remote });
  await persistence.hydrate();

  live.users.push({ id: 'u-1' });
  persistence.schedule();
  await wait(20);
  assert.equal(persistence.status().health, 'degraded');
  assert.ok(local.writes >= 1, 'the local file was written regardless');

  await wait(120);
  assert.equal(persistence.status().health, 'synced');
  assert.equal(remote.saves.at(-1).users.length, 1);
});

test('flush writes the file now and waits for Zetaris, but not longer than asked', async () => {
  const remote = fakeRemote({ stored: null });
  const { persistence, local, live } = build({ remote, remoteDebounceMs: 10_000 });
  await persistence.hydrate();

  live.users.push({ id: 'u-1' });
  persistence.schedule();
  await persistence.flush();
  assert.equal(remote.saves.length, 1);
  assert.ok(local.flushes >= 1);

  const stuck = fakeRemote({ stored: null });
  stuck.write = () => new Promise(() => {});
  const second = build({ remote: stuck, remoteDebounceMs: 10_000 });
  await second.persistence.hydrate();
  second.live.users.push({ id: 'u-1' });
  second.persistence.schedule();

  const started = Date.now();
  await second.persistence.flush({ waitMs: 30 });
  assert.ok(Date.now() - started < 1000, 'shutdown is not held hostage by Zetaris');
});

test('status describes where the data lives', async () => {
  const { persistence } = build({ remote: fakeRemote({ stored: null }) });
  await persistence.hydrate();
  const status = persistence.status();
  assert.equal(status.backend, 'zetaris');
  assert.equal(status.database, 'selo');
  assert.equal(status.localFile, 'memory://state.json');
  assert.deepEqual(status.tables, ['users']);
});

test('after a failed start-up, records Zetaris already has are not treated as news', async () => {
  const stored = stateWith({ users: [{ id: 'u-1' }], updatedAt: '2026-05-01T00:00:00.000Z' });
  const remote = fakeRemote({ stored, failSchema: 1 });
  let adopted = 0;
  const { persistence, live } = build({ remote, adopt: () => (adopted += 1) });
  live.users.push({ id: 'u-1' });

  const { source } = await persistence.hydrate();
  assert.equal(source, 'local-fallback');

  await wait(120);
  assert.equal(adopted, 0, 'nothing to adopt');
  assert.ok(remote.saves.length >= 1, 'the save goes through');
  assert.equal(persistence.status().health, 'synced');
});

test('after a failed start-up, records only Zetaris has are adopted before the first save', async () => {
  const stored = stateWith({
    users: [{ id: 'u-1' }, { id: 'u-remote' }],
    comments: [{ id: 'c-remote' }],
    updatedAt: '2026-05-01T00:00:00.000Z'
  });
  const remote = fakeRemote({ stored, failSchema: 1 });
  const calls = [];
  const { persistence, live } = build({
    remote,
    snapshot: undefined,
    adopt: (found, remoteState) => {
      calls.push({ found, remoteState });
      live.users.push(...found.users);
    }
  });
  live.users.push({ id: 'u-1' });

  await persistence.hydrate();
  await wait(120);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].found.users, [{ id: 'u-remote' }]);
  assert.deepEqual(calls[0].found.comments, [{ id: 'c-remote' }]);
  assert.deepEqual(calls[0].found.news, []);
  assert.ok(remote.saves.length >= 1);
  assert.deepEqual(remote.saves.at(-1).users.map(user => user.id), ['u-1', 'u-remote']);
  assert.equal(persistence.status().health, 'synced');
});

test('without a way to adopt them, newer Zetaris records pause saving instead of being overwritten', async () => {
  const stored = stateWith({ users: [{ id: 'u-remote' }], updatedAt: '2026-05-01T00:00:00.000Z' });
  const remote = fakeRemote({ stored, failSchema: 1 });
  const { persistence, local, live } = build({ remote });
  live.users.push({ id: 'u-local' });

  await persistence.hydrate();
  persistence.schedule();
  await wait(120);

  assert.equal(remote.saves.length, 0, 'Zetaris is never written');
  assert.equal(persistence.status().health, 'degraded');
  assert.match(persistence.status().lastError, /saving is paused/);
  assert.ok(local.writes >= 1, 'the local file still keeps every change');
});

test('flush leaves the local file alone when nothing changed', async () => {
  const { persistence, local, live } = build({ remote: fakeRemote({ stored: null }) });
  await persistence.hydrate();

  await persistence.flush();
  assert.equal(local.writes, 0, 'no fresh timestamp on unchanged data');

  live.users.push({ id: 'u-1' });
  persistence.schedule();
  const writes = local.writes;
  await persistence.flush();
  assert.equal(writes, 1);
  assert.ok(local.flushes >= 1, 'a pending change is written');
});

test('nothing is written before the state has been loaded', async () => {
  const remote = fakeRemote({ stored: null });
  const { persistence, local } = build({ remote });

  persistence.schedule();
  persistence.schedule({ immediate: true });
  await persistence.flush();
  await wait(30);

  assert.equal(local.writes, 0);
  assert.equal(local.flushes, 0);
  assert.equal(remote.saves.length, 0);

  await persistence.hydrate();
  persistence.schedule();
  assert.equal(local.writes, 1, 'writing starts once hydrate has finished');
});

function logEntry(id, at = `2026-05-01T00:00:0${id}.000Z`) {
  return { id, at, newsId: null, userName: '', model: '', durationMs: null, ask: '', think: '', answer: '', error: null };
}

function withLog(live, entries, limit = 200) {
  return () => ({
    ...emptyState(),
    users: live.users,
    meterlessLog: { sequence: entries.reduce((max, entry) => Math.max(max, entry.id), 0), limit, entries }
  });
}

test('after a failed start-up, an empty local Meterless log takes the Zetaris one over before the first save', async () => {
  const remoteLog = { sequence: 7, entries: [logEntry(7), logEntry(6)] };
  const stored = stateWith({ updatedAt: '2026-05-01T00:00:00.000Z' });
  stored.meterlessLog = remoteLog;
  const remote = fakeRemote({ stored, failSchema: 1 });
  const live = { users: [] };
  const adopted = [];
  const { persistence } = build({
    remote,
    snapshot: withLog(live, []),
    adopt: (found, remoteState) => adopted.push({ found, remoteState })
  });

  await persistence.hydrate();
  await wait(120);

  assert.equal(adopted.length, 1);
  assert.deepEqual(adopted[0].found.meterlessLog.map(entry => entry.id), [7, 6]);
  assert.equal(adopted[0].remoteState.meterlessLog.sequence, 7);
  assert.ok(remote.saves.length >= 1);
  assert.equal(persistence.status().health, 'synced');
});

test('two Meterless logs that both hold entries cannot be merged, so saving pauses instead of replacing Zetaris', async () => {
  const stored = stateWith({ updatedAt: '2026-05-01T00:00:00.000Z' });
  stored.meterlessLog = { sequence: 9, entries: [logEntry(9), logEntry(8)] };
  const remote = fakeRemote({ stored, failSchema: 1 });
  const live = { users: [] };
  const { persistence } = build({
    remote,
    snapshot: withLog(live, [logEntry(1, '2026-06-01T00:00:00.000Z')]),
    adopt: () => assert.fail('a log with entries must not be overwritten')
  });

  await persistence.hydrate();
  persistence.schedule();
  await wait(120);

  assert.equal(remote.saves.length, 0);
  assert.equal(persistence.status().health, 'degraded');
  assert.match(persistence.status().lastError, /saving is paused/);
});

test('log entries both sides hold, or that a full local log dropped on its own, are not missing', async () => {
  const stored = stateWith({ updatedAt: '2026-05-01T00:00:00.000Z' });
  // Zetaris still has the old entries 1-2; the local log (cap 3) moved on to 3-5.
  stored.meterlessLog = { sequence: 5, entries: [logEntry(2), logEntry(1), logEntry(3)] };
  const remote = fakeRemote({ stored, failSchema: 1 });
  const live = { users: [] };
  const { persistence } = build({
    remote,
    snapshot: withLog(live, [logEntry(5), logEntry(4), logEntry(3)], 3),
    adopt: () => assert.fail('nothing is missing')
  });

  await persistence.hydrate();
  await wait(120);

  assert.ok(remote.saves.length >= 1);
  assert.equal(persistence.status().health, 'synced');
});
