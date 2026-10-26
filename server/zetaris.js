'use strict';

/**
 * Zetaris Lightning REST client.
 *
 * The only supported contract is the SQL editor route:
 *
 *   POST <rest url>/sql-editor/sqls/run
 *     Authorization: Bearer <ZETARIS_API_KEY>
 *     X-Org-ID: <numeric organisation id>       (not the organisation name)
 *     X-Request-ID: <uuid>
 *     body: { queryId, sql, source: "SqlEditor", limit }
 *   ->    { headers: [...], data: [[...], ...], total, timeUsed }
 *
 * There is no `/users`, `/news` or `/comments` REST resource on a Zetaris
 * instance: the app keeps its own collections in memory and uses Zetaris as the
 * SQL/analytics surface. Anything else is a guess, so it is not built here.
 */

const { randomUUID } = require('node:crypto');

const PROVIDER_ID = 'zetaris';
const PROVIDER_NAME = 'Zetaris';
const DEFAULT_REST_URL = 'http://127.0.0.1:8888/api/v1.0';
const DEFAULT_ORG_ID = '1';
const QUERY_TIMEOUT_MS = 120_000;
const DEFAULT_LIMIT = 100;

class ZetarisError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ZetarisError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.cause) this.cause = options.cause;
  }
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * ZETARIS_REST_URL wins. Otherwise ZETARIS_URL is accepted either as an origin
 * (`http://api:8888`) or as a full REST base (`http://api:8888/api/v1.0`).
 */
function resolveRestUrl(env = process.env) {
  const explicit = clean(env.ZETARIS_REST_URL);
  const raw = explicit || clean(env.ZETARIS_URL) || DEFAULT_REST_URL;
  const withoutSlash = raw.replace(/\/+$/, '');
  if (/\/api\/v1\.0$/i.test(withoutSlash)) return withoutSlash;

  const withScheme = /^https?:\/\//i.test(withoutSlash) ? withoutSlash : `http://${withoutSlash}`;
  try {
    const url = new URL(withScheme);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}/api/v1.0`.replace(/\/{2,}/g, '/').replace(':/', '://');
  } catch {
    return DEFAULT_REST_URL;
  }
}

function createZetaris(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    throw new Error('Zetaris client needs a fetch implementation.');
  }

  function apiKey() {
    return clean(env.ZETARIS_API_KEY);
  }

  function orgId() {
    const raw = clean(options.orgId || env.ZETARIS_ORG_ID) || DEFAULT_ORG_ID;
    return raw;
  }

  function baseUrl() {
    return (options.restUrl || resolveRestUrl(env)).replace(/\/+$/, '');
  }

  function getConfig() {
    const key = apiKey();
    return {
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      kind: 'sql-rest',
      restUrl: baseUrl(),
      orgId: orgId(),
      envManaged: true,
      hasKey: Boolean(key),
      keySource: key ? 'env' : 'none',
      queryTimeoutMs: QUERY_TIMEOUT_MS
    };
  }

  function headers(extra = {}) {
    const key = apiKey();
    if (!key) {
      throw new ZetarisError(
        'unconfigured',
        'ZETARIS_API_KEY is not set. Create an API key in the Zetaris GUI and put it in .env.'
      );
    }
    if (!/^\d+$/.test(orgId())) {
      throw new ZetarisError(
        'invalid_org',
        `ZETARIS_ORG_ID must be the numeric organisation id, not "${orgId()}".`
      );
    }
    return {
      Authorization: `Bearer ${key}`,
      'X-Org-ID': orgId(),
      'X-Request-ID': randomUUID(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...extra
    };
  }

  async function runSql(sql, { limit = DEFAULT_LIMIT } = {}) {
    const statement = clean(sql);
    if (!statement) throw new ZetarisError('invalid_request', 'SQL statement is required.');

    const body = {
      queryId: randomUUID(),
      sql: statement,
      source: 'SqlEditor',
      limit
    };

    // Build the headers outside the try: a missing key or a non-numeric org id
    // is a configuration error, not an unreachable server.
    const requestHeaders = headers();

    let response;
    try {
      response = await fetchImpl(`${baseUrl()}/sql-editor/sqls/run`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS)
      });
    } catch (error) {
      const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new ZetarisError(
        'offline',
        timedOut
          ? `Zetaris did not answer within ${Math.round(QUERY_TIMEOUT_MS / 1000)} s.`
          : 'Could not reach Zetaris.',
        { cause: error }
      );
    }

    const text = await response.text().catch(() => '');

    if (response.status === 401 || response.status === 403) {
      throw new ZetarisError('unauthorized', 'Zetaris refused ZETARIS_API_KEY.', {
        status: response.status
      });
    }
    // "Not Allowed" is what Zetaris returns when the key is valid but the
    // X-Org-ID is not the numeric id that owns it.
    if (response.status === 400 && /not allowed/i.test(text)) {
      throw new ZetarisError(
        'unauthorized',
        `Zetaris refused the key for X-Org-ID ${orgId()}. Use the numeric organisation id that owns ZETARIS_API_KEY.`,
        { status: response.status }
      );
    }
    if (!response.ok) {
      throw new ZetarisError(
        'offline',
        `Zetaris answered HTTP ${response.status}: ${text.slice(0, 200)}`,
        { status: response.status }
      );
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new ZetarisError('invalid_response', 'Zetaris answered with invalid JSON.', {
        cause: error
      });
    }

    const rows = Array.isArray(data?.data) ? data.data : null;
    if (!rows) {
      throw new ZetarisError('invalid_response', 'Zetaris answered without a data array.', {
        status: response.status
      });
    }

    return {
      headers: Array.isArray(data.headers) ? data.headers : [],
      rows,
      total: typeof data.total === 'number' ? data.total : rows.length,
      timeUsedMs: typeof data.timeUsed === 'number' ? data.timeUsed : null
    };
  }

  /**
   * The honest state: `SELECT 1` must come back with one row containing 1.
   */
  async function probe() {
    const checkedAt = new Date().toISOString();
    const startedAt = Date.now();

    if (!apiKey()) {
      return {
        status: 'unconfigured',
        reason: 'ZETARIS_API_KEY is not set.',
        restUrl: baseUrl(),
        orgId: orgId(),
        latencyMs: 0,
        checkedAt
      };
    }

    try {
      const result = await runSql('SELECT 1 AS one', { limit: 1 });
      const first = Array.isArray(result.rows[0]) ? result.rows[0][0] : undefined;
      const latencyMs = Date.now() - startedAt;
      if (String(first) !== '1') {
        return {
          status: 'offline',
          reason: 'SELECT 1 returned no 1.',
          restUrl: baseUrl(),
          orgId: orgId(),
          latencyMs,
          checkedAt
        };
      }
      return {
        status: 'online',
        restUrl: baseUrl(),
        orgId: orgId(),
        latencyMs,
        queryTimeMs: result.timeUsedMs,
        checkedAt
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      // A configuration mistake is not an outage: say so instead of "offline".
      const status =
        error.code === 'unconfigured' || error.code === 'invalid_org'
          ? 'unconfigured'
          : error.code === 'unauthorized'
            ? 'unauthorized'
            : 'offline';
      return {
        status,
        reason: error.message,
        restUrl: baseUrl(),
        orgId: orgId(),
        latencyMs,
        checkedAt
      };
    }
  }

  /**
   * `SHOW DATABASES` is rejected by this build; `SHOW LIGHTNING DATABASES` is
   * the supported catalogue statement.
   */
  async function listDatabases() {
    const result = await runSql('SHOW LIGHTNING DATABASES', { limit: DEFAULT_LIMIT });
    return result.rows
      .map(row => (Array.isArray(row) ? row[0] : row))
      .filter(Boolean)
      .map(String);
  }

  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    kind: 'sql-rest',
    descriptor: getConfig,
    getConfig,
    runSql,
    probe,
    listDatabases
  };
}

module.exports = {
  DEFAULT_LIMIT,
  DEFAULT_ORG_ID,
  DEFAULT_REST_URL,
  PROVIDER_ID,
  PROVIDER_NAME,
  QUERY_TIMEOUT_MS,
  ZetarisError,
  createZetaris,
  resolveRestUrl
};
