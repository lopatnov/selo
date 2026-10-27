'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { sanitizeModelText, stripMetaNarration, stripModelReasoning } = require('./meterless-text');

test('a complete <think> block never leaks into the answer', () => {
  const result = sanitizeModelText(
    '<think>step 1\nstep 2</think>A buyout offer would just be a distraction.'
  );

  assert.equal(result.answer, 'A buyout offer would just be a distraction.');
  assert.equal(result.think, 'step 1\nstep 2');
});

test('an orphan </think> (no opening tag) keeps the reasoning out of the answer', () => {
  const raw =
    'The user wants me to react as "Alice" but the personality is "The Workaholic". ' +
    'Let me craft a concise 2-3 sentence reaction that fits this personality.' +
    '</think>A buyout offer would just be a distraction from the Q3 deliverables';

  const result = sanitizeModelText(raw);

  assert.equal(result.answer, 'A buyout offer would just be a distraction from the Q3 deliverables');
  assert.match(result.think, /Let me craft a concise/);
  assert.ok(!result.answer.includes('personality'), 'reasoning must not be posted');
});

test('thinking / reasoning tags and labels are handled', () => {
  assert.equal(
    sanitizeModelText('<THINKING>hmm</THINKING>Plain answer.').answer,
    'Plain answer.'
  );

  const labelled = sanitizeModelText('<reasoning>because</reasoning>Answer: it depends');
  assert.equal(labelled.think, 'because');
  assert.equal(labelled.answer, 'it depends');
});

test('an unclosed opening tag yields reasoning only', () => {
  const result = sanitizeModelText('<think>only reasoning, the answer was cut off');

  assert.equal(result.answer, '');
  assert.equal(result.think, 'only reasoning, the answer was cut off');
});

test('truncated tag fragments are stripped, not posted', () => {
  assert.equal(sanitizeModelText('</think>A buyout offer.').answer, 'A buyout offer.');
  assert.equal(stripModelReasoning('Answer </think>A buyout offer.'), 'A buyout offer.');
});

test('plain answers and empty input pass through unchanged', () => {
  const plain = 'A buyout offer would just be a distraction.';
  assert.deepEqual(sanitizeModelText(plain), { think: '', answer: plain });
  assert.deepEqual(sanitizeModelText(''), { think: '', answer: '' });
  assert.deepEqual(sanitizeModelText(null), { think: '', answer: '' });
});

test('plain-text planning is dropped from the answer', () => {
  const raw =
    '"The user wants me to react as "Alice (meterless/auto)" with the personality of ' +
    '"The Workaholic (The Career-driven Professional)". This is an ambitious, hard-working ' +
    'professional. Let me write a';

  assert.equal(sanitizeModelText(raw).answer, '');
  assert.equal(stripMetaNarration(raw), '');
});

test('planning sentences are removed but the real reaction survives', () => {
  const raw =
    'The user wants me to react as Alice. Let me write a short reaction. ' +
    'I would kill for that sales pipeline, honestly.';

  assert.equal(stripMetaNarration(raw), 'I would kill for that sales pipeline, honestly.');
});

test('a fully quoted answer is unwrapped, quoted speech inside it is kept', () => {
  assert.equal(stripMetaNarration('"Ship it on Friday."'), 'Ship it on Friday.');
  assert.equal(
    stripMetaNarration('"The market will eat them," she said.'),
    '"The market will eat them," she said.'
  );
});
