#!/usr/bin/env node
'use strict';

/**
 * Live check of the summary race, against the Meterless Runtime in `.env`.
 *
 *   npm run verify:race            (3 attempts)
 *   npm run verify:race -- 6       (6 attempts)
 *
 * Submits one small `best_of_n` job through the same code the app uses
 * (providers/meterless-race.js), waits for it and prints which lane won, how
 * long it took and how many lanes took part. The job stays in Nightshift, where
 * it shows as a race with one star per lane. It uses cloud lanes, so it needs
 * internet and spends a few tokens.
 */

const { loadEnv } = require('../server/load-env');
loadEnv();

const { meterlessRuntime } = require('../server/providers');
const { runRace } = require('../server/providers/meterless-race');

const attempts = Math.min(12, Math.max(2, Number.parseInt(process.argv[2], 10) || 3));

(async () => {
  const status = await meterlessRuntime.getStatus();
  console.log(`Runtime ${status.baseUrl} · ${status.status}`);
  if (status.status !== 'online') {
    console.error('The Meterless Runtime is not online; nothing to race.');
    process.exit(1);
  }

  const started = Date.now();
  console.log(`Racing ${attempts} attempts ...`);
  const won = await runRace(meterlessRuntime, {
    attempts,
    title: 'selo race check',
    messages: [
      { role: 'system', content: 'You are a concise assistant.' },
      { role: 'user', content: 'In one short sentence, say what a race between several AI models is good for.' }
    ]
  });

  console.log(`\nDone in ${Math.round((Date.now() - started) / 1000)} s`);
  console.log(`  job      ${won.jobId}`);
  console.log(`  winner   attempt ${won.seq} of ${won.attempts} on lane "${won.lane}" (model ${won.model})`);
  console.log(`  lanes    ${won.lanes ?? 'not reported'}${won.partial ? ' · partial: the race was cut short' : ''}`);
  console.log(`  answer   ${won.text.replace(/\s+/g, ' ').slice(0, 300)}`);
})().catch(error => {
  console.error(`\nRace failed: ${error.code || 'error'}: ${error.message}`);
  process.exit(1);
});
