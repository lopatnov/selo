'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const examples = require('../client/src/zetarisExamples.json');
const { ASKABLE_TABLES, validateSql } = require('./ask-data');

const queries = examples.groups.flatMap(group => group.queries.map(query => ({ ...query, group: group.label })));

// The same rule the SQL route applies to what the page sends.
const READ_ONLY_SQL = /^\s*(select|show|describe|with)\b/i;

test('the example groups the page builds its dropdown from', () => {
  assert.deepEqual(
    examples.groups.map(group => group.label),
    ['Overview', 'Discussion', 'News and feeds', 'AI agents and Meterless']
  );
  assert.ok(queries.length >= 20, `only ${queries.length} examples`);
});

test('every example has an id, a label and one read-only statement, and ids and labels are unique', () => {
  const ids = new Set();
  const labels = new Set();
  for (const query of [...queries, { id: 'feedQuery', ...examples.feedQuery, group: 'feed' }]) {
    assert.ok(query.id && query.label && query.sql, JSON.stringify(query));
    assert.ok(!ids.has(query.id), `duplicate id ${query.id}`);
    assert.ok(!labels.has(query.label), `duplicate label ${query.label}`);
    ids.add(query.id);
    labels.add(query.label);

    assert.match(query.sql, READ_ONLY_SQL, query.id);
    assert.ok(!query.sql.includes(';'), `${query.id} sends more than one statement`);
  }
});

test('every example reads through the {db} placeholder, which the page replaces with the database', () => {
  for (const query of queries) {
    // `SHOW TABLES IN {db}` and `DESCRIBE {db}.x` count: the placeholder is what matters.
    assert.ok(query.sql.includes('{db}'), `${query.id} does not use {db}`);
  }
  assert.ok(examples.feedQuery.sql.includes('{db}') && examples.feedQuery.sql.includes('{name}'));
});

test('the SELECT examples only read the app tables, so Ask the data could run them too', () => {
  for (const query of queries) {
    if (!/^\s*(select|with)\b/i.test(query.sql)) continue;
    const sql = query.sql.replaceAll('{db}', 'selo');
    // information_schema-style or other-database reads would be refused by the guard.
    try {
      validateSql(sql, 'selo');
    } catch (error) {
      assert.fail(`${query.id} is refused by the Ask the data guard: ${error.message}`);
    }
  }
  assert.ok(ASKABLE_TABLES.includes('comments'));
});

test('the examples that came with the reply guard and Insights are there', () => {
  const ids = queries.map(query => query.id);
  for (const id of ['per-day', 'topic-mentions', 'discussion-by-source', 'why-failed', 'reply-guard', 'model-speed']) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
  // The speed example counts failures next to the average, as the Insights card does.
  assert.match(queries.find(query => query.id === 'model-speed').sql, /AS failed/);
  // A feed that was deleted and added again is marked, not merged or repeated.
  assert.match(queries.find(query => query.id === 'discussion-by-source').sql, /\(removed\)/);
});
