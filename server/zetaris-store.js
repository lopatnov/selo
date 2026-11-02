'use strict';

/**
 * The app's data, kept in Zetaris.
 *
 * Zetaris has no INSERT / UPDATE / DELETE and no per-resource REST API. What it
 * does have, and what this module uses, is:
 *
 *   write  `POST /ndp-files/save`  - put a file into the Zetaris file store
 *   read   a Lightning file-store table registered over that file, queried with
 *          plain SQL (`SELECT ... FROM selo.news`)
 *
 * So every collection is a CSV file in `/file-store/<database>/` and a table
 * `<database>.<collection>`. A save rewrites the files whose content changed; a
 * file overwrite is visible to the very next query (checked on a live 2.4.3
 * instance), no cache refresh needed.
 *
 * Each table has a few plain columns, so the data can be explored with SQL
 * (`SELECT user_name, count(*) FROM selo.comments GROUP BY user_name`), plus
 * `pos` (the order inside the collection) and `doc`, the complete record as
 * JSON, which is what the app reads back. `app_state` holds the single values
 * (participant, settings) and is written LAST: its `updated_at` marks a
 * finished snapshot.
 *
 * `ensureSchema()` creates the Lightning database, the folder, the files and the
 * tables when they are missing, so a fresh Zetaris needs only the credentials in
 * `.env`. It never overwrites a file that already exists.
 */

const { createHash } = require('node:crypto');

const { normalize } = require('./state-store');
const { normalizeLog } = require('./meterless-log');

const DEFAULT_DATABASE = 'selo';
const FILE_STORE = '/file-store';
const READ_LIMIT = 100_000;
const DESCRIPTION = 'AI news discussion app data';
const IDENTIFIER = /^[A-Za-z]\w{0,62}$/;

const text = value => (value === undefined ? null : value);

/**
 * Run `task` for each item, one after the other. Zetaris is given one upload or
 * one DDL statement at a time, in order.
 */
function inOrder(items, task) {
  return items.reduce((chain, item) => chain.then(() => task(item)), Promise.resolve());
}

/**
 * `columns` are the queryable projection of a record (`project` returns them in
 * the same order); the full record always travels in `doc`.
 */
const TABLES = Object.freeze([
  {
    name: 'rss_sources',
    collection: 'rssSources',
    columns: ['id', 'name', 'url', 'created_at', 'last_fetched_at', 'last_item_count', 'last_error'],
    project: s => [s.id, s.name, s.url, s.createdAt, s.lastFetchedAt, s.lastItemCount, s.lastError]
  },
  {
    name: 'users',
    collection: 'users',
    columns: ['id', 'name', 'role', 'model_name', 'is_ai', 'created_at'],
    project: u => [u.id, u.name, text(u.role), u.modelName, u.isAI, u.createdAt]
  },
  {
    name: 'news',
    collection: 'news',
    columns: ['id', 'source_id', 'source_name', 'title', 'link', 'pub_date', 'fetched_at'],
    project: n => [n.id, n.sourceId, n.sourceName, n.title, n.link, n.pubDate, n.fetchedAt]
  },
  {
    name: 'comments',
    collection: 'comments',
    columns: [
      'id',
      'news_id',
      'user_id',
      'user_name',
      'is_ai',
      'is_error',
      'is_summary',
      'text_length',
      'created_at'
    ],
    project: c => [
      c.id,
      c.newsId,
      c.userId,
      c.userName,
      c.isAI,
      c.isError === true,
      c.isSummary === true,
      typeof c.text === 'string' ? c.text.length : 0,
      c.timestamp
    ]
  }
]);

/**
 * The Meterless ask / think / answer records. Not part of the state document
 * (`normalize`): the log has its own owner, so it travels as `snapshot.meterlessLog`
 * (`{ sequence, entries }`, newest first).
 */
const LOG_TABLE = Object.freeze({
  name: 'meterless_log',
  columns: ['id', 'at', 'news_id', 'user_name', 'model', 'duration_ms', 'error'],
  project: e => [e.id, e.at, e.newsId, e.userName, e.model, e.durationMs, e.error]
});

const STATE_TABLE = Object.freeze({
  name: 'app_state',
  columns: ['state_key', 'state_value']
});

/** Every table the store owns, with the exact column order of its file. */
const ALL_TABLE_NAMES = Object.freeze([
  ...TABLES.map(table => table.name),
  LOG_TABLE.name,
  STATE_TABLE.name
]);

function fileColumns(table) {
  return table === STATE_TABLE ? STATE_TABLE.columns : ['pos', ...table.columns, 'doc'];
}

/**
 * Quote every value, double the quotes inside it; newlines stay inside the
 * quotes (the table is registered with multiLine). `null` is an empty cell.
 */
function csvField(value) {
  if (value === null || value === undefined) return '';
  return `"${String(value).replaceAll('"', '""')}"`;
}

function csvLine(values) {
  return `${values.map(csvField).join(',')}\n`;
}

function csvHeader(columns) {
  return `${columns.join(',')}\n`;
}

function collectionCsv(table, records) {
  let out = csvHeader(fileColumns(table));
  records.forEach((record, index) => {
    out += csvLine([index, ...table.project(record), JSON.stringify(record)]);
  });
  return out;
}

function stateCsv(state, savedAt, logSequence = 0) {
  let out = csvHeader(STATE_TABLE.columns);
  const rows = [
    ['version', 1],
    ['participant_id', state.participantId],
    ['settings', JSON.stringify(state.settings || {})],
    ['log_sequence', logSequence],
    ['updated_at', savedAt]
  ];
  for (const row of rows) out += csvLine(row);
  return out;
}

/** Only tells "same content as last upload" from "changed"; not a security hash. */
function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

function resolveDatabase(env = process.env) {
  const name = String(env.ZETARIS_APP_DATABASE || '').trim() || DEFAULT_DATABASE;
  if (!IDENTIFIER.test(name)) {
    throw new Error(
      `ZETARIS_APP_DATABASE "${name}" is not a valid name: use letters, digits and underscores, starting with a letter.`
    );
  }
  return name;
}

function createZetarisStore({ zetaris, database = resolveDatabase(), now = () => new Date() } = {}) {
  if (!zetaris) throw new Error('The Zetaris store needs a Zetaris client.');
  if (!IDENTIFIER.test(database)) throw new Error(`"${database}" is not a valid Zetaris database name.`);

  const directory = `${FILE_STORE}/${database}`;
  // File name -> digest of what is already in Zetaris, so an unchanged
  // collection is not uploaded again.
  const uploaded = new Map();
  let queue = Promise.resolve();

  /** Saves never overlap: two uploads of one file would race. */
  function serialize(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  function createTableSql(table) {
    return String.raw`CREATE LIGHTNING FILESTORE TABLE ${table.name} FROM ${database} FORMAT CSV OPTIONS (path "dffs://${database}/${table.name}.csv", header "true", multiLine "true", quote "\"", escape "\"")`;
  }

  async function ensureSchema() {
    const databases = await zetaris.listDatabases();
    if (!databases.some(name => name.toLowerCase() === database.toLowerCase())) {
      await zetaris.runSql(`CREATE LIGHTNING DATABASE ${database} DESCRIBE BY "${DESCRIPTION}"`);
    }

    let present;
    try {
      present = await zetaris.listFiles(directory);
    } catch (error) {
      // A folder that does not exist yet answers HTTP 400.
      if (error.status !== 400) throw error;
      await zetaris.createDirectory(directory);
      present = [];
    }
    const files = new Set(present.filter(entry => entry.isFile).map(entry => entry.fileName));

    const tables = [...TABLES, LOG_TABLE, STATE_TABLE];
    const registered = new Set(
      (await zetaris.runSql(`SHOW LIGHTNING TABLES ${database}`)).rows.map(row =>
        String(row[0]).toLowerCase()
      )
    );

    const created = [];
    await inOrder(tables, async table => {
      const file = `${table.name}.csv`;
      // Only an absent file is created: stored data is never overwritten here.
      if (!files.has(file)) {
        await zetaris.saveFile(directory, file, csvHeader(fileColumns(table)));
      }
      if (!registered.has(table.name)) {
        await zetaris.runSql(createTableSql(table));
        created.push(table.name);
      }
    });

    await Promise.all(tables.map(table => verifyColumns(table)));
    return { database, directory, created };
  }

  /** A table someone else made with other columns must not be read as ours. */
  async function verifyColumns(table) {
    const sql = `SELECT ${fileColumns(table).join(', ')} FROM ${database}.${table.name} LIMIT 1`;
    try {
      await zetaris.runSql(sql, { limit: 1 });
    } catch (error) {
      if (!/cannot be resolved|UNRESOLVED_COLUMN/i.test(error.message)) throw error;
      // The column list is cached from registration time: refresh once.
      await zetaris
        .runSql(`UNCACHE LIGHTNING FILESTORE TABLE ${table.name} FROM ${database}`)
        .catch(() => {});
      try {
        await zetaris.runSql(sql, { limit: 1 });
      } catch (error_) {
        throw new Error(
          `Zetaris table ${database}.${table.name} does not have the columns this app expects ` +
            `(${fileColumns(table).join(', ')}). Drop it ("DROP LIGHTNING DATABASE TABLE ${database}.${table.name}") ` +
            `or set ZETARIS_APP_DATABASE to another name. ${error_.message}`
        );
      }
    }
  }

  function parseDocs(rows, tableName) {
    const records = [];
    let skipped = 0;
    for (const row of rows) {
      try {
        const record = JSON.parse(Array.isArray(row) ? row[0] : row);
        if (record && typeof record === 'object') records.push(record);
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
    if (skipped > 0) console.warn(`Zetaris ${database}.${tableName}: skipped ${skipped} unreadable row(s).`);
    return records;
  }

  /** The stored state, or `null` when Zetaris holds nothing yet. */
  async function read() {
    const meta = await zetaris.runSql(`SELECT state_key, state_value FROM ${database}.app_state`, {
      limit: 100
    });
    const values = Object.fromEntries(meta.rows.map(row => [row[0], row[1]]));

    const raw = {};
    let total = 0;
    await Promise.all(
      TABLES.map(async table => {
        const result = await zetaris.runSql(
          `SELECT doc FROM ${database}.${table.name} ORDER BY CAST(pos AS INT)`,
          { limit: READ_LIMIT }
        );
        raw[table.collection] = parseDocs(result.rows, table.name);
        total += raw[table.collection].length;
      })
    );

    const logResult = await zetaris.runSql(
      `SELECT doc FROM ${database}.${LOG_TABLE.name} ORDER BY CAST(pos AS INT)`,
      { limit: READ_LIMIT }
    );
    const logEntries = parseDocs(logResult.rows, LOG_TABLE.name);
    total += logEntries.length;

    if (total === 0 && !values.updated_at) return null;

    let settings;
    try {
      settings = values.settings ? JSON.parse(values.settings) : undefined;
    } catch {
      settings = undefined;
    }

    return {
      ...normalize({
        ...raw,
        participantId: values.participant_id || null,
        settings,
        updatedAt: values.updated_at || null
      }),
      meterlessLog: normalizeLog({
        sequence: Number.parseInt(values.log_sequence, 10) || 0,
        entries: logEntries
      })
    };
  }

  /**
   * Write the snapshot. Collections first, `app_state` last. Resolves with what
   * was uploaded; rejects (and keeps the old digests) if Zetaris refuses.
   */
  function write(snapshot) {
    return serialize(async () => {
      const state = normalize(snapshot);
      const savedAt = now().toISOString();

      const files = TABLES.map(table => ({
        name: `${table.name}.csv`,
        content: collectionCsv(table, state[table.collection])
      }));
      // No log in the snapshot means "not mine to touch", not "empty it".
      const log = snapshot.meterlessLog ? normalizeLog(snapshot.meterlessLog) : null;
      if (log) {
        files.push({
          name: `${LOG_TABLE.name}.csv`,
          content: collectionCsv(LOG_TABLE, log.entries)
        });
      }
      files.push({
        name: `${STATE_TABLE.name}.csv`,
        content: stateCsv(state, savedAt, log ? log.sequence : 0)
      });

      const sent = [];
      let bytes = 0;
      await inOrder(files, async file => {
        const hash = digest(file.content);
        if (uploaded.get(file.name) === hash) return;
        await zetaris.saveFile(directory, file.name, file.content);
        uploaded.set(file.name, hash);
        sent.push(file.name);
        bytes += Buffer.byteLength(file.content);
      });

      return {
        savedAt,
        uploaded: sent,
        bytes,
        counts: {
          ...Object.fromEntries(TABLES.map(table => [table.name, state[table.collection].length])),
          ...(log ? { [LOG_TABLE.name]: log.entries.length } : {})
        }
      };
    });
  }

  function describe() {
    return {
      database,
      directory,
      tables: ALL_TABLE_NAMES.slice()
    };
  }

  return { database, directory, describe, ensureSchema, read, write };
}

module.exports = {
  ALL_TABLE_NAMES,
  DEFAULT_DATABASE,
  FILE_STORE,
  LOG_TABLE,
  STATE_TABLE,
  TABLES,
  collectionCsv,
  createZetarisStore,
  csvField,
  fileColumns,
  resolveDatabase,
  stateCsv
};
