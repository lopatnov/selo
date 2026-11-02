#!/usr/bin/env node
'use strict';

/**
 * Live check of the Zetaris storage, against the Zetaris in `.env`.
 *
 *   npm run verify:storage
 *
 * It uses a throw-away Lightning database (`selo_verify_<time>`), never the real
 * app database, and removes the database, its tables and its files at the end
 * (pass --keep to inspect them in Zetaris first). Steps:
 *
 *   1. create the database, folder, files and tables (twice: it must be idempotent)
 *   2. save a state full of awkward text (quotes, commas, newlines, backslashes,
 *      Cyrillic, emoji) and more than 100 comments
 *   3. read it back and compare every record
 *   4. overwrite it and read again (the new file must be visible at once)
 *   5. run SQL over the saved data
 */

const assert = require('node:assert/strict');

const { loadEnv } = require('../server/load-env');
loadEnv();

const { createZetaris } = require('../server/zetaris');
const { createZetarisStore, ALL_TABLE_NAMES } = require('../server/zetaris-store');
const { normalize } = require('../server/state-store');
const { normalizeLog } = require('../server/meterless-log');

const KEEP = process.argv.includes('--keep');
const database = `selo_verify_${Date.now().toString(36)}`;
const zetaris = createZetaris();
const store = createZetarisStore({ zetaris, database });

const NASTY = [
  'plain',
  'comma, and "quotes" and \'single\'',
  'two\nlines\r\nand a tab\t.',
  'back\\slash and \\"escaped\\" and trailing\\',
  'Привіт, світе — «ялинка» 🎄 日本語',
  '{"looks":"like json","n":[1,2,3]}',
  '=SUM(A1:A2)',
  ''
];

function buildState(commentCount) {
  const user = {
    id: 'u-1',
    name: 'Ada "the AI" Lovelace',
    role: 'analyst',
    modelName: 'meterless/auto',
    personality: NASTY[3],
    isAI: true,
    maxMessagesPerNews: 3,
    createdAt: '2026-01-01T00:00:00.000Z'
  };
  return {
    participantId: 'u-2',
    rssSources: [
      {
        id: 's-1',
        name: 'Feed, one',
        url: 'https://example.com/feed.xml?a=1&b="2"',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastFetchedAt: '2026-01-02T00:00:00.000Z',
        lastError: null,
        lastItemCount: 3
      }
    ],
    users: [
      user,
      { id: 'u-2', name: 'Local User', modelName: 'human', personality: 'Human participant', isAI: false }
    ],
    news: NASTY.map((text, index) => ({
      id: `n-${index}`,
      sourceId: 's-1',
      sourceName: 'Feed, one',
      title: `Title ${index}: ${text}`,
      content: text.repeat(3),
      link: `https://example.com/${index}`,
      pubDate: 'Mon, 02 Jan 2026 00:00:00 GMT',
      fetchedAt: '2026-01-02T00:00:00.000Z'
    })),
    comments: Array.from({ length: commentCount }, (_, index) => ({
      id: `c-${String(index).padStart(4, '0')}`,
      newsId: `n-${index % NASTY.length}`,
      userId: index % 3 === 0 ? 'u-2' : 'u-1',
      userName: index % 3 === 0 ? 'Local User' : user.name,
      text: `${index}: ${NASTY[index % NASTY.length]}`,
      isAI: index % 3 !== 0,
      timestamp: new Date(Date.UTC(2026, 0, 3, 0, 0, index)).toISOString(),
      ...(index === 4 ? { isError: true, error: { code: 'timeout', message: 'slow', attempts: 2 } } : {})
    })),
    settings: { agentsPerNews: 2 },
    meterlessLog: {
      sequence: 40,
      entries: NASTY.map((text, index) => ({
        id: 40 - index,
        at: '2026-01-03T00:00:00.000Z',
        newsId: `n-${index}`,
        userName: 'Ada',
        model: 'meterless/auto',
        durationMs: 1200 + index,
        ask: `ASK ${text}`,
        think: `THINK ${text}`,
        answer: `ANSWER ${text}`,
        error: index === 2 ? 'timeout, "slow"' : null
      }))
    }
  };
}

let failed = false;
const step = name => console.log(`\n== ${name}`);
const ok = message => console.log(`PASS ${message}`);

async function cleanup() {
  await ALL_TABLE_NAMES.reduce(
    (chain, table) =>
      chain.then(() =>
        zetaris.runSql(`DROP LIGHTNING DATABASE TABLE ${database}.${table}`).catch(() => {})
      ),
    Promise.resolve()
  );
  await zetaris.runSql(`DROP LIGHTNING DATABASE ${database}`).catch(() => {});
  await zetaris.deleteFiles([store.directory], { recursive: true }).catch(() => {});
}

(async () => {
  const config = zetaris.getConfig();
  console.log(`Zetaris ${config.restUrl} · org ${config.orgId} · temporary database ${database}`);

  step('1. schema');
  const first = await store.ensureSchema();
  const byName = (a, b) => a.localeCompare(b);
  assert.deepEqual(first.created.toSorted(byName), ALL_TABLE_NAMES.toSorted(byName));
  ok(`created ${first.created.length} tables in ${first.directory}`);
  const second = await store.ensureSchema();
  assert.deepEqual(second.created, []);
  ok('a second ensureSchema changes nothing');
  assert.equal(await store.read(), null);
  ok('an empty store reads as null');

  step('2-3. save and read back');
  const state = buildState(150);
  const saved = await store.write(state);
  ok(`uploaded ${saved.uploaded.length} file(s), ${saved.bytes} bytes`);
  const unchanged = await store.write(state);
  assert.deepEqual(unchanged.uploaded, ['app_state.csv'], 'only the state marker is rewritten');
  ok('unchanged collections are not uploaded again');

  const back = await store.read();
  const expected = normalize(state);
  assert.deepEqual(back.rssSources, expected.rssSources);
  assert.deepEqual(back.users, expected.users);
  assert.deepEqual(back.news, expected.news);
  assert.deepEqual(back.comments, expected.comments);
  assert.equal(back.comments.length, 150);
  assert.deepEqual(back.meterlessLog, normalizeLog(state.meterlessLog));
  assert.equal(back.meterlessLog.sequence, 40);
  assert.equal(back.participantId, 'u-2');
  assert.equal(back.settings.agentsPerNews, 2);
  assert.equal(back.updatedAt, unchanged.savedAt);
  ok('every record round-trips unchanged, in order (150 comments, the Meterless log, awkward text included)');

  step('4. overwrite');
  const smaller = buildState(3);
  await store.write(smaller);
  const after = await store.read();
  assert.equal(after.comments.length, 3);
  assert.deepEqual(after.comments, normalize(smaller).comments);
  ok('the next read sees the new file, no cache refresh needed');

  await store.write(buildState(150));

  step('5. SQL over the saved data');
  const perUser = await zetaris.runSql(
    `SELECT user_name, count(*) AS comments FROM ${database}.comments GROUP BY user_name ORDER BY comments DESC`
  );
  console.log(JSON.stringify(perUser.headers), JSON.stringify(perUser.rows));
  assert.equal(perUser.rows.length, 2);
  assert.equal(perUser.rows.reduce((sum, row) => sum + Number(row[1]), 0), 150);
  ok('GROUP BY over selo.comments');

  const joined = await zetaris.runSql(
    `SELECT n.title, count(*) AS comments FROM ${database}.comments c JOIN ${database}.news n ON c.news_id = n.id ` +
      `WHERE c.is_error = 'false' GROUP BY n.title ORDER BY comments DESC LIMIT 3`
  );
  console.log(JSON.stringify(joined.headers), JSON.stringify(joined.rows));
  assert.ok(joined.rows.length > 0);
  ok('JOIN comments x news');
})()
  .catch(error => {
    failed = true;
    console.error(`\nFAIL ${error?.stack ?? error}`);
  })
  .finally(async () => {
    if (KEEP) {
      console.log(`\nKept database ${database} (folder ${store.directory}). Remove it with DROP LIGHTNING DATABASE.`);
    } else {
      await cleanup();
      console.log(`\nRemoved ${database}.`);
    }
    console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
    process.exit(failed ? 1 : 0);
  });
