'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_UI_URL,
  ZetarisError,
  createZetaris,
  resolveRestUrl,
  resolveUiUrl,
  tokenExpiryMs
} = require('./zetaris');

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

test('resolveUiUrl keeps only the origin of ZETARIS_BASE_URL', () => {
  assert.equal(
    resolveUiUrl({ ZETARIS_BASE_URL: 'http://localhost:3000/api/v1.0' }),
    'http://localhost:3000'
  );
  assert.equal(resolveUiUrl({ ZETARIS_BASE_URL: 'localhost:3000/' }), 'http://localhost:3000');
  assert.equal(resolveUiUrl({}), DEFAULT_UI_URL);
});

test('without an API key the client logs in through the UI and reuses the token', async () => {
  const calls = [];
  const client = createZetaris({
    env: {
      ZETARIS_ORG_ID: '806',
      ZETARIS_USERNAME: 'someone@example.com',
      ZETARIS_PASSWORD: 'secret'
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/api/auth/login')) {
        return jsonResponse(200, { idToken: 'header.payload.signature' });
      }
      return jsonResponse(200, { headers: ['one'], data: [['1']], total: 1 });
    },
    restUrl: 'http://zetaris.test/api/v1.0',
    uiUrl: 'http://localhost:3000'
  });

  const config = client.getConfig();
  assert.equal(config.authMode, 'login');
  assert.equal(config.hasKey, false);
  assert.equal(config.hasPassword, true);
  assert.equal(config.keySource, 'login');
  assert.equal(config.uiUrl, 'http://localhost:3000');

  await client.runSql('SELECT 1');
  await client.runSql('SELECT 1');

  const logins = calls.filter(call => call.url.endsWith('/api/auth/login'));
  assert.equal(logins.length, 1, 'the token is cached, not re-requested');
  assert.equal(logins[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(logins[0].init.body), {
    username: 'someone@example.com',
    password: 'secret'
  });

  const queries = calls.filter(call => call.url.endsWith('/sql-editor/sqls/run'));
  assert.equal(queries.length, 2);
  assert.equal(queries[0].init.headers.Authorization, 'Bearer header.payload.signature');
  assert.equal(queries[0].init.headers['X-Org-ID'], '806');
});

test('a login token that expired is refreshed once on 401', async () => {
  let logins = 0;
  let queries = 0;
  const client = createZetaris({
    env: { ZETARIS_ORG_ID: '806', ZETARIS_USERNAME: 'u@example.com', ZETARIS_PASSWORD: 'p' },
    fetchImpl: async url => {
      if (url.endsWith('/api/auth/login')) {
        logins += 1;
        return jsonResponse(200, { idToken: `token-${logins}` });
      }
      queries += 1;
      return queries === 1
        ? jsonResponse(401, { msg: 'expired' })
        : jsonResponse(200, { headers: ['one'], data: [['1']], total: 1 });
    },
    restUrl: 'http://zetaris.test/api/v1.0',
    uiUrl: 'http://localhost:3000'
  });

  const result = await client.runSql('SELECT 1');
  assert.deepEqual(result.rows, [['1']]);
  assert.equal(logins, 2, 'one login, then one refresh');
  assert.equal(queries, 2, 'the query is retried exactly once');
});

test('a rejected login is unauthorized, not offline', async () => {
  const client = createZetaris({
    env: { ZETARIS_ORG_ID: '806', ZETARIS_USERNAME: 'u@example.com', ZETARIS_PASSWORD: 'wrong' },
    fetchImpl: async () => jsonResponse(401, { msg: 'bad credentials' }),
    restUrl: 'http://zetaris.test/api/v1.0',
    uiUrl: 'http://localhost:3000'
  });

  const result = await client.probe();
  assert.equal(result.status, 'unauthorized');
  assert.match(result.reason, /ZETARIS_USERNAME/);
});

test('no key and no credentials says so, and mentions both options', async () => {
  const client = makeClient({ env: { ZETARIS_ORG_ID: '806' } });
  const result = await client.probe();
  assert.equal(result.status, 'unconfigured');
  assert.match(result.reason, /ZETARIS_API_KEY/);
  assert.match(result.reason, /ZETARIS_USERNAME/);
});

test('ZETARIS_USER_AGENT is sent without its .env quotes', async () => {
  let headers;
  const client = createZetaris({
    env: {
      ZETARIS_API_KEY: 'key-123',
      ZETARIS_ORG_ID: '806',
      ZETARIS_USER_AGENT: '"selo dev@example.com"'
    },
    fetchImpl: async (url, init) => {
      headers = init.headers;
      return jsonResponse(200, { headers: ['one'], data: [['1']], total: 1 });
    },
    restUrl: 'http://zetaris.test/api/v1.0'
  });

  assert.equal(client.getConfig().userAgent, 'selo dev@example.com');
  await client.runSql('SELECT 1');
  assert.equal(headers['User-Agent'], 'selo dev@example.com');
});

test('tokenExpiryMs reads exp from a JWT and ignores opaque tokens', () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000 })).toString('base64url');
  assert.equal(tokenExpiryMs(`header.${payload}.signature`), 1_700_000_000_000);
  assert.equal(tokenExpiryMs('opaque-token'), null);
  assert.equal(tokenExpiryMs('not-base64.not-json'), null);
});
