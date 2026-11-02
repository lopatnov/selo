'use strict';

/**
 * Global (deployment-wide) discussion settings.
 *
 * Unlike `discussion-settings.js`, which describes ONE AI personality, this
 * module describes how the discussions themselves run:
 *
 *  - `agentsPerNews` — how many AI personalities may take part in one news
 *    item's discussion at the same time. The personalities are drawn at random
 *    every time a discussion starts, so different news items get different
 *    voices. 1..5, default 1 (one voice per article).
 *
 *  - `parallelLanes` — how many of the assigned personalities may speak at the
 *    same time. 1 keeps the classic turn-by-turn discussion; 2..5 lets several
 *    lanes post concurrently (multi-lane orchestration). 1..5, default 1.
 *
 *  - `pipeline` — the discussion stages, run in order (multi-lane pipeline):
 *       `analyze`    fan-out: every assigned personality posts its opening
 *                    reaction to the news in parallel;
 *       `discuss`    the parallel conversation itself (per-lane pacing/limits);
 *       `summarize`  fan-in: one personality writes the closing summary.
 *
 *  - `raceSummary` / `raceReplies` / `raceAttempts` — write the closing summary
 *    (and, with `raceReplies`, every reply and opening of the AI personalities)
 *    as a Nightshift race instead of one chat call: the runtime runs
 *    `raceAttempts` attempts across its racing lanes (one lane per model, so
 *    Nightshift draws one star per lane) and the winning attempt becomes the
 *    message. Both are off by default; when a race fails or takes too long the
 *    message is written the normal way. A race replaces the personality's own
 *    model with the runtime's lanes and costs `raceAttempts` times the tokens.
 *
 * The values are stored flat in the JSON state file, so no migration is
 * needed: a state file written before this setting existed simply falls back
 * to the defaults.
 */

const DEFAULT_APP_SETTINGS = Object.freeze({
  agentsPerNews: 1,
  parallelLanes: 1,
  pipeline: Object.freeze({ analyze: true, discuss: true, summarize: false }),
  raceSummary: false,
  raceReplies: false,
  raceAttempts: 5
});

const APP_SETTINGS_LIMITS = Object.freeze({
  agentsPerNews: Object.freeze({ min: 1, max: 5 }),
  parallelLanes: Object.freeze({ min: 1, max: 5 }),
  raceAttempts: Object.freeze({ min: 2, max: 12 })
});

function toInteger(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.round(parsed);
  }
  return fallback;
}

function clamp(value, { min, max }) {
  return Math.min(max, Math.max(min, value));
}

function toBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
  }
  return fallback;
}

/**
 * Normalise the discussion pipeline. Missing phases fall back to their
 * defaults, so a partial `PUT { pipeline: { summarize: true } }` never drops
 * the other two phases.
 */
function normalizePipeline(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    analyze: toBoolean(source.analyze, DEFAULT_APP_SETTINGS.pipeline.analyze),
    discuss: toBoolean(source.discuss, DEFAULT_APP_SETTINGS.pipeline.discuss),
    summarize: toBoolean(source.summarize, DEFAULT_APP_SETTINGS.pipeline.summarize)
  };
}

/**
 * Turn any raw object (a saved state file or a PUT body) into a complete,
 * valid set of global settings. Unknown keys are dropped and out-of-range
 * numbers are clamped instead of rejected.
 */
function normalizeAppSettings(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  const agentsPerNews = clamp(
    toInteger(source.agentsPerNews, DEFAULT_APP_SETTINGS.agentsPerNews),
    APP_SETTINGS_LIMITS.agentsPerNews
  );
  const parallelLanes = clamp(
    toInteger(source.parallelLanes, DEFAULT_APP_SETTINGS.parallelLanes),
    APP_SETTINGS_LIMITS.parallelLanes
  );

  return {
    // Every lane needs a personality to fill it, so asking for more lanes than
    // agents silently raises the roster. Raising `parallelLanes` in the UI must
    // actually produce more speaking lanes, not just a higher (unused) cap.
    agentsPerNews: Math.max(agentsPerNews, parallelLanes),
    parallelLanes,
    pipeline: normalizePipeline(source.pipeline),
    raceSummary: toBoolean(source.raceSummary, DEFAULT_APP_SETTINGS.raceSummary),
    raceReplies: toBoolean(source.raceReplies, DEFAULT_APP_SETTINGS.raceReplies),
    raceAttempts: clamp(
      toInteger(source.raceAttempts, DEFAULT_APP_SETTINGS.raceAttempts),
      APP_SETTINGS_LIMITS.raceAttempts
    )
  };
}

module.exports = {
  APP_SETTINGS_LIMITS,
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
  normalizePipeline
};
