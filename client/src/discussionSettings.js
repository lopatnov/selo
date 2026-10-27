// Mirrors server/discussion-settings.js. The server is the source of truth and
// clamps everything again, but the browser needs the same defaults so a form
// opens with sensible values and the cards can describe what an AI will do.

export const DEFAULT_DISCUSSION_SETTINGS = Object.freeze({
  sendImmediately: true,
  delayMinSec: 5,
  delayMaxSec: 20,
  maxMessagesPerNews: 20,
  maxConsecutiveMessages: 2
});

function toNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.round(parsed);
  }
  return fallback;
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
 * Read the discussion settings of a user object (or of a form draft) and fill
 * every missing value with the default. A reversed delay range is swapped.
 */
export function readDiscussionSettings(source = {}) {
  const raw = source && typeof source === 'object' ? source : {};

  let delayMinSec = Math.max(0, toNumber(raw.delayMinSec, DEFAULT_DISCUSSION_SETTINGS.delayMinSec));
  let delayMaxSec = Math.max(0, toNumber(raw.delayMaxSec, DEFAULT_DISCUSSION_SETTINGS.delayMaxSec));
  if (delayMaxSec < delayMinSec) {
    [delayMinSec, delayMaxSec] = [delayMaxSec, delayMinSec];
  }

  return {
    sendImmediately: toBoolean(raw.sendImmediately, DEFAULT_DISCUSSION_SETTINGS.sendImmediately),
    delayMinSec,
    delayMaxSec,
    maxMessagesPerNews: Math.max(
      1,
      toNumber(raw.maxMessagesPerNews, DEFAULT_DISCUSSION_SETTINGS.maxMessagesPerNews)
    ),
    maxConsecutiveMessages: Math.max(
      1,
      toNumber(raw.maxConsecutiveMessages, DEFAULT_DISCUSSION_SETTINGS.maxConsecutiveMessages)
    )
  };
}

/** The exact payload the server expects when saving a personality. */
export function toDiscussionPayload(source) {
  return readDiscussionSettings(source);
}

/** One line for the user card, so the numbers are visible without editing. */
export function summarizeDiscussionSettings(source = {}) {
  const settings = readDiscussionSettings(source);
  const pacing = settings.sendImmediately
    ? 'sends immediately'
    : `waits ${settings.delayMinSec}–${settings.delayMaxSec} s between messages`;
  return `${pacing} · max ${settings.maxMessagesPerNews} per news · max ${settings.maxConsecutiveMessages} in a row`;
}
