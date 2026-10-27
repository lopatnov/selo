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
 * The values are stored flat in the JSON state file, so no migration is
 * needed: a state file written before this setting existed simply falls back
 * to the defaults.
 */

const DEFAULT_APP_SETTINGS = Object.freeze({
  agentsPerNews: 1
});

const APP_SETTINGS_LIMITS = Object.freeze({
  agentsPerNews: Object.freeze({ min: 1, max: 5 })
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

/**
 * Turn any raw object (a saved state file or a PUT body) into a complete,
 * valid set of global settings. Unknown keys are dropped and out-of-range
 * numbers are clamped instead of rejected.
 */
function normalizeAppSettings(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  return {
    agentsPerNews: clamp(
      toInteger(source.agentsPerNews, DEFAULT_APP_SETTINGS.agentsPerNews),
      APP_SETTINGS_LIMITS.agentsPerNews
    )
  };
}

module.exports = {
  APP_SETTINGS_LIMITS,
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings
};
