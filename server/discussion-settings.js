'use strict';

/**
 * Per-AI-personality discussion settings.
 *
 * Every AI user decides how it behaves in a discussion:
 *  - `sendImmediately`   post the moment the model answers, no pacing at all;
 *  - `delayMinSec` .. `delayMaxSec`
 *                        when `sendImmediately` is off, wait a random number of
 *                        seconds inside this range before every message;
 *  - `maxMessagesPerNews`
 *                        stop writing once the personality has this many
 *                        messages on one news item;
 *  - `maxConsecutiveMessages`
 *                        how many of its own messages it may post back to back
 *                        before somebody else (AI or human) has to speak.
 *
 * The values live flat on the user object, so they are stored by the existing
 * JSON state file without a schema migration. `normalizeDiscussionSettings()`
 * is the single source of truth for defaults and for clamping, so a legacy
 * user without these fields behaves exactly like a freshly created one.
 */

const DEFAULT_DISCUSSION_SETTINGS = Object.freeze({
  sendImmediately: true,
  delayMinSec: 5,
  delayMaxSec: 20,
  maxMessagesPerNews: 20,
  maxConsecutiveMessages: 2
});

const LIMITS = Object.freeze({
  delayMinSec: Object.freeze({ min: 0, max: 3600 }),
  delayMaxSec: Object.freeze({ min: 0, max: 3600 }),
  maxMessagesPerNews: Object.freeze({ min: 1, max: 500 }),
  maxConsecutiveMessages: Object.freeze({ min: 1, max: 50 })
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
 * Turn any user object (or a form payload) into a complete, valid settings set.
 * Missing fields fall back to the defaults; out-of-range numbers are clamped and
 * a reversed delay range is swapped instead of rejected.
 */
function normalizeDiscussionSettings(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};

  const sendImmediately = toBoolean(
    source.sendImmediately,
    DEFAULT_DISCUSSION_SETTINGS.sendImmediately
  );

  let delayMinSec = clamp(
    toInteger(source.delayMinSec, DEFAULT_DISCUSSION_SETTINGS.delayMinSec),
    LIMITS.delayMinSec
  );
  let delayMaxSec = clamp(
    toInteger(source.delayMaxSec, DEFAULT_DISCUSSION_SETTINGS.delayMaxSec),
    LIMITS.delayMaxSec
  );
  if (delayMaxSec < delayMinSec) {
    [delayMinSec, delayMaxSec] = [delayMaxSec, delayMinSec];
  }

  const maxMessagesPerNews = clamp(
    toInteger(source.maxMessagesPerNews, DEFAULT_DISCUSSION_SETTINGS.maxMessagesPerNews),
    LIMITS.maxMessagesPerNews
  );
  const maxConsecutiveMessages = clamp(
    toInteger(
      source.maxConsecutiveMessages,
      DEFAULT_DISCUSSION_SETTINGS.maxConsecutiveMessages
    ),
    LIMITS.maxConsecutiveMessages
  );

  return {
    sendImmediately,
    delayMinSec,
    delayMaxSec,
    maxMessagesPerNews,
    maxConsecutiveMessages
  };
}

/**
 * Milliseconds to wait before this personality posts its next message.
 * An immediate personality never waits; otherwise the wait is drawn uniformly
 * from `[delayMinSec, delayMaxSec]`.
 *
 * @param {object} settings raw or normalized settings
 * @param {() => number} random injectable RNG, so the value is testable
 */
function nextDelayMs(settings, random = Math.random) {
  const normalized = normalizeDiscussionSettings(settings);
  if (normalized.sendImmediately) return 0;

  const { delayMinSec, delayMaxSec } = normalized;
  if (delayMaxSec <= delayMinSec) return delayMinSec * 1000;

  const spread = (delayMaxSec - delayMinSec) * random();
  return Math.round((delayMinSec + spread) * 1000);
}

/**
 * Decide whether a personality may post right now.
 *
 * @param {object} params
 * @param {number} params.messageCount     messages this personality already has on the news
 * @param {number} params.consecutiveCount own messages at the tail of the thread
 * @param {object} params.settings         raw or normalized settings
 * @returns {{ allowed: boolean, reason: string }}
 */
function canPostMessage({ messageCount = 0, consecutiveCount = 0, settings } = {}) {
  const normalized = normalizeDiscussionSettings(settings);
  if (messageCount >= normalized.maxMessagesPerNews) {
    return { allowed: false, reason: 'max_messages_per_news' };
  }
  if (consecutiveCount >= normalized.maxConsecutiveMessages) {
    return { allowed: false, reason: 'max_consecutive_messages' };
  }
  return { allowed: true, reason: '' };
}

module.exports = {
  DEFAULT_DISCUSSION_SETTINGS,
  LIMITS,
  canPostMessage,
  nextDelayMs,
  normalizeDiscussionSettings
};
