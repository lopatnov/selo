'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { INSIGHTS, MAX_PARALLEL, ROW_LIMIT, createInsights } = require('./insights');

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

test('a failing question shows its error and does not stop the others', async () => {
  const failing = INSIGHTS[2];
  const zetaris = fakeZetaris(async sql => {
    if (sql === failing.sql('selo')) throw new Error('Table or view not found: selo.news');
    return TABLE_ANSWER;
  });
  const result = await createInsights({ zetaris, database: 'selo' }).run();

  const broken = result.items.find(item => item.id === failing.id);
  assert.equal(broken.error, 'Table or view not found: selo.news');
  assert.deepEqual(broken.rows, []);
  assert.deepEqual(broken.columns, []);
  assert.equal(result.items.filter(item => item.error === null).length, INSIGHTS.length - 1);
});

test('an error without a message still says something', async () => {
  const zetaris = fakeZetaris(async () => {
    throw Object.assign(new Error(''), { message: '' });
  });
  const result = await createInsights({ zetaris, database: 'selo' }).run();
  assert.ok(result.items.every(item => item.error === 'The query failed.'));
});

test('a database name that is not an identifier is refused before any query', () => {
  const zetaris = fakeZetaris(async () => TABLE_ANSWER);
  for (const database of ['', 'bad name', 'a;DROP', '1abc', undefined]) {
    assert.throws(() => createInsights({ zetaris, database }), /not a valid Zetaris database name/);
  }
  assert.equal(zetaris.calls.length, 0);
});
