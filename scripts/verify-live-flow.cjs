'use strict';

/**
 * Throw-away end-to-end check against the real Meterless Runtime.
 *
 *   node scripts/verify-live-flow.cjs
 *
 * It boots an isolated server (its own port and state copy), opens the
 * WebSocket, starts one discussion, waits for every assigned agent to answer,
 * then restarts the server and proves that the **Ask** / **Thinking** records
 * survived the restart.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const PORT = Number(process.env.CHECK_PORT || 3999);
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.join(__dirname, '..');
const stateDir = path.join(root, '.tmp-state');
const stateFile = path.join(stateDir, 'state.json');

fs.mkdirSync(stateDir, { recursive: true });
const seed = path.join(root, 'server', 'data', 'state.json');
if (fs.existsSync(seed)) fs.copyFileSync(seed, stateFile);

let child = null;

function startServer() {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      SELO_STATE_FILE: stateFile,
      SELO_METERLESS_LOG_FILE: path.join(stateDir, 'meterless-log.json'),
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', chunk => console.log(`[server] ${String(chunk).trim()}`));
  child.stderr.on('data', chunk => console.log(`[server:err] ${String(chunk).trim()}`));
  return child;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getJson(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  return false;
}

async function stopServer() {
  if (!child) return;
  const current = child;
  child = null;
  current.kill('SIGTERM');
  await sleep(1200);
  if (current.exitCode === null) current.kill('SIGKILL');
  await sleep(400);
}

async function runDiscussion() {
  console.log('settings:', (await getJson(`${BASE}/api/settings`)).body);

  const news = (await getJson(`${BASE}/api/news`)).body;
  if (!Array.isArray(news) || news.length === 0) throw new Error('no news seeded');
  const target = news.find(item => item.title) || news[0];
  console.log(`target news: ${target.id} — ${String(target.title).slice(0, 70)}`);

  const updated = await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentsPerNews: 2 })
  }).then(response => response.json());
  console.log('settings after PUT:', updated);

  const socket = new WebSocket(`ws://127.0.0.1:${PORT}`);

  const outcome = await new Promise(resolve => {
    let finished = false;
    const heard = new Map();
    let expected = 1;

    const finish = reason => {
      if (finished) return;
      finished = true;
      resolve(reason);
    };

    socket.on('message', raw => {
      const { type, data } = JSON.parse(String(raw));
      if (type === 'new_comment') {
        console.log(
          `[ws] new_comment ${data.userName}${data.isError ? ' (ERROR)' : ''}: ${String(data.text).slice(0, 120)}`
        );
        heard.set(data.userName, data.isError ? 'error' : 'answer');
        if (data.isError) finish('error');
        else if (heard.size >= expected) finish('all agents answered');
        return;
      }
      if (type === 'discussion_status') {
        console.log(
          `[ws] discussion_status active=${data.active} agents=${(data.agents || [])
            .map(agent => `${agent.name}@${agent.model}`)
            .join(', ')}`
        );
        return;
      }
      if (type !== 'settings_updated') {
        console.log(`[ws] ${type}: ${JSON.stringify(data).slice(0, 160)}`);
      }
    });

    socket.on('open', async () => {
      const response = await fetch(`${BASE}/api/discussion/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newsId: target.id })
      });
      const started = await response.json();
      console.log('[start]', response.status, JSON.stringify(started).slice(0, 400));
      expected = Math.max(1, (started.agents || []).length);
    });

    socket.on('error', error => console.error('[ws] error', error.message));

    setTimeout(() => finish('timeout'), 180_000);
  });

  console.log(`\n=== outcome: ${outcome} ===`);

  await fetch(`${BASE}/api/discussion/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newsId: target.id })
  });

  const details = (await getJson(`${BASE}/api/news/${target.id}`)).body;
  const comments = details.comments.map(comment => ({
    user: comment.userName,
    isError: Boolean(comment.isError),
    logEntryId: comment.logEntryId ?? null
  }));
  console.log('agents:', JSON.stringify(details.discussionAgents));
  console.log('skipped:', JSON.stringify(details.discussionSkippedAgents));
  console.log('comments:', JSON.stringify(comments));

  const log = (await getJson(`${BASE}/api/meterless/log?newsId=${target.id}`)).body;
  console.log(
    'log entries:',
    log.entries.map(entry => `#${entry.id} ${entry.userName} ${entry.model} ask=${entry.ask.length}b think=${entry.think.length}b`)
  );

  socket.close();
  return {
    newsId: target.id,
    answered: comments.filter(comment => !comment.isError).length,
    commentCount: details.comments.length
  };
}

async function restartAndCheck(newsId, answered, commentCount) {
  console.log('\n--- restarting the server (state + log come from disk) ---');
  await stopServer();
  startServer();
  if (!(await waitForHealth())) throw new Error('the restarted server did not start');

  const details = (await getJson(`${BASE}/api/news/${newsId}`)).body;
  const withLog = details.comments.filter(comment => comment.logEntryId);
  const log = (await getJson(`${BASE}/api/meterless/log?newsId=${newsId}`)).body;

  console.log(`after restart: ${details.comments.length} comment(s), ${withLog.length} with a log entry`);
  console.log(
    'after restart log entries:',
    log.entries.map(entry => `#${entry.id} ${entry.userName} ask=${entry.ask.length}b think=${entry.think.length}b`)
  );

  const ok =
    answered > 0 &&
    withLog.length > 0 &&
    log.entries.length > 0 &&
    // Nothing was lost: same comments, and every comment that points at a log
    // entry still finds it after the restart.
    details.comments.length === commentCount &&
    withLog.every(comment => log.entries.some(entry => entry.id === comment.logEntryId));

  console.log(ok ? 'PASS: ask/thinking survived the restart' : 'FAIL: ask/thinking were lost on restart');
  return ok;
}

async function main() {
  startServer();
  if (!(await waitForHealth())) throw new Error('server did not start');

  const { newsId, answered, commentCount } = await runDiscussion();
  const ok = await restartAndCheck(newsId, answered, commentCount);
  if (!ok) process.exitCode = 1;
}

main()
  .catch(error => {
    console.error('FAILED:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopServer();
  });
