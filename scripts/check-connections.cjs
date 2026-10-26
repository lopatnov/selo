'use strict';

/**
 * Live connectivity check for the two external services this app depends on.
 *
 *   npm run check:connections
 *
 * It exercises the real modules the server uses (`server/providers` and
 * `server/zetaris`), so a PASS here means the app itself can talk to the
 * service. No secret is printed: only lengths/booleans.
 */

const { isProviderKey, loadEnv } = require('../server/load-env');

// Snapshot the inherited environment first so we can report which .env values
// had to beat a Windows user-level variable, and which variables exist only in
// the OS environment.
const inherited = { ...process.env };
const { parsed: ENV_FILE_VALUES, overridden: OVERRIDDEN } = loadEnv();

const FILE_KEYS = new Set(Object.keys(ENV_FILE_VALUES));

// Present in the OS environment but absent from .env: the hidden trap.
const INHERITED_ONLY = Object.keys(inherited).filter(
  key => isProviderKey(key) && !FILE_KEYS.has(key)
);

const { createMeterlessRuntime } = require('../server/providers/meterless-runtime');
const { createZetaris } = require('../server/zetaris');

function mask(value) {
  return value ? `<set ${String(value).length} chars>` : '<empty>';
}

// Windows reserves blocks of TCP ports for Hyper-V/WSL; Docker still reports a
// mapping for them but nothing listens on the host. `netsh interface ipv4 show
// excludedportrange protocol=tcp` is the authority - this is the common block.
const WINDOWS_RESERVED_TCP = [[8871, 9070]];

function reservedPortHint(url) {
  let port;
  try {
    port = Number(new URL(url).port || (url.startsWith('https') ? 443 : 80));
  } catch {
    return null;
  }
  const hit = WINDOWS_RESERVED_TCP.find(([from, to]) => port >= from && port <= to);
  if (!hit) return null;
  return (
    `port ${port} is inside the Windows reserved TCP range ${hit[0]}-${hit[1]}: ` +
    'Docker can map it but nothing will listen on the host. Publish the API on a ' +
    'free port (e.g. 14088) and set ZETARIS_REST_URL to it.'
  );
}

async function main() {
  console.log('=== Environment ===');
  if (OVERRIDDEN.length > 0) {
    console.log(`note   .env wins over the OS environment for: ${OVERRIDDEN.join(', ')}`);
  }
  if (INHERITED_ONLY.length > 0) {
    console.log(
      `note   inherited from the OS but NOT in .env: ${INHERITED_ONLY.join(', ')}`
    );
    console.log('       a Windows user-level variable will be used as-is');
  }
  console.log(`METERLESS_API_KEY      ${mask(process.env.METERLESS_API_KEY)}`);
  console.log(`METERLESS_API_URL      ${process.env.METERLESS_API_URL || '<unset>'}`);
  console.log(`METERLESS_BASE_URL     ${process.env.METERLESS_BASE_URL || '<unset>'}`);
  console.log(`ZETARIS_API_KEY        ${mask(process.env.ZETARIS_API_KEY)}`);
  console.log(`ZETARIS_USERNAME       ${mask(process.env.ZETARIS_USERNAME)}`);
  console.log(`ZETARIS_PASSWORD       ${mask(process.env.ZETARIS_PASSWORD)}`);
  console.log(`ZETARIS_ORG_ID         ${process.env.ZETARIS_ORG_ID || '<unset>'}`);
  console.log(`ZETARIS_REST_URL       ${process.env.ZETARIS_REST_URL || '<unset>'}`);
  console.log(`ZETARIS_BASE_URL       ${process.env.ZETARIS_BASE_URL || '<unset>'}`);
  console.log(`ZETARIS_URL            ${process.env.ZETARIS_URL || '<unset>'}`);
  console.log('');

  console.log('=== Meterless Runtime ===');
  const runtime = createMeterlessRuntime();
  const meterlessConfig = runtime.getConfig();
  console.log(`base url               ${meterlessConfig.baseUrl}`);
  console.log(
    `token                  ${meterlessConfig.hasToken ? meterlessConfig.tokenSource : 'MISSING'}`
  );

  const health = await runtime.checkHealth();
  console.log(`${health.up ? 'PASS' : 'FAIL'} healthz -> HTTP ${health.httpStatus}`);

  const meterlessStatus = await runtime.getStatus();
  const statusLine = `${meterlessStatus.status}${
    meterlessStatus.httpStatus ? ` (HTTP ${meterlessStatus.httpStatus})` : ''
  }${meterlessStatus.reason ? ` · ${meterlessStatus.reason}` : ''}`;
  console.log(`${meterlessStatus.status === 'online' ? 'PASS' : 'FAIL'} GET /v1/models -> ${statusLine}`);

  const models = await runtime.listModels();
  const routingModes = models.routingModes || models.models;
  const otherModels = models.otherModels || [];
  console.log(
    `     ${routingModes.length} routing mode(s) + ${otherModels.length} other runtime id(s) ` +
      `from ${models.source}: ${routingModes.slice(0, 12).join(', ')}`
  );
  console.log('');

  console.log('=== Zetaris ===');
  const zetaris = createZetaris();
  const zetarisConfig = zetaris.getConfig();
  console.log(`rest url               ${zetarisConfig.restUrl}`);
  console.log(`ui url                 ${zetarisConfig.uiUrl}`);
  console.log(`organisation id        ${zetarisConfig.orgId}`);
  console.log(`auth mode              ${zetarisConfig.authMode}`);
  console.log(`api key                ${zetarisConfig.hasKey ? 'set' : 'missing'}`);
  console.log(`user + password        ${zetarisConfig.hasPassword ? 'set' : 'missing'}`);

  const portHint = reservedPortHint(zetarisConfig.restUrl);
  if (portHint) console.log(`WARNING                ${portHint}`);

  const zetarisStatus = await zetaris.probe();
  const zetarisLine = `${zetarisStatus.status}${
    zetarisStatus.latencyMs !== undefined ? ` in ${zetarisStatus.latencyMs} ms` : ''
  }${zetarisStatus.reason ? ` · ${zetarisStatus.reason}` : ''}`;
  console.log(`${zetarisStatus.status === 'online' ? 'PASS' : 'FAIL'} SELECT 1 -> ${zetarisLine}`);

  if (zetarisStatus.status === 'online') {
    try {
      const databases = await zetaris.listDatabases();
      console.log(`PASS SHOW LIGHTNING DATABASES -> ${databases.join(', ') || '(none)'}`);
    } catch (error) {
      console.log(`FAIL SHOW LIGHTNING DATABASES -> ${error.message}`);
    }
  }
  console.log('');

  const failed =
    meterlessStatus.status !== 'online' || zetarisStatus.status !== 'online';
  if (failed) {
    console.log('One or more providers are not online. See the status lines above.');
    process.exitCode = 1;
  } else {
    console.log('Both Meterless Runtime and Zetaris are online.');
  }
}

main().catch(error => {
  console.error('check failed:', error.message);
  process.exitCode = 1;
});
