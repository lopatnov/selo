'use strict';

/**
 * Boots the API on a free port and checks the no-login flow end to end.
 *
 *   npm run smoke
 *
 * It proves what the UI relies on:
 *   - no /api/auth/* route exists any more;
 *   - GET /api/participant hands out the local participant (comments work);
 *   - Meterless Runtime status comes back online from the env token;
 *   - Zetaris answers SELECT 1 and refuses a write through /api/zetaris/query;
 *   - the RSS source list is kept in a real file and every source is listed.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.SMOKE_PORT || 3155);
const BASE = `http://127.0.0.1:${PORT}`;
// Never touch the real server/data/state.json from a smoke run.
const STATE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'selo-smoke-')), 'state.json');

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function json(pathname, options) {
  const response = await fetch(`${BASE}${pathname}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function waitForServer(deadlineMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < deadlineMs) {
    try {
      const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await wait(500);
  }
  return false;
}

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), SELO_STATE_FILE: STATE_FILE },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const log = [];
  child.stdout.on('data', chunk => log.push(chunk.toString()));
  child.stderr.on('data', chunk => log.push(chunk.toString()));

  let failures = 0;
  const check = (ok, label, detail = '') => {
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` -> ${detail}` : ''}`);
  };

  try {
    const up = await waitForServer();
    check(up, 'server boots');
    if (!up) {
      console.log(log.join('').slice(-2000));
      return;
    }

    const health = await json('/health');
    check(health.status === 200, 'GET /health', `HTTP ${health.status}`);

    const authRoute = await json('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' })
    });
    check(authRoute.status === 404, 'no login route', `POST /api/auth/login -> HTTP ${authRoute.status}`);

    const participant = await json('/api/participant');
    check(
      participant.status === 200 && Boolean(participant.body?.id),
      'GET /api/participant',
      `${participant.body?.name} / ${participant.body?.id}`
    );

    const providers = await json('/api/providers/meterless');
    check(
      providers.body?.status?.status === 'online',
      'Meterless Runtime status',
      `${providers.body?.status?.status} · token ${providers.body?.tokenSource}${providers.body?.status?.reason ? ` · ${providers.body.status.reason}` : ''}`
    );

    const models = await json('/api/providers/meterless/models');
    check(
      Array.isArray(models.body?.models) && models.body.models.length > 0,
      'Meterless models',
      `${models.body?.models?.length} from ${models.body?.source}`
    );

    const zetaris = await json('/api/zetaris');
    check(
      zetaris.body?.status?.status === 'online',
      'Zetaris status',
      `${zetaris.body?.status?.status} · ${zetaris.body?.restUrl} · org ${zetaris.body?.orgId}${
        zetaris.body?.status?.reason ? ` · ${zetaris.body.status.reason}` : ''
      }`
    );

    const query = await json('/api/zetaris/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT 1 AS one', limit: 5 })
    });
    check(
      query.status === 200 && String(query.body?.rows?.[0]?.[0]) === '1',
      'POST /api/zetaris/query SELECT 1',
      JSON.stringify(query.body?.rows)
    );

    const blocked = await json('/api/zetaris/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'DROP TABLE important' })
    });
    check(blocked.status === 400, 'write through /api/zetaris/query is refused', `HTTP ${blocked.status}`);

    const users = await json('/api/users');
    check(Array.isArray(users.body), 'GET /api/users', `${users.body?.length} user(s)`);

    // RSS sources: real list, real file, every source kept.
    const emptySources = await json('/api/rss-sources');
    check(
      Array.isArray(emptySources.body) && emptySources.body.length === 0,
      'GET /api/rss-sources starts empty',
      `${emptySources.body?.length} source(s)`
    );

    const badUrl = await json('/api/rss-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad', url: 'not-a-url' })
    });
    check(badUrl.status === 400, 'POST /api/rss-sources rejects a non-http url', `HTTP ${badUrl.status}`);

    // 127.0.0.1:9 refuses connections instantly, so the fetch fails fast and the
    // failure is recorded per source instead of breaking the request.
    const first = await json('/api/rss-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'First feed', url: 'http://127.0.0.1:9/rss.xml' })
    });
    check(first.status === 200 && first.body?.id, 'POST /api/rss-sources adds a feed', first.body?.name);

    const second = await json('/api/rss-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Second feed', url: 'http://127.0.0.1:9/other.xml' })
    });
    check(second.status === 200, 'POST /api/rss-sources adds a second feed', second.body?.name);

    const duplicate = await json('/api/rss-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'First again', url: 'http://127.0.0.1:9/rss.xml' })
    });
    check(duplicate.status === 409, 'duplicate feed is refused', `HTTP ${duplicate.status}`);

    const listed = await json('/api/rss-sources');
    check(
      listed.body?.length === 2,
      'both feeds are kept in the list',
      listed.body?.map(source => source.name).join(', ')
    );

    const fetched = await json(`/api/rss-sources/${first.body.id}/fetch`, { method: 'POST' });
    check(
      fetched.body?.ok === false && Boolean(fetched.body?.lastError),
      'a failing feed records lastError instead of throwing',
      String(fetched.body?.lastError).slice(0, 60)
    );

    const all = await json('/api/news/fetch', { method: 'POST' });
    check(
      Array.isArray(all.body?.sources) && all.body.sources.length === 2,
      'POST /api/news/fetch polls every source',
      `${all.body?.sources?.length} polled, +${all.body?.added} new`
    );

    const deleted = await json(`/api/rss-sources/${second.body.id}`, { method: 'DELETE' });
    check(deleted.status === 200, 'DELETE /api/rss-sources/:id', `HTTP ${deleted.status}`);

    await wait(700);
    const savedOnDisk = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : null;
    check(
      savedOnDisk?.rssSources?.length === 1,
      'the source list is persisted to the state file',
      savedOnDisk ? `${STATE_FILE} · ${savedOnDisk.rssSources.length} source(s)` : `${STATE_FILE} missing`
    );
  } finally {
    child.kill();
    const tail = log.join('');
    if (failures > 0) console.log(`\n--- server log ---\n${tail.slice(-3000)}`);
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nSmoke test passed.');
  }
}

main().catch(error => {
  console.error('smoke test crashed:', error.message);
  process.exitCode = 1;
});
