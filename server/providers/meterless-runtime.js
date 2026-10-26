'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_BASE_URL,
  detectCandidates,
  healthUrl,
  normalizeBaseUrl,
  parseConnectLink
} = require('./base-url');
const { SettingsStore, defaultSettingsFile } = require('./settings-store');

const PROVIDER_ID = 'meterless';
const PROVIDER_NAME = 'Meterless Runtime';
const PROVIDER_KIND = 'openai-compatible';
const DEFAULT_APP_ID = 'ai-news-discussion';

const APP_HEADER = 'meterless-app';
const SCOPE_HEADER = 'meterless-scope';
const CHAT_SCOPE = 'user';

// A cold model load can take minutes. Short timeouts look like outages.
const CHAT_TIMEOUT_MS = 180_000;
const STATUS_TIMEOUT_MS = 15_000;
const MODELS_TIMEOUT_MS = 20_000;
const DETECT_TIMEOUT_MS = 2_500;

const KEY_TOKEN = 'meterless_runtime_token';
const KEY_BASE_URL = 'meterless_base_url';
const REJECTED_TOKEN = 'rt-local';

const DEFAULT_DISPOSITIONS = ['auto', 'fast', 'deep', 'cheap', 'local', 'fusion'].map(
  disposition => `meterless/${disposition}`
);

class ProviderError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.cause) this.cause = options.cause;
  }
}

function isUsableToken(value) {
  if (typeof value !== 'string') return false;
  const token = value.trim();
  return token.length > 0 && token.toLowerCase() !== REJECTED_TOKEN;
}

function normalizeAppId(value) {
  const slug = String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || DEFAULT_APP_ID;
}

function extractModelIds(body) {
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  const ids = [];
  const seen = new Set();
  for (const entry of list) {
    const id = typeof entry === 'string' ? entry : entry && typeof entry.id === 'string' ? entry.id : '';
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function createMeterlessRuntime(options = {}) {
  const env = options.env || process.env;
  const store = options.settings || new SettingsStore(options.settingsFile || defaultSettingsFile());
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const appId = normalizeAppId(options.appId || env.METERLESS_APP_ID || DEFAULT_APP_ID);
  const stateDir =
    options.stateDir || env.METERLESS_STATE_DIR || path.join(os.homedir(), '.meterless');

  if (typeof fetchImpl !== 'function') {
    throw new Error('Meterless Runtime provider needs a fetch implementation.');
  }

  function readProxyToken() {
    try {
      const raw = fs.readFileSync(path.join(stateDir, 'proxy-token'), 'utf8').trim();
      return raw || null;
    } catch {
      return null;
    }
  }

  /**
   * Precedence: a token saved from the UI wins, then the environment (so a
   * fresh install is configured straight from .env), then the runtime's own
   * proxy-token file. METERLESS_RUNTIME_TOKEN is the runtime's native name;
   * METERLESS_API_KEY is the one this deployment already ships.
   */
  function resolveToken() {
    const stored = store.get(KEY_TOKEN);
    if (isUsableToken(stored)) {
      return { token: stored.trim(), source: 'settings' };
    }
    for (const name of ['METERLESS_RUNTIME_TOKEN', 'METERLESS_API_KEY']) {
      const value = env[name];
      if (isUsableToken(value)) {
        return { token: String(value).trim(), source: 'env', envVar: name };
      }
    }
    const fromFile = readProxyToken();
    if (isUsableToken(fromFile)) {
      return { token: fromFile, source: 'proxy-token' };
    }
    return { token: null, source: 'none' };
  }

  function resolveBaseUrl() {
    const stored = store.get(KEY_BASE_URL) || env.METERLESS_BASE_URL || DEFAULT_BASE_URL;
    try {
      return normalizeBaseUrl(stored);
    } catch {
      return DEFAULT_BASE_URL;
    }
  }

  function getConfig() {
    const { token, source, envVar } = resolveToken();
    return {
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      kind: PROVIDER_KIND,
      baseUrl: resolveBaseUrl(),
      defaultBaseUrl: DEFAULT_BASE_URL,
      appId,
      hasToken: Boolean(token),
      tokenSource: source,
      tokenEnvVar: envVar || null,
      chatTimeoutMs: CHAT_TIMEOUT_MS
    };
  }

  function saveConfig(values = {}) {
    const updates = {};

    if (values.baseUrl !== undefined && values.baseUrl !== null && values.baseUrl !== '') {
      updates[KEY_BASE_URL] = normalizeBaseUrl(values.baseUrl);
    }

    if (values.token !== undefined) {
      const token = typeof values.token === 'string' ? values.token.trim() : '';
      if (token.toLowerCase() === REJECTED_TOKEN) {
        throw new ProviderError(
          'invalid_token',
          'The placeholder token rt-local is rejected. Paste the real token from <stateDir>/proxy-token.'
        );
      }
      if (token) updates[KEY_TOKEN] = token;
      else store.delete(KEY_TOKEN);
    }

    if (Object.keys(updates).length > 0) store.setMany(updates);
    return getConfig();
  }

  function connect(link) {
    const parsed = parseConnectLink(link);
    if (!isUsableToken(parsed.token)) {
      throw new ProviderError('invalid_token', 'The connect link does not contain a usable token.');
    }
    store.setMany({
      [KEY_BASE_URL]: parsed.baseUrl,
      [KEY_TOKEN]: parsed.token
    });
    return getConfig();
  }

  function buildHeaders({ json = false, scope = null } = {}) {
    const headers = {
      Accept: 'application/json',
      [APP_HEADER]: appId
    };
    if (json) headers['Content-Type'] = 'application/json';

    const { token } = resolveToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (scope) headers[SCOPE_HEADER] = scope;

    return headers;
  }

  async function fetchJson(url, requestOptions, timeoutMs) {
    const response = await fetchImpl(url, {
      ...requestOptions,
      signal: AbortSignal.timeout(timeoutMs)
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { response, body };
  }

  function describeFailure(error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return 'Timed out contacting /v1/models.';
    }
    return 'Could not reach /v1/models.';
  }

  async function checkStatusFor(baseUrl, timeoutMs = STATUS_TIMEOUT_MS) {
    const startedAt = Date.now();
    try {
      const { response, body } = await fetchJson(
        `${baseUrl}/models`,
        { method: 'GET', headers: buildHeaders() },
        timeoutMs
      );

      const base = {
        baseUrl,
        httpStatus: response.status,
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString()
      };

      if (response.status === 401 || response.status === 403) {
        return { status: 'unauthorized', ...base };
      }

      if (response.status === 200) {
        const ids = extractModelIds(body);
        const hasMeterlessIds = ids.some(id => id.startsWith('meterless/'));
        if (hasMeterlessIds) {
          return { status: 'online', modelCount: ids.length, ...base };
        }
        return {
          status: 'offline',
          reason: 'The runtime answered but returned no meterless/* model ids.',
          ...base
        };
      }

      return {
        status: 'offline',
        reason: `Unexpected HTTP ${response.status} from /v1/models.`,
        ...base
      };
    } catch (error) {
      return {
        status: 'offline',
        reason: describeFailure(error),
        baseUrl,
        httpStatus: null,
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString()
      };
    }
  }

  function getStatus() {
    return checkStatusFor(resolveBaseUrl());
  }

  async function listModels() {
    const baseUrl = resolveBaseUrl();
    try {
      const { response, body } = await fetchJson(
        `${baseUrl}/models`,
        { method: 'GET', headers: buildHeaders() },
        MODELS_TIMEOUT_MS
      );

      if (response.status === 401 || response.status === 403) {
        return {
          status: 'unauthorized',
          httpStatus: response.status,
          models: DEFAULT_DISPOSITIONS,
          source: 'defaults'
        };
      }

      if (response.status !== 200) {
        return {
          status: 'offline',
          httpStatus: response.status,
          models: DEFAULT_DISPOSITIONS,
          source: 'defaults'
        };
      }

      // Keep every meterless/* id, including routing modes this app has never
      // heard of. The runtime owns the model catalogue.
      const models = extractModelIds(body).filter(id => id.startsWith('meterless/'));
      if (models.length === 0) {
        return {
          status: 'offline',
          httpStatus: 200,
          models: DEFAULT_DISPOSITIONS,
          source: 'defaults'
        };
      }

      return {
        status: 'online',
        httpStatus: 200,
        models,
        source: 'runtime'
      };
    } catch (error) {
      return {
        status: 'offline',
        httpStatus: null,
        models: DEFAULT_DISPOSITIONS,
        source: 'defaults',
        reason: describeFailure(error)
      };
    }
  }

  async function chat({ model = 'meterless/auto', messages = [], ...chatOptions } = {}) {
    const baseUrl = resolveBaseUrl();
    const body = {
      ...chatOptions,
      model,
      messages
    };
    if (body.stream === undefined) body.stream = false;

    let response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: buildHeaders({ json: true, scope: CHAT_SCOPE }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS)
      });
    } catch (error) {
      const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new ProviderError(
        'offline',
        timedOut
          ? 'Meterless Runtime did not answer the chat request within 180 s.'
          : 'Could not reach Meterless Runtime.',
        { cause: error }
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new ProviderError(
        'unauthorized',
        'Meterless Runtime rejected the token. Paste the token from <stateDir>/proxy-token.',
        { status: response.status }
      );
    }

    if (!response.ok) {
      throw new ProviderError('offline', `Meterless Runtime returned HTTP ${response.status}.`, {
        status: response.status
      });
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw new ProviderError('invalid_response', 'Meterless Runtime returned invalid JSON.', {
        cause: error
      });
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new ProviderError('invalid_response', 'Meterless Runtime returned no text content.');
    }

    return content;
  }

  async function autoDetect() {
    const candidates = detectCandidates();
    const tried = [];

    for (const candidate of candidates) {
      const result = await checkStatusFor(candidate.baseUrl, DETECT_TIMEOUT_MS);
      tried.push({ baseUrl: candidate.baseUrl, status: result.status });

      if (result.status === 'online' || result.status === 'unauthorized') {
        store.set(KEY_BASE_URL, candidate.baseUrl);
        return {
          found: true,
          baseUrl: candidate.baseUrl,
          status: result.status,
          httpStatus: result.httpStatus,
          tried: tried.length,
          candidates: tried
        };
      }
    }

    return {
      found: false,
      baseUrl: resolveBaseUrl(),
      status: 'offline',
      tried: tried.length,
      candidates: tried
    };
  }

  async function checkHealth() {
    const baseUrl = resolveBaseUrl();
    try {
      const response = await fetchImpl(healthUrl(baseUrl), {
        method: 'GET',
        headers: buildHeaders(),
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS)
      });
      return {
        up: response.ok,
        httpStatus: response.status,
        note: '/healthz only proves the process is up; /v1/models decides status.'
      };
    } catch {
      return {
        up: false,
        httpStatus: null,
        note: '/healthz only proves the process is up; /v1/models decides status.'
      };
    }
  }

  function descriptor() {
    return {
      ...getConfig(),
      envManaged: false,
      capabilities: ['chat', 'models', 'status', 'auto-detect', 'connect-link']
    };
  }

  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    kind: PROVIDER_KIND,
    appId,
    stateDir,
    descriptor,
    getConfig,
    saveConfig,
    connect,
    getStatus,
    listModels,
    chat,
    autoDetect,
    checkHealth,
    resolveToken,
    resolveBaseUrl
  };
}

module.exports = {
  APP_HEADER,
  CHAT_SCOPE,
  CHAT_TIMEOUT_MS,
  DEFAULT_APP_ID,
  DEFAULT_DISPOSITIONS,
  KEY_BASE_URL,
  KEY_TOKEN,
  MODELS_TIMEOUT_MS,
  PROVIDER_ID,
  PROVIDER_KIND,
  PROVIDER_NAME,
  ProviderError,
  REJECTED_TOKEN,
  SCOPE_HEADER,
  STATUS_TIMEOUT_MS,
  createMeterlessRuntime,
  extractModelIds,
  isUsableToken,
  normalizeAppId
};
