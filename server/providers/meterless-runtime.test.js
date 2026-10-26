'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_BASE_URL,
  detectCandidates,
  isConnectLink,
  normalizeBaseUrl,
  parseConnectLink
} = require('./base-url');
const { SettingsStore } = require('./settings-store');
const {
  CHAT_TIMEOUT_MS,
  KEY_BASE_URL,
  KEY_TOKEN,
  ProviderError,
  createMeterlessRuntime,
  isUsableToken
} = require('./meterless-runtime');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'meterless-runtime-'));
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}

function makeRuntime({ fetchImpl, dir = tempDir(), token = 'rt-test', baseUrl = null, env = {} } = {}) {
  const store = new SettingsStore(path.join(dir, 'settings.json'));
  if (token !== null) store.set(KEY_TOKEN, token);
  if (baseUrl) store.set(KEY_BASE_URL, baseUrl);

  const runtime = createMeterlessRuntime({
    settings: store,
    stateDir: dir,
    appId: 'test-app',
    fetchImpl,
    env
  });

  return { runtime, store, dir };
}

test('normalizeBaseUrl always produces <origin>/v1 and never /v1/v1', () => {
  const cases = [
    ['127.0.0.1:8088', 'http://127.0.0.1:8088/v1'],
    ['localhost:8088', 'http://localhost:8088/v1'],
    ['localhost:8088/v1', 'http://localhost:8088/v1'],
    ['http://localhost:8088', 'http://localhost:8088/v1'],
    ['http://localhost:8088/', 'http://localhost:8088/v1'],
    ['http://localhost:8088/v1/', 'http://localhost:8088/v1'],
    ['http://localhost:8088/v1/models', 'http://localhost:8088/v1'],
    ['http://localhost:8088/v1/chat/completions', 'http://localhost:8088/v1'],
    ['http://localhost:8088/healthz', 'http://localhost:8088/v1'],
    ['http://localhost:8088/v1/v1', 'http://localhost:8088/v1'],
    ['https://runtime.example.com/v1/chat/completions', 'https://runtime.example.com/v1'],
    ['[::1]:8088', 'http://[::1]:8088/v1'],
    ['http://[::1]:8088/v1/models', 'http://[::1]:8088/v1'],
    ['//localhost:8088/v1', 'http://localhost:8088/v1'],
    ['  "localhost:8088"  ', 'http://localhost:8088/v1']
  ];

  for (const [input, expected] of cases) {
    const result = normalizeBaseUrl(input);
    assert.equal(result, expected, `normalising ${input}`);
    assert.ok(!result.includes('/v1/v1'), `no /v1/v1 for ${input}`);
  }

  assert.equal(normalizeBaseUrl(DEFAULT_BASE_URL), DEFAULT_BASE_URL);
  assert.throws(() => normalizeBaseUrl(''), error => error.code === 'invalid_url');
  assert.throws(() => normalizeBaseUrl('ftp://localhost:21'), error => error.code === 'invalid_url');
});

test('parseConnectLink takes the origin and the k key; isConnectLink detects it', () => {
  assert.deepEqual(parseConnectLink('http://192.168.1.20:8088/connect#k=secret-key'), {
    baseUrl: 'http://192.168.1.20:8088/v1',
    token: 'secret-key'
  });
  assert.equal(isConnectLink('http://192.168.1.20:8088/connect#k=secret-key'), true);
  assert.equal(isConnectLink('http://192.168.1.20:8088/v1'), false);
  assert.throws(() => parseConnectLink('http://192.168.1.20:8088/connect'), error => {
    return error.code === 'invalid_connect_link';
  });
});

test('detectCandidates covers the contract ports and hosts', () => {
  const candidates = detectCandidates();
  assert.equal(candidates.length, 12);
  assert.equal(candidates[0].baseUrl, 'http://127.0.0.1:8088/v1');
  assert.equal(candidates[3].baseUrl, 'http://127.0.0.1:8090/v1');
  const urls = new Set(candidates.map(candidate => candidate.baseUrl));
  for (const port of [8088, 8090, 8787, 11434]) {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      assert.ok(urls.has(`http://${host}:${port}/v1`), `missing ${host}:${port}`);
    }
  }
});

test('a wrong token is unauthorized, not offline, and sends the app header', async () => {
  const seen = [];
  const { runtime } = makeRuntime({
    token: 'wrong-token',
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return jsonResponse(401, { error: 'unauthorized' });
    }
  });

  const result = await runtime.getStatus();

  assert.equal(result.status, 'unauthorized');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://127.0.0.1:8088/v1/models');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer wrong-token');
  assert.equal(seen[0].init.headers['meterless-app'], 'test-app');
});

test('GET /v1/models decides online, while 200 without meterless ids is offline', async () => {
  const online = makeRuntime({
    fetchImpl: async () =>
      jsonResponse(200, { data: [{ id: 'meterless/auto' }, { id: 'meterless/quantum' }] })
  });
  assert.equal((await online.runtime.getStatus()).status, 'online');

  const noMeterless = makeRuntime({
    fetchImpl: async () => jsonResponse(200, { data: [{ id: 'gpt-4' }] })
  });
  assert.equal((await noMeterless.runtime.getStatus()).status, 'offline');

  const serverError = makeRuntime({ fetchImpl: async () => jsonResponse(500, {}) });
  assert.equal((await serverError.runtime.getStatus()).status, 'offline');

  const unreachable = makeRuntime({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    }
  });
  assert.equal((await unreachable.runtime.getStatus()).status, 'offline');
});

test('a token is not required just to probe status', async () => {
  let headers;
  const { runtime } = makeRuntime({
    token: null,
    fetchImpl: async (url, init) => {
      headers = init.headers;
      return jsonResponse(401, {});
    }
  });

  const result = await runtime.getStatus();
  assert.equal(result.status, 'unauthorized');
  assert.equal(headers.Authorization, undefined);
});

test('autoDetect saves the first online runtime', async () => {
  const requests = [];
  const { runtime, store } = makeRuntime({
    fetchImpl: async url => {
      requests.push(url);
      if (url === 'http://127.0.0.1:8088/v1/models') {
        return jsonResponse(200, { data: [{ id: 'meterless/auto' }] });
      }
      throw new Error('ECONNREFUSED');
    }
  });

  const result = await runtime.autoDetect();

  assert.equal(result.found, true);
  assert.equal(result.baseUrl, 'http://127.0.0.1:8088/v1');
  assert.equal(result.status, 'online');
  assert.equal(requests[0], 'http://127.0.0.1:8088/v1/models');
  assert.equal(store.get(KEY_BASE_URL), 'http://127.0.0.1:8088/v1');
});

test('autoDetect treats an unauthorized runtime as found', async () => {
  const { runtime, store } = makeRuntime({
    fetchImpl: async url => {
      if (url === 'http://127.0.0.1:8090/v1/models') return jsonResponse(401, {});
      throw new Error('ECONNREFUSED');
    }
  });

  const result = await runtime.autoDetect();

  assert.equal(result.found, true);
  assert.equal(result.status, 'unauthorized');
  assert.equal(result.baseUrl, 'http://127.0.0.1:8090/v1');
  assert.equal(store.get(KEY_BASE_URL), 'http://127.0.0.1:8090/v1');
});

test('chat sends bearer + app + scope headers and returns a plain string', async () => {
  let captured;
  const { runtime } = makeRuntime({
    token: 'rt-good',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return jsonResponse(200, { choices: [{ message: { content: 'Hello from the runtime' } }] });
    }
  });

  const content = await runtime.chat({
    model: 'meterless/auto',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 8
  });

  assert.equal(typeof content, 'string');
  assert.equal(content, 'Hello from the runtime');
  assert.equal(captured.url, 'http://127.0.0.1:8088/v1/chat/completions');
  assert.equal(captured.init.headers.Authorization, 'Bearer rt-good');
  assert.equal(captured.init.headers['meterless-app'], 'test-app');
  assert.equal(captured.init.headers['meterless-scope'], 'user');
  assert.equal(captured.init.headers['Content-Type'], 'application/json');

  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'meterless/auto');
  assert.equal(body.max_tokens, 8);
  assert.equal(body.stream, false);
  assert.equal(typeof body.messages[0].content, 'string');
  assert.equal(body.messages[0].content, 'Hello');
  assert.equal(CHAT_TIMEOUT_MS, 180_000);
});

test('chat maps 401 and 403 to unauthorized', async () => {
  for (const status of [401, 403]) {
    const { runtime } = makeRuntime({
      token: 'wrong-token',
      fetchImpl: async () => jsonResponse(status, {})
    });

    await assert.rejects(
      () => runtime.chat({ model: 'meterless/auto', messages: [] }),
      error => error instanceof ProviderError && error.code === 'unauthorized'
    );
  }
});

test('listModels keeps unknown meterless ids and drops unrelated models', async () => {
  const { runtime } = makeRuntime({
    fetchImpl: async () =>
      jsonResponse(200, {
        data: [{ id: 'meterless/auto' }, { id: 'gpt-4' }, { id: 'meterless/quantum' }]
      })
  });

  const result = await runtime.listModels();
  assert.equal(result.status, 'online');
  assert.deepEqual(result.models, ['meterless/auto', 'meterless/quantum']);
});

test('the token starts from the environment when nothing is saved', () => {
  const dir = tempDir();

  const fromApiKey = makeRuntime({
    dir,
    token: null,
    env: { METERLESS_API_KEY: 'rt-from-api-key' },
    fetchImpl: async () => jsonResponse(401, {})
  });
  assert.deepEqual(fromApiKey.runtime.resolveToken(), {
    token: 'rt-from-api-key',
    source: 'env',
    envVar: 'METERLESS_API_KEY'
  });
  assert.equal(fromApiKey.runtime.getConfig().tokenSource, 'env');
  assert.equal(fromApiKey.runtime.getConfig().tokenEnvVar, 'METERLESS_API_KEY');
  assert.equal(fromApiKey.runtime.getConfig().hasToken, true);

  // The runtime's own variable wins over the hosted-endpoint key.
  const fromRuntimeToken = makeRuntime({
    dir: tempDir(),
    token: null,
    env: { METERLESS_RUNTIME_TOKEN: 'rt-native', METERLESS_API_KEY: 'rt-hosted' },
    fetchImpl: async () => jsonResponse(401, {})
  });
  assert.deepEqual(fromRuntimeToken.runtime.resolveToken(), {
    token: 'rt-native',
    source: 'env',
    envVar: 'METERLESS_RUNTIME_TOKEN'
  });

  // A token saved from the UI still wins over the environment.
  const saved = makeRuntime({
    token: 'rt-saved',
    env: { METERLESS_API_KEY: 'rt-from-api-key' },
    fetchImpl: async () => jsonResponse(401, {})
  });
  assert.deepEqual(saved.runtime.resolveToken(), { token: 'rt-saved', source: 'settings' });

  // The placeholder in the environment is ignored, like everywhere else.
  const placeholder = makeRuntime({
    dir: tempDir(),
    token: null,
    env: { METERLESS_API_KEY: 'rt-local' },
    fetchImpl: async () => jsonResponse(401, {})
  });
  assert.deepEqual(placeholder.runtime.resolveToken(), { token: null, source: 'none' });
});

test('rt-local is rejected; proxy-token is discovered; settings token wins', () => {
  const dir = tempDir();
  const store = new SettingsStore(path.join(dir, 'settings.json'));
  const runtime = createMeterlessRuntime({
    settings: store,
    stateDir: dir,
    appId: 'test-app',
    // An empty env keeps the machine's own METERLESS_* variables out of the test.
    env: {},
    fetchImpl: async () => jsonResponse(401, {})
  });

  assert.equal(isUsableToken('rt-local'), false);
  assert.equal(isUsableToken('  '), false);
  assert.equal(isUsableToken('rt-real'), true);
  assert.throws(() => runtime.saveConfig({ token: 'rt-local' }), error => {
    return error instanceof ProviderError && error.code === 'invalid_token';
  });

  fs.writeFileSync(path.join(dir, 'proxy-token'), 'rt-from-file\n');
  assert.deepEqual(runtime.resolveToken(), { token: 'rt-from-file', source: 'proxy-token' });
  assert.equal(runtime.getConfig().hasToken, true);
  assert.equal(runtime.getConfig().tokenSource, 'proxy-token');

  runtime.saveConfig({ token: 'rt-from-settings' });
  assert.deepEqual(runtime.resolveToken(), { token: 'rt-from-settings', source: 'settings' });
  assert.equal(store.get(KEY_TOKEN), 'rt-from-settings');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).meterless_runtime_token, 'rt-from-settings');
});

test('saveConfig normalises the base URL; connect stores origin + key', () => {
  const { runtime, store } = makeRuntime({ token: null });

  runtime.saveConfig({ baseUrl: 'localhost:8787/v1/models' });
  assert.equal(store.get(KEY_BASE_URL), 'http://localhost:8787/v1');
  assert.equal(runtime.getConfig().baseUrl, 'http://localhost:8787/v1');

  runtime.connect('http://10.0.0.5:8787/connect#k=link-key');
  assert.equal(store.get(KEY_BASE_URL), 'http://10.0.0.5:8787/v1');
  assert.equal(store.get(KEY_TOKEN), 'link-key');
  assert.equal(runtime.getConfig().baseUrl, 'http://10.0.0.5:8787/v1');
  assert.equal(runtime.getConfig().hasToken, true);
});
