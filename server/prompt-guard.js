'use strict';

/**
 * Lightweight input hardening for untrusted text that flows into model prompts:
 * RSS headlines, article bodies and user comments. It mirrors the idea of
 * Scout Intent's guard without building a whole intent engine: neutralize
 * instruction-override phrasing and strip control characters, then hand the
 * text back so the prompt builder can frame it as data.
 */

const REDACTED = '[redacted: possible instruction]';

const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget|overlook|skip)\b[^.\n]{0,80}\b(instructions?|rules?|guidelines?|prompts?|constraints?|system message)\b/i,
  /\b(you are now|now you are|from now on you are)\b/i,
  /\b(jailbreak|ignore everything above|do anything now)\b/i,
  /\b(system|developer)\s*(message|prompt|instruction)?\s*[:：]/i,
  /<\s*\|?\s*(im_start|system|developer)\b/i
];

/**
 * Turn untrusted input into text that cannot pass itself off as an instruction.
 * Control characters are stripped, runs of whitespace collapse, and any
 * sentence that tries to override the model's instructions is replaced by a
 * single redaction marker (consecutive redactions collapse into one).
 *
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeUntrustedInput(value) {
  const source = String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[ \t]+/g, ' ');

  if (!source.trim()) return '';

  const sentences = source
    .split(/(?<=[.!?])\s+|\n+/)
    .map(part => part.trim())
    .filter(Boolean);

  const output = [];
  for (const sentence of sentences) {
    const redacted = INJECTION_PATTERNS.some(pattern => pattern.test(sentence));
    if (redacted) {
      if (output[output.length - 1] !== REDACTED) output.push(REDACTED);
    } else {
      output.push(sentence);
    }
  }

  return output.join(' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Frame untrusted text as data with an explicit label. Empty input (or input
 * that sanitises to nothing) returns an empty string.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function wrapAsData(value, label) {
  const text = sanitizeUntrustedInput(value);
  if (!text) return '';
  return `[${label}]\n${text}\n[/${label}]`;
}

module.exports = {
  INJECTION_PATTERNS,
  REDACTED,
  sanitizeUntrustedInput,
  wrapAsData
};
