'use strict';

/**
 * Models served through Meterless are not always plain "answer" machines:
 * some wrap their chain of thought in `<think>…</think>` (or `<thinking>`,
 * `<reasoning>`, …), some return it in a separate `reasoning_content` field,
 * and some even emit the reasoning inline with a truncated opening tag.
 *
 * Nothing of that may ever reach a comment, so every reply goes through
 * `sanitizeModelText()` first. The reasoning is not thrown away: it is kept
 * separately so the ask / think / answer log can show it.
 */

const REASONING_TAGS = ['think', 'thinking', 'reasoning', 'thought', 'analysis', 'reflection'];
const TAG_ALT = REASONING_TAGS.join('|');

function toText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return String(value);
  } catch {
    return '';
  }
}

function tidy(text) {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTagFragments(text) {
  // A closing tag can arrive without its `>` when the answer is truncated.
  return text.replace(new RegExp(`<\\/?(${TAG_ALT})\\b[^>]*>?`, 'gi'), ' ');
}

/**
 * Split a model reply into reasoning (`think`) and the text to post (`answer`).
 *
 * Handles, in order:
 *  1. complete `<think>…</think>` blocks (also <thinking>, <reasoning>, …);
 *  2. a stray `</think>` with no opening tag — everything before it is reasoning;
 *  3. an unclosed opening tag — everything after it is reasoning.
 *
 * @param {unknown} raw reply text returned by the provider
 * @returns {{ think: string, answer: string }}
 */
function sanitizeModelText(raw) {
  const original = toText(raw).replace(/\r\n?/g, '\n');
  if (!original.trim()) return { think: '', answer: '' };

  const thinkParts = [];

  // 1. Complete, properly paired reasoning blocks.
  const paired = new RegExp(`<(${TAG_ALT})\\b[^>]*>([\\s\\S]*?)<\\/\\1\\s*>`, 'gi');
  let rest = original.replace(paired, (match, tag, inner) => {
    const text = tidy(stripTagFragments(toText(inner)));
    if (text) thinkParts.push(text);
    return '\n';
  });

  // 2./3. Orphan tags left behind by a stripped or truncated template.
  const openTag = new RegExp(`<(${TAG_ALT})\\b[^>]*>`, 'i').exec(rest);
  if (openTag) {
    const before = tidy(stripTagFragments(rest.slice(0, openTag.index)));
    const after = tidy(stripTagFragments(rest.slice(openTag.index + openTag[0].length)));
    if (after) thinkParts.push(after);
    rest = before;
  } else {
    const closeTag = new RegExp(`<\\/(${TAG_ALT})\\s*>`, 'gi');
    let match;
    let lastClose = null;
    while ((match = closeTag.exec(rest))) lastClose = match;
    if (lastClose) {
      const before = tidy(stripTagFragments(rest.slice(0, lastClose.index)));
      if (before) thinkParts.push(before);
      rest = rest.slice(lastClose.index + lastClose[0].length);
    }
  }

  let answer = stripTagFragments(rest);
  if (thinkParts.length > 0) {
    // A label often survives next to the stripped reasoning block.
    answer = answer.replace(/^\s*(answer|reaction|response|final answer)\s*[:\-—]\s*/i, '');
  }
  answer = tidy(answer);

  return {
    think: tidy(thinkParts.join('\n\n')),
    answer
  };
}

/** Convenience wrapper for callers that only need the postable text. */
function stripModelReasoning(raw) {
  return sanitizeModelText(raw).answer;
}

module.exports = {
  REASONING_TAGS,
  sanitizeModelText,
  stripModelReasoning
};
