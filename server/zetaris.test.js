'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ZetarisError, createZetaris, resolveRestUrl } = require('./zetaris');

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    }
  };
}

function makeClient({ fetchImpl, env = { ZETARIS_API_KEY: 'key-123', ZETARIS_ORG_ID: '806' } } = {}) {
  return createZetaris({ env, fetchImpl, restUrl: 'http://zetaris.test/api/v1.0' });
}

test('resolveRestUrl accepts an origin or a full REST base and never duplicates /api/v1.0', () => {
  assert.equal(
    resolveRestUrl({ ZETARIS_URL: 'http://api:8888', ZETARIS_REST_URL: '' }),
    'http://api:8888/api/v1.0'
  );
  assert.equal(
    resolveRestUrl({ ZETARIS_URL: 'http://api:8888/api/v1.0' }),
    'http://api:8888/api/v1.0'
  );
  assert.equal(resolveRestUrl({ ZETARIS_URL: '127.0.0.1:8888' }), 'http://127.0.0.1:8888/api/v1.0');
  assert.equal(
    resolveRestUrl({ ZETARIS_URL: 'http://api:8888', ZETARIS_REST_URL: 'http://other:9000/api/v1.0' }),
    'http://other:9000/api/v1.0'
  );
});

test('runSql posts the documented body and headers to /sql-editor/sqls/run', async () => {
  let captured;
  const client = makeClient({
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return jsonResponse(200, { headers: ['one'], data: [['1']], total: 1, timeUsed: 12 });
    }
  });

  const result = await client.runSql('SELECT 1 AS one', { limit: 5 });

  assert.equal(captured.url, 'http://zetaris.test/api/v1.0/sql-editor/sqls/run');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.Authorization, 'Bearer key-123');
  assert.equal(captured.init.headers['X-Org-ID'], '806');
  assert.match(captured.init.headers['X-Request-ID'], /^[0-9a-f-]{36}$/);

  const body = JSON.parse(captured.init.body);
  assert.equal(body.sql, 'SELECT 1 AS one');
  assert.equal(body.source, 'SqlEditor');
  assert.equal(body.limit, 5);
  assert.match(body.queryId, /^[0-9a-f-]{36}$/);

  assert.deepEqual(result.rows, [['1']]);
  assert.deepEqual(result.headers, ['one']);
  assert.equal(result.total, 1);
  assert.equal(result.timeUsedMs, 12);
});

test('probe is online only when SELECT 1 returns the value 1', async () => {
  const online = makeClient({
    fetchImpl: async () => jsonResponse(200, { headers: ['one'], data: [['1']], total: 1 })
  });
  const onlineStatus = await online.probe();
  assert.equal(onlineStatus.status, 'online');
  assert.equal(onlineStatus.orgId, '806');

  const empty = makeClient({
    fetchImpl: async () => jsonResponse(200, { headers: ['one'], data: [], total: 0 })
  });
  assert.equal((await empty.probe()).status, 'offline');
});

test('401 and 403 are unauthorized', async () => {
  for (const status of [401, 403]) {
    const client = makeClient({ fetchImpl: async () => jsonResponse(status, { msg: 'nope' }) });
    const result = await client.probe();
    assert.equal(result.status, 'unauthorized');
  }
});

test('HTTP 400 "Not Allowed" is an organisation id problem, not a network problem', async () => {
  const client = makeClient({
    fetchImpl: async () => jsonResponse(400, { msg: 'Not Allowed' })
  });

  const result = await client.probe();
  assert.equal(result.status, 'unauthorized');
  assert.match(result.reason, /X-Org-ID 806/);

  await assert.rejects(
    () => client.runSql('SELECT 1'),
    error => error instanceof ZetarisError && error.code === 'unauthorized'
  );
});

test('a missing key is unconfigured and never reaches the network', async () => {
  let called = false;
  const client = makeClient({
    env: {},
    fetchImpl: async () => {
      called = true;
      return jsonResponse(200, {});
    }
  });

  assert.equal(client.getConfig().hasKey, false);
  const result = await client.probe();
  assert.equal(result.status, 'unconfigured');
  assert.equal(called, false);
});

test('a non-numeric organisation id is refused locally', async () => {
  let called = false;
  const client = makeClient({
    env: { ZETARIS_API_KEY: 'key-123', ZETARIS_ORG_ID: 'zetaris' },
    fetchImpl: async () => {
      called = true;
      return jsonResponse(200, {});
    }
  });

  await assert.rejects(
    () => client.runSql('SELECT 1'),
    error => error instanceof ZetarisError && error.code === 'invalid_org'
  );
  assert.equal(called, false);
  assert.equal((await client.probe()).status, 'unconfigured');
});

test('unreachable Zetaris is offline, and listDatabases uses SHOW LIGHTNING DATABASES', async () => {
  const unreachable = makeClient({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    }
  });
  assert.equal((await unreachable.probe()).status, 'offline');

  let sql;
  const client = makeClient({
    fetchImpl: async (url, init) => {
      sql = JSON.parse(init.body).sql;
      return jsonResponse(200, { headers: ['db_name'], data: [['barthelona_files'], ['POKEAPI_REST']] });
    }
  });

  assert.deepEqual(await client.listDatabases(), ['barthelona_files', 'POKEAPI_REST']);
  assert.equal(sql, 'SHOW LIGHTNING DATABASES');
});
