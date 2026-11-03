'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_ERROR,
  INSIGHTS,
  MAX_PARALLEL,
  ROW_LIMIT,
  createInsights,
  describeFreshness,
  safeError
} = require('./insights');

/** A Zetaris whose answers come from `answer(sql)`; it counts the queries in flight. */
function fakeZetaris(answer) {
  const calls = [];
  const state = { inFlight: 0, peak: 0 };
  return {
    calls,
    state,
    async runSql(sql, options) {
      calls.push({ sql, options });
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      try {
        await new Promise(resolve => setTimeout(resolve, 5));
        return await answer(sql);
      } finally {
        state.inFlight -= 1;
      }
    }
  };
}

const TABLE_ANSWER = { headers: ['name', 'n'], rows: [['a', 3], ['b', null]] };

test('every insight is one read-only, bounded SELECT on the app database', () => {
  const ids = new Set();
  for (const insight of INSIGHTS) {
    assert.ok(!ids.has(insight.id), `duplicate id ${insight.id}`);
    ids.add(insight.id);
    assert.ok(insight.title && insight.description, insight.id);

    const sql = insight.sql('my_db');
    assert.match(sql, /^SELECT\b/i, insight.id);
    assert.ok(!sql.includes(';'), `${insight.id} sends more than one statement`);
    assert.ok(sql.includes('my_db.'), `${insight.id} does not use the database`);
    assert.ok(!/\b(insert|update|delete|drop|create|alter)\b/i.test(sql), insight.id);
    if (insight.kind === 'table') {
      assert.match(sql, /\bLIMIT \d+\s*$/i, `${insight.id} is not bounded`);
      assert.ok(Number.isInteger(insight.bar) && insight.bar >= 1, `${insight.id} needs a bar column`);
    }
  }
});

test('run asks Zetaris every question and keeps the order of the list', async () => {
  const zetaris = fakeZetaris(async () => TABLE_ANSWER);
  const result = await createInsights({ zetaris, database: 'selo' }).run();

  assert.equal(result.database, 'selo');
  assert.equal(Number.isNaN(Date.parse(result.generatedAt)), false);
  assert.deepEqual(
    result.items.map(item => item.id),
    INSIGHTS.map(insight => insight.id)
  );
  assert.equal(zetaris.calls.length, INSIGHTS.length);
  assert.ok(zetaris.calls.every(call => call.options.limit === ROW_LIMIT));

  const first = result.items[0];
  assert.deepEqual(first.columns, ['name', 'n']);
  // Cells arrive as text or null, whatever Zetaris sent.
  assert.deepEqual(first.rows, [['a', '3'], ['b', null]]);
  assert.equal(first.error, null);
  assert.equal(first.sql, INSIGHTS[0].sql('selo'));
});

test('at most MAX_PARALLEL questions are in flight at once', async () => {
  const zetaris = fakeZetaris(async () => TABLE_ANSWER);
  await createInsights({ zetaris, database: 'selo' }).run();

  assert.ok(INSIGHTS.length > MAX_PARALLEL);
  assert.equal(zetaris.state.peak, MAX_PARALLEL);
});

test('a failing question shows a safe error, keeps the detail in the log, and does not stop the others', async () => {
  const failing = INSIGHTS[2];
  const warn = test.mock.method(console, 'warn', () => {});
  const zetaris = fakeZetaris(async sql => {
    if (sql === failing.sql('selo')) throw new Error('Table or view not found: selo.news; body: {"trace":"secret"}');
    return TABLE_ANSWER;
  });
  let result;
  try {
    result = await createInsights({ zetaris, database: 'selo' }).run();
  } finally {
    warn.mock.restore();
  }

  const broken = result.items.find(item => item.id === failing.id);
  assert.equal(broken.error, DEFAULT_ERROR);
  assert.ok(!JSON.stringify(broken).includes('secret'), 'the upstream body must not reach the page');
  assert.deepEqual(broken.rows, []);
  assert.deepEqual(broken.columns, []);
  assert.equal(result.items.filter(item => item.error === null).length, INSIGHTS.length - 1);

  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /"busiest-news" failed: Table or view not found/);
});

test('safeError names a refused key or an unreachable Zetaris and nothing else', () => {
  assert.equal(safeError({ code: 'unauthorized', message: 'key abc rejected' }), 'Zetaris rejected the API key.');
  assert.equal(safeError({ code: 'offline', message: 'ECONNREFUSED 10.0.0.5' }), 'Zetaris is not reachable.');
  for (const error of [{ code: 'invalid_request', message: 'SQL error near x' }, new Error('boom'), null, undefined]) {
    assert.equal(safeError(error), DEFAULT_ERROR);
  }
  // A code that happens to be a property name of Object is not a known code.
  assert.equal(safeError({ code: 'constructor' }), DEFAULT_ERROR);
});

test('the cards are fresh only when Zetaris has every change', () => {
  assert.deepEqual(describeFreshness({ health: 'synced' }), { stale: false, notice: null });

  const pending = describeFreshness({ health: 'pending' });
  assert.equal(pending.stale, true);
  assert.match(pending.notice, /still being saved/);

  const degraded = describeFreshness({ health: 'degraded', lastError: 'HTTP 500: internal detail' });
  assert.equal(degraded.stale, true);
  assert.match(degraded.notice, /refused the last save/);
  assert.ok(!degraded.notice.includes('internal detail'));

  assert.equal(describeFreshness().stale, true);
});

test('discussion is grouped by source id, so two feeds with one name stay apart', () => {
  const sql = INSIGHTS.find(insight => insight.id === 'comments-by-source').sql('selo');
  assert.match(sql, /GROUP BY n\.source_id, n\.source_name/);
});

test('the personality ranking counts AI comments only', () => {
  const sql = INSIGHTS.find(insight => insight.id === 'personas').sql('selo');
  assert.match(sql, /is_ai = 'true'/);
  assert.match(sql, /is_summary <> 'true'/);
});

test('a database name that is not an identifier is refused before any query', () => {
  const zetaris = fakeZetaris(async () => TABLE_ANSWER);
  for (const database of ['', 'bad name', 'a;DROP', '1abc', undefined]) {
    assert.throws(() => createInsights({ zetaris, database }), /not a valid Zetaris database name/);
  }
  assert.equal(zetaris.calls.length, 0);
});
