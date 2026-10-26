'use strict';

/**
 * Meterless Runtime URL handling.
 *
 * The runtime's OpenAI-compatible surface always lives at <origin>/v1. Users
 * paste all kinds of values (`localhost:8088`, `/v1/models`, `/healthz`,
 * `/v1/chat/completions`, ...), so every entry point funnels through
 * `normalizeBaseUrl` and we never build `/v1/v1`.
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:8088/v1';
const DEFAULT_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const DEFAULT_PORTS = [8088, 8090, 8787, 11434];

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function withCode(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cleanInput(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/^[<"']+/, '')
    .replace(/[>"']+$/, '');
}

function toUrl(value) {
  const cleaned = cleanInput(value);
  if (!cleaned) {
    throw withCode('invalid_url', 'Base URL is required.');
  }

  let candidate = cleaned;
  if (candidate.startsWith('//')) {
    candidate = `http:${candidate}`;
  } else if (!SCHEME_RE.test(candidate)) {
    candidate = `http://${candidate}`;
  }

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw withCode('invalid_url', 'That base URL could not be parsed.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw withCode('invalid_url', 'Base URL must use http:// or https://.');
  }
  if (!url.hostname) {
    throw withCode('invalid_url', 'Base URL must include a host.');
  }

  return url;
}

/**
 * Normalise anything the user pastes to `<origin>/v1`.
 *
 * Examples:
 *   localhost:8088                     -> http://localhost:8088/v1
 *   http://localhost:8088/v1/models    -> http://localhost:8088/v1
 *   http://localhost:8088/healthz      -> http://localhost:8088/v1
 *   http://localhost:8088/v1/v1        -> http://localhost:8088/v1
 *   [::1]:8088                         -> http://[::1]:8088/v1
 */
function normalizeBaseUrl(value) {
  const url = toUrl(value);
  return `${url.origin}/v1`;
}

/**
 * Parse `http://<host>:<port>/connect#k=<key>`.
 *
 * The fragment never leaves the browser normally, and the key must never be
 * logged. The returned object is the only place the key is exposed.
 */
function parseConnectLink(value) {
  const url = toUrl(value);
  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  const params = new URLSearchParams(hash);
  const token = params.get('k') || params.get('key') || params.get('token') || '';

  if (!token) {
    throw withCode('invalid_connect_link', 'Connect link is missing the k key.');
  }

  return {
    baseUrl: `${url.origin}/v1`,
    token
  };
}

function isConnectLink(value) {
  try {
    const url = toUrl(value);
    const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
    return new URLSearchParams(hash).has('k');
  } catch {
    return false;
  }
}

/**
 * Auto Detect probes these in order. Port order comes first so the default
 * port always wins when more than one runtime is running.
 */
function detectCandidates() {
  const candidates = [];
  for (const port of DEFAULT_PORTS) {
    for (const host of DEFAULT_HOSTS) {
      candidates.push({
        host,
        port,
        baseUrl: `http://${host}:${port}/v1`
      });
    }
  }
  return candidates;
}

/**
 * `/healthz` only proves the process is up. It is used for diagnostics, never
 * for deciding provider status.
 */
function healthUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl).replace(/\/v1$/, '')}/healthz`;
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_HOSTS,
  DEFAULT_PORTS,
  detectCandidates,
  healthUrl,
  isConnectLink,
  normalizeBaseUrl,
  parseConnectLink
};
