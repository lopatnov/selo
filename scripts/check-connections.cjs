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

const fs = require('node:fs');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createMeterlessRuntime } = require('../server/providers/meterless-runtime');
const { createZetaris } = require('../server/zetaris');

function mask(value) {
  return value ? `<set ${String(value).length} chars>` : '<empty>';
}

async function main() {
  console.log('=== Environment ===');
  console.log(`METERLESS_API_KEY      ${mask(process.env.METERLESS_API_KEY)}`);
  console.log(`METERLESS_API_URL      ${process.env.METERLESS_API_URL || '<unset>'}`);
  console.log(`METERLESS_BASE_URL     ${process.env.METERLESS_BASE_URL || '<unset>'}`);
  console.log(`ZETARIS_API_KEY        ${mask(process.env.ZETARIS_API_KEY)}`);
  console.log(`ZETARIS_ORG_ID         ${process.env.ZETARIS_ORG_ID || '<unset>'}`);
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
  console.log(
    `     ${models.models.length} routing mode(s) from ${models.source}: ${models.models
      .slice(0, 12)
      .join(', ')}`
  );
  console.log('');

  console.log('=== Zetaris ===');
  const zetaris = createZetaris();
  const zetarisConfig = zetaris.getConfig();
  console.log(`rest url               ${zetarisConfig.restUrl}`);
  console.log(`organisation id        ${zetarisConfig.orgId}`);
  console.log(`api key                ${zetarisConfig.hasKey ? 'set' : 'MISSING'}`);

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
