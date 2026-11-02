'use strict';

/**
 * Zetaris Lightning REST client.
 *
 * Two documented contracts are used. The SQL editor route:
 *
 *   POST <rest url>/sql-editor/sqls/run
 *     Authorization: Bearer <api key or ID token>
 *     X-Org-ID: <numeric organisation id>       (not the organisation name)
 *     X-Request-ID: <uuid>
 *     body: { queryId, sql, source: "SqlEditor", limit }
 *   ->    { headers: [...], data: [[...], ...], total, timeUsed }
 *
 * Two ways to get the bearer token, exactly like the hackathon reference:
 *
 *   1. ZETARIS_API_KEY - a key created in the Zetaris GUI. Used as-is.
 *   2. ZETARIS_USERNAME + ZETARIS_PASSWORD - the UI login. Exchanged for an
 *      ID token with `POST <ZETARIS_BASE_URL>/api/auth/login`, cached until it
 *      expires and refreshed once if the API answers 401/403.
 *
 * and the NDP file routes (`/ndp-files/save|list|createdir|delete`), which is
 * how files reach the Zetaris file store.
 *
 * There is no `/users`, `/news` or `/comments` REST resource on a Zetaris
 * instance and no INSERT/UPDATE/DELETE: rows are written as files and read
 * back through file-store tables (see `zetaris-store.js`). Anything else is a
 * guess, so it is not built here.
 */

const { randomUUID } = require('node:crypto');

const PROVIDER_ID = 'zetaris';
const PROVIDER_NAME = 'Zetaris';
const DEFAULT_REST_URL = 'http://127.0.0.1:8888/api/v1.0';
const DEFAULT_UI_URL = 'http://localhost:3000';
const DEFAULT_ORG_ID = '1';
const QUERY_TIMEOUT_MS = 120_000;
const FILE_TIMEOUT_MS = 60_000;
const LOGIN_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 100;
// Refresh a login token slightly before it expires instead of on the 401.
const TOKEN_SKEW_MS = 60_000;

class ZetarisError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ZetarisError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.cause) this.cause = options.cause;
  }
}

const isRefusal = status => status === 401 || status === 403;

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ZetarisError('invalid_response', `Zetaris answered with invalid JSON (${what}).`, {
      cause: error
    });
  }
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function withoutTrailingSlashes(value) {
  return String(value).replace(/\/+$/, '');
}

/**
 * ZETARIS_REST_URL wins. Otherwise ZETARIS_URL is accepted either as an origin
 * (`http://api:8888`) or as a full REST base (`http://api:8888/api/v1.0`).
 */
function resolveRestUrl(env = process.env) {
  const explicit = clean(env.ZETARIS_REST_URL);
  const raw = explicit || clean(env.ZETARIS_URL) || DEFAULT_REST_URL;
  const withoutSlash = withoutTrailingSlashes(raw);
  if (/\/api\/v1\.0$/i.test(withoutSlash)) return withoutSlash;

  const withScheme = /^https?:\/\//i.test(withoutSlash) ? withoutSlash : `http://${withoutSlash}`;
  try {
    const url = new URL(withScheme);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}/api/v1.0`.replace(/\/{2,}/g, '/').replace(':/', '://');
  } catch {
    return DEFAULT_REST_URL;
  }
}

/**
 * ZETARIS_BASE_URL is the web UI origin (`http://localhost:3000`). A trailing
 * slash or a stray path (`/api/v1.0`) is dropped: only the origin is used.
 */
function resolveUiUrl(env = process.env) {
  const raw = clean(env.ZETARIS_BASE_URL) || DEFAULT_UI_URL;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return DEFAULT_UI_URL;
  }
}

/** `exp` from a JWT, in ms. `null` when the token is opaque or malformed. */
function tokenExpiryMs(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function createZetaris(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    throw new Error('Zetaris client needs a fetch implementation.');
  }

  // One cached UI login token per client instance.
  let loginToken = null;

  function apiKey() {
    return clean(env.ZETARIS_API_KEY);
  }

  function username() {
    return clean(env.ZETARIS_USERNAME);
  }

  function password() {
    return clean(env.ZETARIS_PASSWORD);
  }

  function hasCredentials() {
    return Boolean(username() && password());
  }

  function authMode() {
    if (apiKey()) return 'api-key';
    if (hasCredentials()) return 'login';
    return 'none';
  }

  function orgId() {
    const raw = clean(options.orgId || env.ZETARIS_ORG_ID) || DEFAULT_ORG_ID;
    return raw;
  }

  function baseUrl() {
    return withoutTrailingSlashes(options.restUrl || resolveRestUrl(env));
  }

  function uiUrl() {
    return withoutTrailingSlashes(options.uiUrl || resolveUiUrl(env));
  }

  function userAgent() {
    // Quotes belong to the .env syntax, not to the header value.
    return clean(env.ZETARIS_USER_AGENT).replace(/^["']|["']$/g, '');
  }

  function getConfig() {
    return {
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      kind: 'sql-rest',
      restUrl: baseUrl(),
      uiUrl: uiUrl(),
      orgId: orgId(),
      envManaged: true,
      authMode: authMode(),
      hasKey: Boolean(apiKey()),
      hasPassword: hasCredentials(),
      keySource: apiKey() ? 'env' : hasCredentials() ? 'login' : 'none',
      userAgent: userAgent() || null,
      queryTimeoutMs: QUERY_TIMEOUT_MS
    };
  }

  function baseHeaders(extra = {}) {
    const agent = userAgent();
    const headers = {
      'X-Org-ID': orgId(),
      'X-Request-ID': randomUUID(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(agent ? { 'User-Agent': agent } : {}),
      ...extra
    };
    return headers;
  }

  /**
   * Exchange ZETARIS_USERNAME / ZETARIS_PASSWORD for an ID token on the UI.
   * Only used when ZETARIS_API_KEY is empty.
   */
  async function login() {
    const body = JSON.stringify({ username: username(), password: password() });

    let response;
    try {
      response = await fetchImpl(`${uiUrl()}/api/auth/login`, {
        method: 'POST',
        headers: baseHeaders(),
        body,
        signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS)
      });
    } catch (error) {
      const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new ZetarisError(
        'offline',
        timedOut
          ? `The Zetaris UI at ${uiUrl()} did not answer the login within ${Math.round(LOGIN_TIMEOUT_MS / 1000)} s.`
          : `Could not reach the Zetaris UI at ${uiUrl()} to log in.`,
        { cause: error }
      );
    }

    const text = await response.text().catch(() => '');

    if (response.status === 401 || response.status === 403) {
      throw new ZetarisError(
        'unauthorized',
        `Zetaris refused ZETARIS_USERNAME / ZETARIS_PASSWORD (HTTP ${response.status}).`,
        { status: response.status }
      );
    }
    if (!response.ok) {
      throw new ZetarisError(
        'offline',
        `Zetaris login answered HTTP ${response.status}: ${text.slice(0, 200)}`,
        { status: response.status }
      );
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new ZetarisError('invalid_response', 'Zetaris login answered with invalid JSON.', {
        cause: error
      });
    }

    const token =
      (payload && (payload.idToken || payload.token || payload.accessToken)) || null;
    if (!token) {
      throw new ZetarisError('invalid_response', 'Zetaris login did not return an access token.');
    }

    loginToken = { token, expiresAt: tokenExpiryMs(token), source: 'login' };
    return loginToken;
  }

  /** The bearer token to send, plus where it came from. */
  async function auth() {
    if (!apiKey()) {
      if (!hasCredentials()) {
        throw new ZetarisError(
          'unconfigured',
          'Set ZETARIS_API_KEY, or both ZETARIS_USERNAME and ZETARIS_PASSWORD, in .env.'
        );
      }
      const stillValid =
        loginToken &&
        (!loginToken.expiresAt || loginToken.expiresAt - TOKEN_SKEW_MS > Date.now());
      return stillValid ? loginToken : login();
    }
    return { token: apiKey(), expiresAt: null, source: 'api-key' };
  }

  function authorizedHeaders(token) {
    if (!/^\d+$/.test(orgId())) {
      throw new ZetarisError(
        'invalid_org',
        `ZETARIS_ORG_ID must be the numeric organisation id, not "${orgId()}".`
      );
    }
    return baseHeaders({ Authorization: `Bearer ${token}` });
  }

  function unreachableMessage(error) {
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    if (timedOut) {
      return `Zetaris did not answer within ${Math.round(QUERY_TIMEOUT_MS / 1000)} s.`;
    }
    const refused =
      error && (error.cause?.code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(error.message || ''));
    const base = `Could not reach Zetaris at ${baseUrl()}.`;
    return refused
      ? `${base} Nothing is listening on that port. On Windows the TCP range ` +
          `8871-9070 is reserved ("netsh interface ipv4 show excludedportrange protocol=tcp"), ` +
          `so a Docker mapping for 8888/8889 can exist without a host listener: publish the API ` +
          `on a free port (for example 14088) and point ZETARIS_REST_URL at it.`
      : base;
  }

  /**
   * One authorised request. Shared by the SQL route and the file routes so
   * they agree on auth, the single 401 retry for a login token, and how a
   * failure is reported. Resolves with the response body text.
   */
  async function call(path, { method = 'GET', body, search, timeoutMs = QUERY_TIMEOUT_MS } = {}) {
    const query = search ? `?${search}` : '';
    const url = `${baseUrl()}${path}${query}`;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      // A missing key/credentials or a non-numeric org id is a configuration
      // error, not an unreachable server, so it surfaces before any request.
      const credentials = await auth();
      const headers = authorizedHeaders(credentials.token);
      // A multipart body needs the boundary fetch generates, not our JSON type.
      if (body instanceof FormData) delete headers['Content-Type'];

      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (error) {
        throw new ZetarisError('offline', unreachableMessage(error), { cause: error });
      }

      const text = await response.text().catch(() => '');

      // A cached login token can expire mid-flight: drop it and retry once.
      if (isRefusal(response.status) && credentials.source === 'login' && attempt === 0) {
        loginToken = null;
        continue;
      }

      const failure = failureFor(response, text);
      if (failure) throw failure;

      return { status: response.status, text };
    }

    // Unreachable: the loop either returns or throws.
    throw new ZetarisError('unauthorized', 'Zetaris refused the bearer token.');
  }

  /** The error a non-success answer stands for, or `null` when it is a success. */
  function failureFor(response, text) {
    const { status } = response;
    if (isRefusal(status)) {
      return new ZetarisError('unauthorized', 'Zetaris refused the bearer token.', { status });
    }
    // "Not Allowed" is what Zetaris returns when the key is valid but the
    // X-Org-ID is not the numeric id that owns it.
    if (status === 400 && /not allowed/i.test(text)) {
      return new ZetarisError(
        'unauthorized',
        `Zetaris refused the token for X-Org-ID ${orgId()}. Use the numeric organisation id that owns ZETARIS_API_KEY / ZETARIS_USERNAME.`,
        { status }
      );
    }
    if (!response.ok) {
      return new ZetarisError(
        'offline',
        `Zetaris answered HTTP ${status}: ${text.slice(0, 200)}`,
        { status }
      );
    }
    return null;
  }

  async function runSql(sql, { limit = DEFAULT_LIMIT } = {}) {
    const statement = clean(sql);
    if (!statement) throw new ZetarisError('invalid_request', 'SQL statement is required.');

    const { status, text } = await call('/sql-editor/sqls/run', {
      method: 'POST',
      body: JSON.stringify({
        queryId: randomUUID(),
        sql: statement,
        source: 'SqlEditor',
        limit
      })
    });

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
        status
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
   * Zetaris has no INSERT/UPDATE/DELETE. Data is written as files into the NDP
   * file system (`POST /ndp-files/save`, multipart: `path` + `files`) and read
   * back through a Lightning file-store table registered over that file.
   * `/file-store/<dir>/<name>` here is `dffs://<dir>/<name>` in SQL.
   */
  async function saveFile(directory, fileName, content, { contentType = 'text/csv' } = {}) {
    const form = new FormData();
    form.append('path', clean(directory));
    form.append('files', new Blob([content], { type: contentType }), fileName);

    const { text } = await call('/ndp-files/save', {
      method: 'POST',
      body: form,
      timeoutMs: FILE_TIMEOUT_MS
    });

    // 200 with {"results":[{"SaveSuccess":{...}}]}; a failed file is reported inside.
    const payload = parseJson(text, 'file save');
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const failed = results.find(result => !result?.SaveSuccess);
    if (failed || results.length === 0) {
      throw new ZetarisError(
        'write_failed',
        `Zetaris did not save ${directory}/${fileName}: ${JSON.stringify(failed || results).slice(0, 200)}`
      );
    }
  }

  /** Entries of a directory (`FileInfo[]`); a missing directory answers HTTP 400. */
  async function listFiles(directory) {
    const { text } = await call('/ndp-files/list', {
      search: new URLSearchParams({ path: clean(directory) }).toString(),
      timeoutMs: FILE_TIMEOUT_MS
    });
    const entries = parseJson(text, 'file list');
    return Array.isArray(entries) ? entries : [];
  }

  async function createDirectory(directory) {
    await call('/ndp-files/createdir', {
      method: 'POST',
      body: JSON.stringify({ path: clean(directory) }),
      timeoutMs: FILE_TIMEOUT_MS
    });
  }

  async function deleteFiles(paths, { recursive = false } = {}) {
    const search = new URLSearchParams();
    for (const path of paths) search.append('paths', path);
    await call(recursive ? '/ndp-files/delete/all' : '/ndp-files/delete', {
      method: 'DELETE',
      search: search.toString(),
      timeoutMs: FILE_TIMEOUT_MS
    });
  }

  /**
   * The honest state: `SELECT 1` must come back with one row containing 1.
   */
  async function probe() {
    const checkedAt = new Date().toISOString();
    const startedAt = Date.now();

    if (authMode() === 'none') {
      return {
        status: 'unconfigured',
        reason: 'Neither ZETARIS_API_KEY nor ZETARIS_USERNAME/ZETARIS_PASSWORD is set.',
        restUrl: baseUrl(),
        orgId: orgId(),
        authMode: authMode(),
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
          authMode: authMode(),
          latencyMs,
          checkedAt
        };
      }
      return {
        status: 'online',
        restUrl: baseUrl(),
        orgId: orgId(),
        authMode: authMode(),
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
        authMode: authMode(),
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
    saveFile,
    listFiles,
    createDirectory,
    deleteFiles,
    probe,
    listDatabases
  };
}

module.exports = {
  DEFAULT_LIMIT,
  DEFAULT_ORG_ID,
  DEFAULT_REST_URL,
  DEFAULT_UI_URL,
  PROVIDER_ID,
  PROVIDER_NAME,
  QUERY_TIMEOUT_MS,
  ZetarisError,
  createZetaris,
  resolveRestUrl,
  resolveUiUrl,
  tokenExpiryMs
};
