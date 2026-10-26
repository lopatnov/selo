'use strict';

/**
 * Live checks for the Meterless Runtime provider.
 *
 * 1. A mock OpenAI-compatible runtime is started on MOCK_PORT (default 18090)
 *    so the full HTTP route stack can be exercised without a real model.
 * 2. If a runtime is listening on 127.0.0.1:8088, a deliberately wrong token
 *    must report `unauthorized` (not `offline`) and Auto Detect must find it.
 *
 * Run with: npm run verify:provider
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const express = require('express');

const { createMeterlessRuntime } = require('../server/providers/meterless-runtime');
const { createProvidersRouter } = require('../server/providers/routes');
const { SettingsStore } = require('../server/providers/settings-store');

const MOCK_PORT = Number(process.env.MOCK_PORT || 18090);
const TOKEN = 'rt-verify-only';

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function makeRuntime(dir, name, values) {
  const store = new SettingsStore(path.join(dir, `${name}.json`));
  if (values) store.setMany(values);
  return createMeterlessRuntime({
    settings: store,
    stateDir: dir,
    appId: 'ai-news-discussion'
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selo-provider-check-'));
  const received = [];

  const mock = http.createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers });

    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return;
    }

    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'meterless/auto' }, { id: 'meterless/quantum' }] }));
      return;
    }

    if (req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        const content = `echo:${parsed.messages?.[0]?.content}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await listen(mock, MOCK_PORT);

  const runtime = makeRuntime(dir, 'mock', {
    meterless_base_url: `http://127.0.0.1:${MOCK_PORT}/v1`,
    meterless_runtime_token: TOKEN
  });

  const app = express();
  app.use(express.json());
  app.use('/api/providers', createProvidersRouter({ runtime, providers: [runtime] }));
  const api = http.createServer(app);
  await listen(api, 0);

  const base = `http://127.0.0.1:${api.address().port}/api/providers/meterless`;

  try {
    const status = await (await fetch(base)).json();
    assert.equal(status.status.status, 'online');
    assert.equal(status.hasToken, true);
    assert.equal(status.baseUrl, `http://127.0.0.1:${MOCK_PORT}/v1`);
    console.log(`PASS status online -> ${status.baseUrl}`);

    const models = await (await fetch(`${base}/models`)).json();
    assert.deepEqual(models.models, ['meterless/auto', 'meterless/quantum']);
    console.log(`PASS unknown ids kept -> ${models.models.join(', ')}`);

    const chatResponse = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'meterless/auto',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    });
    assert.equal(chatResponse.status, 200);
    const chat = await chatResponse.json();
    assert.equal(typeof chat.content, 'string');
    assert.equal(chat.content, 'echo:Hello');
    console.log(`PASS plain text chat returns a string -> ${JSON.stringify(chat.content)}`);

    const chatCall = received.find(entry => entry.url === '/v1/chat/completions');
    assert.equal(chatCall.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(chatCall.headers['meterless-app'], 'ai-news-discussion');
    assert.equal(chatCall.headers['meterless-scope'], 'user');
    console.log('PASS bearer + meterless-app + meterless-scope headers');

    const wrongRuntime = makeRuntime(dir, 'wrong', {
      meterless_base_url: 'http://127.0.0.1:8088/v1',
      meterless_runtime_token: 'definitely-wrong'
    });
    const wrongStatus = await wrongRuntime.getStatus();

    if (wrongStatus.status === 'unauthorized') {
      console.log('PASS real runtime on 8088 reports unauthorized for a wrong token');

      const detected = await wrongRuntime.autoDetect();
      assert.equal(detected.found, true);
      assert.equal(detected.status, 'unauthorized');
      assert.equal(detected.baseUrl, 'http://127.0.0.1:8088/v1');
      console.log(`PASS Auto Detect found the runtime -> ${detected.baseUrl} (${detected.status})`);
    } else {
      console.log(
        `SKIP real-runtime checks: 127.0.0.1:8088 answered ${wrongStatus.status}. Start Meterless Runtime to exercise them.`
      );
    }
  } finally {
    await close(api);
    await close(mock);
  }
}

main().catch(error => {
  console.error('FAIL', error.message);
  process.exitCode = 1;
});
