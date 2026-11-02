'use strict';

/**
 * Guards a model reply before it becomes a comment.
 *
 * Three things go wrong with replies from the Meterless Runtime:
 *  - the token cap cuts the reply mid-sentence ("... and if");
 *  - a reasoning model spends the cap on its chain of thought and the
 *    "answer" is that reasoning ("Let me analyze ...");
 *  - the model echoes its own instructions back.
 *
 * The runtime reports `finish_reason: "stop"` even for a capped reply, so a cut
 * is told by `completion_tokens` reaching the cap (`result.truncated`) or by a
 * reply that simply does not end like a sentence. A bad reply gets one repair
 * call (a doubled cap when the cap was hit); if that is still cut, the reply is
 * shortened to its last complete sentence or clause; if it is reasoning, it is
 * not posted at all.
 */

const { sanitizeModelText } = require('./meterless-text');

const DEFAULT_REPLY_TOKENS = 2000;
const MIN_REPLY_TOKENS = 200;
const MAX_REPLY_TOKENS = 6000;
const MIN_KEPT_CHARS = 40;

/** `SELO_MAX_REPLY_TOKENS`, clamped to 200..6000; 2000 when unset or invalid. */
function resolveReplyTokenCap(env = process.env) {
  const value = Number.parseInt(env?.SELO_MAX_REPLY_TOKENS, 10);
  if (!Number.isFinite(value)) return DEFAULT_REPLY_TOKENS;
  return Math.min(MAX_REPLY_TOKENS, Math.max(MIN_REPLY_TOKENS, value));
}

// Emoji (with their variation selector and joiner) end a chat reply as well as
// a full stop does; so do closing quotes and brackets.
// (An alternation, not a character class: `[\p{Extended_Pictographic}…]$` does
// not match the emoji here.)
const EMOJI_END = /(?:\p{Extended_Pictographic}|\u{FE0F}|\u{200D})$/u;
const SENTENCE_END = /[.!?…~"'”’)\]»]$/u;

/** Does the text end the way a finished reply does? */
function endsComplete(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return false;
  if (EMOJI_END.test(value)) return true;
  // Markdown emphasis closes after the full stop: "... melted cheddar.*"
  return SENTENCE_END.test(value.replace(/[*_`]+$/u, ''));
}

/**
 * Cut the text back to its last complete sentence; when it has none worth
 * keeping, to its last clause, marked with an ellipsis. `null` when too little
 * would be left to post.
 */
function shortenToCompleteSentence(text, minKept = MIN_KEPT_CHARS) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return null;

  const sentenceEnd = /[.!?…]+["'”’)\]*_~]*(?=\s|$)/gu;
  let end = -1;
  for (const match of value.matchAll(sentenceEnd)) end = match.index + match[0].length;
  if (end >= minKept) return value.slice(0, end).trim();

  const clauseBreak = /[,;:]\s|\s[—–-]\s/gu;
  let clauseEnd = -1;
  for (const match of value.matchAll(clauseBreak)) clauseEnd = match.index;
  if (clauseEnd >= minKept) return `${value.slice(0, clauseEnd).trim()}…`;

  return null;
}

// Openers that only a chain of thought has; "Okay, ..." or "Hmm" can start an
// in-character reply, so they are not here.
const REASONING_PATTERNS = [
  /^(?:let me|let's) (?:analy[sz]e|think|break|look|parse|review|figure|consider|re-?read|check|start by)\b/i,
  /^(?:first|so),? (?:i|we) (?:need|should|must|have) to\b/i,
  /^(?:i|we) (?:need|must|should) to (?:analy[sz]e|figure|look|react|respond|write|craft|consider|think)\b/i,
  /^the (?:user|task|prompt|instructions?) (?:wants|is asking|asks|says|said|requires|states)\b/i,
  /^looking at (?:the|this) (?:discussion|news|conversation|messages?|prompt)\b/i,
  /^(?:analysis|reasoning|thinking|plan)\s*:/i,
  /\bmessage #\d+\b/i
];

const ECHO_WINDOW = 48;

function squash(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Does the reply contain a long verbatim stretch of the instructions it was given? */
function echoesInstructions(text, instructions) {
  const reply = squash(text);
  const source = squash(instructions);
  if (source.length < ECHO_WINDOW || reply.length < ECHO_WINDOW) return false;
  for (let start = 0; start + ECHO_WINDOW <= source.length; start += ECHO_WINDOW / 2) {
    if (reply.includes(source.slice(start, start + ECHO_WINDOW))) return true;
  }
  return false;
}

/** Is this "answer" really the model thinking aloud or repeating its prompt? */
function looksLikeReasoning(text, instructions = '') {
  const value = squash(text);
  if (!value) return false;
  return REASONING_PATTERNS.some(pattern => pattern.test(value)) || echoesInstructions(value, instructions);
}

function joinParts(parts) {
  return parts
    .map(part => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join('\n\n');
}

/** One call, read: what the model said, what was reasoning, and what is wrong with it. */
async function askOnce(ask, cap, instructions) {
  const result = await ask(cap);
  const { think, answer } = sanitizeModelText(result?.content);
  const base = {
    cap,
    completionTokens: Number.isFinite(result?.completionTokens) ? result.completionTokens : null,
    truncated: result?.truncated === true
  };

  if (answer && looksLikeReasoning(answer, instructions)) {
    return {
      ...base,
      answer: '',
      reasoning: joinParts([result?.reasoning, think, answer]),
      problem: 'reasoning'
    };
  }

  const reasoning = joinParts([result?.reasoning, think]);
  if (!answer) return { ...base, answer: '', reasoning, problem: 'empty' };
  return { ...base, answer, reasoning, problem: endsComplete(answer) ? null : 'cut' };
}

function report(result, { retried, trimmed }) {
  return {
    cap: result.cap,
    completionTokens: result.completionTokens,
    truncated: result.truncated,
    retried,
    trimmed
  };
}

/**
 * Ask until there is something worth posting, within one repair call.
 *
 * @param {object} options
 * @param {(cap: number) => Promise<{content: string, reasoning?: string, truncated?: boolean, completionTokens?: number}>} options.ask
 *   one model call with the given `max_tokens`
 * @param {number} options.cap first `max_tokens`
 * @param {string} [options.instructions] the system prompt, to spot an echo of it
 * @returns {Promise<{answer: string, reasoning: string, problem: string|null, reply: object}>}
 *   an empty `answer` means nothing worth posting (`problem` says why); `reply`
 *   is what to keep in the Meterless log.
 */
async function askWithRepair({ ask, cap, instructions = '' }) {
  const first = await askOnce(ask, cap, instructions);
  if (!first.problem) {
    return { ...first, reply: report(first, { retried: false, trimmed: false }) };
  }

  // A reply that hit the cap needs room; any other bad reply is a fresh draw.
  const retryCap = first.truncated ? Math.min(cap * 2, MAX_REPLY_TOKENS) : cap;
  let second = null;
  try {
    second = await askOnce(ask, retryCap, instructions);
  } catch (error) {
    // The first reply may still be salvageable below; the repair call is a bonus.
    console.warn(`[Meterless] repair call failed: ${error?.message || error}`);
  }

  const tried = second ? [second, first] : [first];
  const clean = tried.find(result => !result.problem);
  if (clean) return { ...clean, reply: report(clean, { retried: true, trimmed: false }) };

  const cut = tried.find(result => result.problem === 'cut');
  const shortened = cut ? shortenToCompleteSentence(cut.answer) : null;
  if (cut && shortened) {
    return {
      ...cut,
      answer: shortened,
      problem: null,
      reply: report(cut, { retried: Boolean(second), trimmed: true })
    };
  }

  const last = second || first;
  return {
    ...last,
    answer: '',
    reasoning: joinParts([first.reasoning, second?.reasoning]),
    reply: report(last, { retried: Boolean(second), trimmed: false })
  };
}

module.exports = {
  DEFAULT_REPLY_TOKENS,
  MAX_REPLY_TOKENS,
  MIN_REPLY_TOKENS,
  askWithRepair,
  echoesInstructions,
  endsComplete,
  looksLikeReasoning,
  resolveReplyTokenCap,
  shortenToCompleteSentence
};
