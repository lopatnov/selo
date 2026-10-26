'use strict';

/**
 * Load the project `.env` for a host run.
 *
 * `dotenv.config()` never overrides an existing `process.env` value, so on
 * Windows a user-level variable (for example `ZETARIS_REST_URL` left over from
 * another Zetaris project, pointing at a dead port) silently wins over `.env`.
 * That is exactly how a correct `.env` kept being ignored.
 *
 * Rule used here:
 *
 *   - Provider credentials (ZETARIS_*, METERLESS_*) follow the file: if `.env`
 *     defines them, `.env` wins.
 *   - Everything else keeps plain dotenv semantics, so a harness can still
 *     inject `PORT` / `SELO_STATE_FILE` and be heard.
 *
 * Inside the container there is no `.env`, so nothing changes.
 */

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const PROVIDER_PREFIXES = ['ZETARIS_', 'METERLESS_'];

function isProviderKey(key) {
  return PROVIDER_PREFIXES.some(prefix => key.startsWith(prefix));
}

/**
 * @returns {{ file: string, parsed: Record<string, string>, overridden: string[] }}
 * `overridden` lists the provider keys where an inherited value was replaced by
 * the one in `.env`.
 */
function loadEnv(options = {}) {
  const file = options.path || path.join(__dirname, '..', '.env');

  let parsed = {};
  try {
    if (fs.existsSync(file)) parsed = dotenv.parse(fs.readFileSync(file));
  } catch {
    parsed = {};
  }

  // Normal pass first: fills in whatever the environment does not define.
  dotenv.config({ path: file });

  const overridden = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!isProviderKey(key)) continue;
    if (process.env[key] === value) continue;
    if (process.env[key] !== undefined) overridden.push(key);
    process.env[key] = value;
  }

  return { file, parsed, overridden };
}

module.exports = { isProviderKey, loadEnv };
