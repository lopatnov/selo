'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ALL_TABLE_NAMES,
  LOG_TABLE,
  TABLES,
  collectionCsv,
  createZetarisStore,
  csvField,
  resolveDatabase
} = require('./zetaris-store');
const { normalize } = require('./state-store');
const { normalizeLog } = require('./meterless-log');

/** RFC 4180 parser: what a Spark CSV reader with multiLine/quote/escape '"' does. */
function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (quoted) {
      if (char === '"' && content[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
      wasQuoted = true;
    } else if (char === ',') {
      row.push(wasQuoted || field !== '' ? field : null);
      field = '';
      wasQuoted = false;
    } else if (char === '\n') {
      row.push(wasQuoted || field !== '' ? field : null);
      rows.push(row);
      row = [];
      field = '';
      wasQuoted = false;
    } else {
      field += char;
    }
  }
  return rows;
}

/**
 * An in-memory Zetaris: a file store, Lightning databases with registered tables,
 * and just enough SQL for the statements the store sends.
 */
function fakeZetaris({ databases = [], failSave = null } = {}) {
  const files = new Map(); // "/file-store/db/name.csv" -> content
  const dbs = new Map(databases.map(name => [name, new Set()]));
  const directories = new Set();
  const calls = [];

  function tableRows(sql) {
    const match = sql.match(/FROM (\w+)\.(\w+)/);
    const [, db, table] = match;
    const content = files.get(`/file-store/${db}/${table}.csv`);
    const [header, ...rows] = parseCsv(content || '');
    return { header, rows };
  }

  const client = {
    calls,
    files,
    dbs,
    async listDatabases() {
      return [...dbs.keys()];
    },
    async listFiles(directory) {
      if (!directories.has(directory)) {
        const error = new Error('Zetaris answered HTTP 400: Bad Request');
        error.status = 400;
        throw error;
      }
      return [...files.keys()]
        .filter(path => path.startsWith(`${directory}/`))
        .map(path => ({ isFile: true, fileName: path.slice(directory.length + 1) }));
    },
    async createDirectory(directory) {
      directories.add(directory);
    },
    async saveFile(directory, name, content) {
      calls.push(`save ${name}`);
      if (failSave && failSave(name)) throw new Error('disk full');
      files.set(`${directory}/${name}`, content);
    },
    async runSql(sql) {
      calls.push(sql.split('\n')[0].slice(0, 70));
      let match;
      if ((match = sql.match(/^CREATE LIGHTNING DATABASE (\w+)/))) {
        dbs.set(match[1], new Set());
        return { headers: ['Result'], rows: [] };
      }
      if ((match = sql.match(/^SHOW LIGHTNING TABLES (\w+)/))) {
        return { headers: ['name'], rows: [...dbs.get(match[1])].map(name => [name]) };
      }
      if ((match = sql.match(/^CREATE LIGHTNING FILESTORE TABLE (\w+) FROM (\w+)/))) {
        assert.match(sql, /multiLine "true"/);
        assert.match(sql, /quote "\\""/);
        assert.match(sql, /escape "\\""/);
        assert.match(sql, new RegExp(`path "dffs://${match[2]}/${match[1]}\\.csv"`));
        dbs.get(match[2]).add(match[1]);
        return { headers: ['Result'], rows: [] };
      }
      if (sql.startsWith('UNCACHE')) return { headers: [], rows: [] };
      if (/^SELECT state_key, state_value/.test(sql)) {
        const { rows } = tableRows(sql);
        return { headers: ['state_key', 'state_value'], rows };
      }
      if (/^SELECT doc FROM/.test(sql)) {
        const { header, rows } = tableRows(sql);
        const pos = header.indexOf('pos');
        const doc = header.indexOf('doc');
        const sorted = rows.slice().sort((a, b) => Number(a[pos]) - Number(b[pos]));
        return { headers: ['doc'], rows: sorted.map(row => [row[doc]]) };
      }
      if ((match = sql.match(/^SELECT ([\w, ]+) FROM (\w+)\.(\w+) LIMIT 1/))) {
        const { header } = tableRows(sql);
        const missing = match[1].split(',').map(c => c.trim()).filter(c => !header.includes(c));
        if (missing.length) {
          throw new Error(`[UNRESOLVED_COLUMN] ${missing[0]} cannot be resolved`);
        }
        return { headers: header, rows: [] };
      }
      throw new Error(`fake Zetaris does not understand: ${sql}`);
    }
  };
  return client;
}

const awkward = [
  'plain',
  'comma, "quotes" and \'single\'',
  'two\nlines\r\nand a\ttab',
  'back\\slash and \\"escaped\\" and trailing\\',
  'Привіт, світе — «ялинка» 🎄',
  '{"json":"inside","n":[1,2]}',
  ''
];

function sampleState(commentCount = 4) {
  return {
    participantId: 'p-1',
    rssSources: [{ id: 's-1', name: 'Feed, one', url: 'https://example.com/feed', lastItemCount: 2 }],
    users: [
      { id: 'p-1', name: 'Local User', modelName: 'human', isAI: false },
      { id: 'u-1', name: 'Ada "AI"', modelName: 'meterless/auto', isAI: true, personality: awkward[2] }
    ],
    news: awkward.map((text, index) => ({
      id: `n-${index}`,
      sourceId: 's-1',
      title: `T${index}: ${text}`,
      content: text,
      link: `https://example.com/${index}`
    })),
    comments: Array.from({ length: commentCount }, (_, index) => ({
      id: `c-${index}`,
      newsId: `n-${index % awkward.length}`,
      userId: index % 2 ? 'p-1' : 'u-1',
      userName: index % 2 ? 'Local User' : 'Ada "AI"',
      text: awkward[index % awkward.length],
      isAI: index % 2 === 0,
      timestamp: `2026-01-01T00:00:0${index}.000Z`
    })),
    settings: { agentsPerNews: 3 },
    meterlessLog: {
      sequence: 9,
      entries: awkward.map((text, index) => ({
        id: 9 - index,
        at: '2026-01-01T00:00:00.000Z',
        newsId: `n-${index}`,
        userName: 'Ada',
        model: 'meterless/auto',
        durationMs: 5,
        ask: text,
        think: text,
        answer: text,
        error: null
      }))
    }
  };
}

test('csvField quotes every value, doubles inner quotes and leaves null empty', () => {
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('x\ny'), '"x\ny"');
  assert.equal(csvField(null), '');
  assert.equal(csvField(undefined), '');
  assert.equal(csvField(0), '"0"');
  assert.equal(csvField(false), '"false"');
});

test('a collection file is plain RFC 4180 CSV that carries the full record in doc', () => {
  const comments = TABLES.find(table => table.name === 'comments');
  const records = sampleState().comments;
  const [header, ...rows] = parseCsv(collectionCsv(comments, records));

  assert.deepEqual(header, [
    'pos', 'id', 'news_id', 'user_id', 'user_name', 'is_ai', 'is_error', 'is_summary', 'text_length', 'created_at', 'doc'
  ]);
  assert.equal(rows.length, records.length);
  rows.forEach((row, index) => {
    assert.equal(row[0], String(index));
    assert.equal(row[1], records[index].id);
    assert.equal(row[8], String(records[index].text.length));
    assert.deepEqual(JSON.parse(row[header.indexOf('doc')]), records[index]);
  });
});

test('resolveDatabase defaults to selo and refuses names that are not identifiers', () => {
  assert.equal(resolveDatabase({}), 'selo');
  assert.equal(resolveDatabase({ ZETARIS_APP_DATABASE: ' my_app2 ' }), 'my_app2');
  assert.throws(() => resolveDatabase({ ZETARIS_APP_DATABASE: 'bad name; DROP' }), /not a valid name/);
  assert.throws(() => resolveDatabase({ ZETARIS_APP_DATABASE: '1abc' }), /not a valid name/);
});

test('ensureSchema creates the database, folder, files and tables, and is idempotent', async () => {
  const zetaris = fakeZetaris({ databases: ['other_db'] });
  const store = createZetarisStore({ zetaris, database: 'selo' });

  const first = await store.ensureSchema();
  assert.deepEqual(first.created.sort(), ALL_TABLE_NAMES.slice().sort());
  assert.ok(zetaris.dbs.has('selo'));
  assert.ok(zetaris.dbs.has('other_db'), 'other databases are left alone');
  for (const name of ALL_TABLE_NAMES) assert.ok(zetaris.files.has(`/file-store/selo/${name}.csv`), name);

  const before = zetaris.calls.length;
  const second = await store.ensureSchema();
  assert.deepEqual(second.created, []);
  assert.equal(zetaris.calls.slice(before).filter(call => call.startsWith('save')).length, 0);
  assert.equal(zetaris.calls.slice(before).filter(call => call.startsWith('CREATE')).length, 0);
});

test('ensureSchema never overwrites a file that already holds data', async () => {
  const zetaris = fakeZetaris();
  const store = createZetarisStore({ zetaris, database: 'selo' });
  await store.ensureSchema();
  await store.write(sampleState());

  // The database was dropped (tables gone) but the files are still there.
  zetaris.dbs.get('selo').clear();
  await store.ensureSchema();

  const restored = await store.read();
  assert.equal(restored.comments.length, 4);
  assert.equal(restored.users.length, 2);
});

test('write then read returns every record unchanged and in order', async () => {
  const zetaris = fakeZetaris();
  const store = createZetarisStore({ zetaris, database: 'selo' });
  await store.ensureSchema();

  assert.equal(await store.read(), null, 'nothing saved yet');

  const state = sampleState(150);
  const saved = await store.write(state);
  assert.deepEqual(saved.counts, {
    rss_sources: 1,
    users: 2,
    news: awkward.length,
    comments: 150,
    meterless_log: awkward.length
  });

  const back = await store.read();
  const expected = normalize(state);
  assert.deepEqual(back.rssSources, expected.rssSources);
  assert.deepEqual(back.users, expected.users);
  assert.deepEqual(back.news, expected.news);
  assert.deepEqual(back.comments, expected.comments);
  assert.deepEqual(back.meterlessLog, normalizeLog(state.meterlessLog));
  assert.equal(back.participantId, 'p-1');
  assert.equal(back.settings.agentsPerNews, 3);
  assert.equal(back.updatedAt, saved.savedAt);
});

/** A clock that moves a second per call, so two saves never share a timestamp. */
function steppingClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, (tick += 1)));
}

test('only collections whose content changed are uploaded, and app_state goes last', async () => {
  const zetaris = fakeZetaris();
  const store = createZetarisStore({ zetaris, database: 'selo', now: steppingClock() });
  await store.ensureSchema();

  const first = await store.write(sampleState());
  assert.equal(first.uploaded.at(-1), 'app_state.csv');
  assert.equal(first.uploaded.length, ALL_TABLE_NAMES.length);

  const same = await store.write(sampleState());
  assert.deepEqual(same.uploaded, ['app_state.csv'], 'unchanged data is not uploaded again');

  const changed = sampleState();
  changed.comments.push({ id: 'c-new', newsId: 'n-0', userId: 'u-1', userName: 'Ada', text: 'new', isAI: true });
  const third = await store.write(changed);
  assert.deepEqual(third.uploaded, ['comments.csv', 'app_state.csv']);
});

test('a snapshot without the Meterless log leaves the stored log alone', async () => {
  const zetaris = fakeZetaris();
  const store = createZetarisStore({ zetaris, database: 'selo' });
  await store.ensureSchema();
  await store.write(sampleState());

  const { meterlessLog, ...withoutLog } = sampleState();
  assert.ok(meterlessLog);
  const result = await store.write(withoutLog);
  assert.ok(!result.uploaded.includes(`${LOG_TABLE.name}.csv`));
  assert.equal((await store.read()).meterlessLog.entries.length, awkward.length);
});

test('a failed upload rejects and is retried in full next time', async () => {
  let failing = true;
  const zetaris = fakeZetaris({ failSave: name => failing && name === 'news.csv' });
  const store = createZetarisStore({ zetaris, database: 'selo', now: steppingClock() });
  failing = false;
  await store.ensureSchema();
  failing = true;

  await assert.rejects(() => store.write(sampleState()), /disk full/);

  failing = false;
  const retry = await store.write(sampleState());
  assert.ok(retry.uploaded.includes('news.csv'), 'the failed file is sent again');
  assert.ok(retry.uploaded.includes('app_state.csv'));
});

test('a table with other columns is refused with a message that says how to fix it', async () => {
  const zetaris = fakeZetaris({ databases: ['selo'] });
  zetaris.dbs.get('selo').add('users');
  const foreign = createZetarisStore({ zetaris, database: 'selo' });
  // Somebody else's `users` file: no pos / doc columns.
  await zetaris.createDirectory('/file-store/selo');
  zetaris.files.set('/file-store/selo/users.csv', 'id,email\n');

  await assert.rejects(
    () => foreign.ensureSchema(),
    error => /selo\.users/.test(error.message) && /DROP LIGHTNING DATABASE TABLE selo\.users/.test(error.message)
  );
});

test('saves never overlap', async () => {
  const zetaris = fakeZetaris();
  let running = 0;
  let peak = 0;
  const saveFile = zetaris.saveFile;
  zetaris.saveFile = async (...args) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, 2));
    await saveFile(...args);
    running -= 1;
  };
  const store = createZetarisStore({ zetaris, database: 'selo' });
  await store.ensureSchema();

  await Promise.all([store.write(sampleState(1)), store.write(sampleState(2)), store.write(sampleState(3))]);
  assert.equal(peak, 1);
  assert.equal((await store.read()).comments.length, 3, 'the last write wins');
});
