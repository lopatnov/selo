'use strict';

/**
 * Insights: what the app's data says, worked out by Zetaris.
 *
 * The app keeps its data in Zetaris tables (see `zetaris-store.js`). This module
 * asks Zetaris questions about it - joins, aggregates, JSON fields - and hands
 * the plain result to the UI, so none of these numbers is counted in JavaScript.
 *
 * Every query is one read-only SELECT, bounded by a LIMIT, so the list of RSS
 * sources, personas or models can grow without the page growing with it. All
 * columns of a file-store table are text, hence the CAST before arithmetic.
 */

const IDENTIFIER = /^[A-Za-z]\w{0,62}$/;
const MAX_PARALLEL = 3;
const ROW_LIMIT = 50;

/**
 * `kind: 'stats'` is one row of totals; `kind: 'table'` is a ranked table whose
 * column `bar` (a number) the page draws as bars.
 */
const INSIGHTS = Object.freeze([
  {
    id: 'totals',
    title: 'In Zetaris right now',
    description: 'Rows in the app tables: the RSS sources, news, comments and logged model requests.',
    kind: 'stats',
    sql: db =>
      `SELECT (SELECT count(*) FROM ${db}.rss_sources) AS rss_sources, ` +
      `(SELECT count(*) FROM ${db}.news) AS news, ` +
      `(SELECT count(*) FROM ${db}.comments) AS comments, ` +
      `(SELECT count(*) FROM ${db}.meterless_log) AS model_requests`
  },
  {
    id: 'comments-by-source',
    title: 'Discussion by RSS source',
    description:
      'The 15 sources with the most comments: news items kept and comments written under them. A feed that was deleted and added again counts as two; the old one is marked "(removed)".',
    kind: 'table',
    bar: 2,
    sql: db =>
      `SELECT CASE WHEN s.id IS NULL THEN concat(n.source_name, ' (removed)') ELSE n.source_name END AS source, ` +
      `count(DISTINCT n.id) AS news, count(c.id) AS comments ` +
      `FROM ${db}.news n LEFT JOIN ${db}.rss_sources s ON s.id = n.source_id ` +
      `LEFT JOIN ${db}.comments c ON c.news_id = n.id ` +
      `GROUP BY n.source_id, n.source_name, s.id ORDER BY comments DESC, news DESC LIMIT 15`
  },
  {
    id: 'busiest-news',
    title: 'Most discussed news',
    description: 'The 10 news items with the most comments.',
    kind: 'table',
    bar: 2,
    sql: db =>
      `SELECT n.title AS news, n.source_name AS source, count(c.id) AS comments ` +
      `FROM ${db}.news n JOIN ${db}.comments c ON c.news_id = n.id ` +
      `GROUP BY n.id, n.title, n.source_name ORDER BY comments DESC LIMIT 10`
  },
  {
    id: 'personas',
    title: 'Who talks the most',
    description:
      'Comments per AI personality (summaries, errors and human comments left out) and their average length in characters.',
    kind: 'table',
    bar: 1,
    sql: db =>
      `SELECT user_name AS personality, count(*) AS comments, round(avg(CAST(text_length AS DOUBLE))) AS avg_chars ` +
      `FROM ${db}.comments WHERE is_ai = 'true' AND is_summary <> 'true' AND is_error <> 'true' ` +
      `GROUP BY user_name ORDER BY comments DESC LIMIT 15`
  },
  {
    id: 'models',
    title: 'Models: speed and failures',
    description: 'Requests logged per model id, how many failed, and the average answer time in seconds.',
    kind: 'table',
    bar: 1,
    sql: db =>
      `SELECT model, count(*) AS requests, ` +
      `sum(CASE WHEN error IS NULL OR error = '' THEN 0 ELSE 1 END) AS failed, ` +
      `round(avg(CAST(duration_ms AS DOUBLE)) / 1000, 1) AS avg_seconds ` +
      `FROM ${db}.meterless_log GROUP BY model ORDER BY requests DESC LIMIT 15`
  },
  {
    id: 'errors',
    title: 'Why requests failed',
    description: 'Failed model requests grouped by the reason, without the attempt count.',
    kind: 'table',
    bar: 1,
    sql: db =>
      `SELECT CASE WHEN instr(error, ' (after') > 0 THEN substr(error, 1, instr(error, ' (after') - 1) ELSE error END AS reason, ` +
      `count(*) AS requests FROM ${db}.meterless_log WHERE error IS NOT NULL AND error <> '' ` +
      `GROUP BY CASE WHEN instr(error, ' (after') > 0 THEN substr(error, 1, instr(error, ' (after') - 1) ELSE error END ` +
      `ORDER BY requests DESC LIMIT 10`
  },
  {
    id: 'reply-guard',
    title: 'Reply guard: repaired replies',
    description:
      'For replies that went through the reply guard: how many needed a second call and how many were shortened to a complete sentence.',
    kind: 'table',
    bar: 1,
    sql: db =>
      `SELECT model, count(*) AS replies, ` +
      `sum(CASE WHEN get_json_object(doc, '$.reply.retried') = 'true' THEN 1 ELSE 0 END) AS retried, ` +
      `sum(CASE WHEN get_json_object(doc, '$.reply.trimmed') = 'true' THEN 1 ELSE 0 END) AS shortened ` +
      `FROM ${db}.meterless_log WHERE get_json_object(doc, '$.reply.cap') IS NOT NULL ` +
      `GROUP BY model ORDER BY replies DESC LIMIT 15`
  },
  {
    id: 'by-day',
    title: 'Comments per day',
    description: 'The last 14 days with comments, and how many of them were written by AI.',
    kind: 'table',
    bar: 1,
    sql: db =>
      `SELECT substr(created_at, 1, 10) AS day, count(*) AS comments, ` +
      `sum(CASE WHEN is_ai = 'true' THEN 1 ELSE 0 END) AS ai ` +
      `FROM ${db}.comments GROUP BY substr(created_at, 1, 10) ORDER BY day DESC LIMIT 14`
  }
]);

function cell(value) {
  return value === null || value === undefined ? null : String(value);
}

/** Run `task` over `items`, at most `size` at a time; results keep the order of `items`. */
async function inParallel(items, size, task) {
  const results = new Array(items.length);
  let next = 0;
  // Each worker takes the next item when its task is done.
  function worker() {
    if (next >= items.length) return Promise.resolve();
    const index = next;
    next += 1;
    return task(items[index]).then(result => {
      results[index] = result;
      return worker();
    });
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

// What a card may say about a failed query. Zetaris puts the start of its HTTP
// error body into the message, and this page is open to anyone, so the message
// itself stays in the server log.
const SAFE_ERRORS = new Map([
  ['unauthorized', 'Zetaris rejected the API key.'],
  ['offline', 'Zetaris is not reachable.']
]);
const DEFAULT_ERROR = 'Zetaris could not run this query. The server log has the details.';

function safeError(error) {
  return SAFE_ERRORS.get(error?.code) ?? DEFAULT_ERROR;
}

/**
 * Are the numbers current? They come from the Zetaris tables, which the app fills
 * with a short delay (and again later if Zetaris refused a save), so while a save
 * is waiting the cards can be a little behind the app.
 *
 * @param {{ health?: string }} storage `persistence.status()`
 */
function describeFreshness({ health } = {}) {
  if (health === 'synced') return { stale: false, notice: null };
  if (health === 'degraded') {
    return {
      stale: true,
      notice: 'Zetaris refused the last save, so these numbers may be behind the app until a save goes through.'
    };
  }
  return { stale: true, notice: 'The latest changes are still being saved to Zetaris, so these numbers may be a moment behind.' };
}

/**
 * @param {object} options
 * @param {{ runSql: Function }} options.zetaris the Zetaris client
 * @param {string} options.database the Lightning database that holds the app tables
 */
function createInsights({ zetaris, database }) {
  if (!IDENTIFIER.test(String(database || ''))) {
    throw new Error(`"${database}" is not a valid Zetaris database name.`);
  }

  async function runOne(insight) {
    const sql = insight.sql(database);
    const described = {
      id: insight.id,
      title: insight.title,
      description: insight.description,
      kind: insight.kind,
      bar: insight.bar ?? null,
      sql
    };
    const startedAt = Date.now();
    try {
      const result = await zetaris.runSql(sql, { limit: ROW_LIMIT });
      return {
        ...described,
        columns: result.headers,
        rows: result.rows.map(row => row.map(cell)),
        error: null,
        ms: Date.now() - startedAt
      };
    } catch (error) {
      console.warn(`Insights: "${insight.id}" failed: ${error?.message || error}`);
      return {
        ...described,
        columns: [],
        rows: [],
        error: safeError(error),
        ms: Date.now() - startedAt
      };
    }
  }

  async function run() {
    const items = await inParallel(INSIGHTS, MAX_PARALLEL, runOne);
    return { database, generatedAt: new Date().toISOString(), items };
  }

  return { run };
}

module.exports = {
  DEFAULT_ERROR,
  INSIGHTS,
  MAX_PARALLEL,
  ROW_LIMIT,
  createInsights,
  describeFreshness,
  safeError
};
