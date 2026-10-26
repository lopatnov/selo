'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { isProviderKey, loadEnv } = require('./load-env');

function withTempEnv(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selo-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, contents);
  return file;
}

test('provider keys follow .env even when the OS environment disagrees', () => {
  const file = withTempEnv('ZETARIS_REST_URL=http://127.0.0.1:14088/api/v1.0\nZETARIS_ORG_ID=806\n');

  const saved = {
    ZETARIS_REST_URL: process.env.ZETARIS_REST_URL,
    ZETARIS_ORG_ID: process.env.ZETARIS_ORG_ID
  };
  process.env.ZETARIS_REST_URL = 'http://localhost:8888/api/v1.0';
  delete process.env.ZETARIS_ORG_ID;

  try {
    const result = loadEnv({ path: file });
    assert.equal(process.env.ZETARIS_REST_URL, 'http://127.0.0.1:14088/api/v1.0');
    assert.equal(process.env.ZETARIS_ORG_ID, '806');
    assert.deepEqual(result.overridden, ['ZETARIS_REST_URL']);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('infrastructure keys keep plain dotenv semantics so a harness can inject them', () => {
  const file = withTempEnv('PORT=3001\nSELO_STATE_FILE=/from/dotenv.json\n');

  const saved = { PORT: process.env.PORT, SELO_STATE_FILE: process.env.SELO_STATE_FILE };
  process.env.PORT = '3155';

  try {
    const result = loadEnv({ path: file });
    assert.equal(process.env.PORT, '3155', 'an injected PORT is not overridden');
    assert.equal(process.env.SELO_STATE_FILE, '/from/dotenv.json');
    assert.deepEqual(result.overridden, []);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('a missing .env is not an error', () => {
  const result = loadEnv({ path: path.join(os.tmpdir(), 'selo-env-does-not-exist', '.env') });
  assert.deepEqual(result.parsed, {});
  assert.deepEqual(result.overridden, []);
});

test('isProviderKey covers exactly the Zetaris and Meterless keys', () => {
  assert.equal(isProviderKey('ZETARIS_API_KEY'), true);
  assert.equal(isProviderKey('METERLESS_API_KEY'), true);
  assert.equal(isProviderKey('PORT'), false);
  assert.equal(isProviderKey('SELO_STATE_FILE'), false);
});
