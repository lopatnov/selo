'use strict';

/**
 * Ask the Meterless Runtime for one answer by racing it (see
 * providers/meterless-race.js), and fall back to the ordinary chat call when
 * the race cannot give one. The summary of a discussion must always appear, so
 * a race is an upgrade that is allowed to fail, never a new way to fail.
 *
 * The result has the shape of `callMeterlessAI` - `{ answer, think, entry,
 * error }` - plus `race`: what the Nightshift job was and which lane won, or
 * `null` when the answer came from the fallback.
 */

const { runRace } = require('./providers/meterless-race');

const RACE_ENTRY_MODEL = (attempts, winner) =>
  winner ? `race ×${attempts} → ${winner}` : `race ×${attempts}`;

/**
 * @param {object} deps
 * @param {object} deps.runtime        the Meterless Runtime provider (submitRace, getJob, …)
 * @param {Function} deps.fallback     `callMeterlessAI`: the plain chat call
 * @param {Function} deps.buildMessages ({ user, prompt, systemPrompt }) -> { system, messages }
 * @param {Function} deps.record       (fields) -> the Meterless log entry it wrote
 * @param {object} deps.activity       the activity tracker (begin / end)
 * @param {Function} deps.sanitize     sanitizeModelText: text -> { think, answer }
 * @param {Function} [deps.race]       runRace, replaceable in tests
 * @param {object} [deps.logger]
 */
function createRaceCaller({
  runtime,
  fallback,
  buildMessages,
  record,
  activity,
  sanitize,
  race = runRace,
  logger = console
}) {
  return async function callRace({ newsId = null, user, prompt, systemPrompt, attempts, title }) {
    const { system, messages } = buildMessages({ user, prompt, systemPrompt });
    const userName = user?.name || 'unknown user';
    const startedAt = Date.now();
    const handle = activity.begin({
      userName: user?.name || '',
      userId: user?.id || null,
      model: RACE_ENTRY_MODEL(attempts),
      newsId
    });
    let succeeded = false;

    logger.log(`[Meterless] 🏁 ${userName} · ${RACE_ENTRY_MODEL(attempts)} — race submitted`);

    try {
      const won = await race(runtime, { messages, attempts, title });
      const { think, answer } = sanitize(won.text);
      if (!answer) {
        throw Object.assign(new Error('The winning attempt held reasoning only, no answer.'), {
          code: 'empty_answer'
        });
      }

      const entry = record({
        newsId,
        userName: user?.name || '',
        model: RACE_ENTRY_MODEL(won.attempts, won.lane || won.model),
        ask: `[system]\n${system}\n\n[user]\n${prompt}`,
        think,
        answer,
        durationMs: Date.now() - startedAt,
        error: null
      });
      succeeded = true;

      const lanes = won.lanes ? `, ${won.lanes} lanes` : '';
      const failed = won.failed ? `, ${won.failed} failed` : '';
      const partial = won.partial ? ', partial' : '';
      logger.log(
        `[Meterless] 🏁 ${userName} · won by ${won.lane || won.model || 'a lane'} ` +
          `(attempt ${won.seq} of ${won.attempts}${lanes}${failed}${partial}) in ${Math.round(won.elapsedMs / 1000)} s`
      );

      return {
        answer,
        think,
        entry,
        error: null,
        race: {
          jobId: won.jobId,
          lane: won.lane,
          model: won.model,
          attempts: won.attempts,
          lanes: won.lanes,
          failed: won.failed,
          partial: won.partial
        }
      };
    } catch (error) {
      logger.warn(
        `[Meterless] 🏁 ${userName} · race failed (${error?.code || 'error'}: ${error?.message || error}) ` +
          '- falling back to one chat call'
      );
    } finally {
      activity.end(handle, { ok: succeeded });
    }

    const plain = await fallback({ newsId, user, prompt, systemPrompt });
    return { ...plain, race: null };
  };
}

/**
 * The part of a race result that is kept on a comment: strings and numbers
 * only, whatever the runtime sent.
 */
function pickRace(race) {
  if (!race || typeof race !== 'object') return null;
  const text = value => (typeof value === 'string' && value ? value.slice(0, 120) : null);
  const count = value => (Number.isInteger(value) && value > 0 ? value : null);
  const jobId = text(race.jobId);
  if (!jobId) return null;
  return {
    jobId,
    lane: text(race.lane),
    model: text(race.model),
    attempts: count(race.attempts),
    lanes: count(race.lanes),
    failed: count(race.failed),
    partial: race.partial === true
  };
}

module.exports = { createRaceCaller, pickRace };
