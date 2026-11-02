'use strict';

/**
 * A Nightshift race for one prompt.
 *
 * A plain chat call to the runtime is recorded as an `app_stream` turn, and
 * every turn of an identified app is routed under the one mode the operator
 * bound to that app, so Nightshift draws a single lane ("auto") however many
 * models were asked for. A race is the other thing Nightshift does: a
 * `best_of_n` job whose attempts run on the runtime's racing lanes, one lane
 * per model, and that is what the "many stars" view shows.
 *
 *   submit  POST /v1/jobs            { kind: 'best_of_n', messages, n, window: 'now' }
 *   wait    GET  /v1/jobs/{id}       until the status is final, or the deadline
 *   read    GET  /v1/jobs/{id}/attempts/{seq}   the winner, else the first usable attempt
 *
 * If the race outlives its deadline it is cancelled and whatever landed in time
 * is used; with nothing usable the caller gets a ProviderError and falls back to
 * an ordinary chat call.
 */

const { ProviderError } = require('./meterless-runtime');

// Longer than a chat call, shorter than a night: a summary waits for this.
const RACE_TIMEOUT_MS = 150_000;
const RACE_POLL_MS = 2_000;
const FINAL_STATUSES = new Set(['completed', 'cancelled', 'errored', 'failed']);

const sleepFor = ms => new Promise(resolve => setTimeout(resolve, ms));

function usableText(attempt) {
  return typeof attempt?.text === 'string' ? attempt.text.trim() : '';
}

/** The lane of an attempt, and the model that answered on it. */
function describeAttempt(attempt) {
  const lane = typeof attempt?.lane === 'string' && attempt.lane ? attempt.lane : null;
  const model =
    typeof attempt?.model === 'string'
      ? attempt.model
      : attempt?.model?.resolved || attempt?.model?.lane || lane;
  return { lane, model: model || lane };
}

/** How many lanes took part, when the runtime says. */
function countLanes(job) {
  const stats = job?.lane_stats;
  if (Array.isArray(stats)) return stats.length || null;
  if (stats && typeof stats === 'object') return Object.keys(stats).length || null;
  return null;
}

/** Attempt numbers to try, best first: the winner, the runner-up, then in order. */
function candidateSeqs(job, attempts) {
  const known = Number.isInteger(job?.generated) && job.generated > 0 ? job.generated : attempts;
  const listed = [job?.winner_seq, job?.runner_up_seq].filter(Number.isInteger);
  const all = Array.from({ length: Math.max(known, attempts) }, (_, index) => index + 1);
  return [...new Set([...listed, ...all])];
}

/** The first attempt in `seqs` that has text; sequential, so the winner is read first. */
async function firstUsable(runtime, jobId, seqs) {
  if (seqs.length === 0) return null;
  const [seq, ...rest] = seqs;
  const attempt = await runtime.getJobAttempt(jobId, seq).catch(() => null);
  return usableText(attempt) && attempt.ok !== false
    ? { seq, attempt }
    : firstUsable(runtime, jobId, rest);
}

/** Poll until the job is in a final status; `null` when the deadline passes first. */
async function waitForJob(runtime, jobId, { deadline, pollMs, sleep, now }) {
  const job = await runtime.getJob(jobId);
  if (FINAL_STATUSES.has(String(job?.status))) return job;
  if (now() >= deadline) return { ...job, timedOut: true };
  await sleep(pollMs);
  return waitForJob(runtime, jobId, { deadline, pollMs, sleep, now });
}

/**
 * Race `messages` across the runtime's lanes and return the winning text.
 *
 * @returns {Promise<{ text: string, lane: string|null, model: string|null,
 *   jobId: string, seq: number, attempts: number, lanes: number|null,
 *   partial: boolean, elapsedMs: number }>}
 * @throws {ProviderError} race_failed, race_empty or race_timeout (and whatever
 *   the runtime itself refuses with); the caller is expected to fall back.
 */
async function runRace(
  runtime,
  {
    messages,
    attempts,
    title,
    timeoutMs = RACE_TIMEOUT_MS,
    pollMs = RACE_POLL_MS,
    sleep = sleepFor,
    now = Date.now
  } = {}
) {
  if (!runtime || typeof runtime.submitRace !== 'function') {
    throw new ProviderError('race_unsupported', 'This runtime provider cannot run a race.');
  }

  const startedAt = now();
  const { id } = await runtime.submitRace({ messages, attempts, title });
  const job = await waitForJob(runtime, id, { deadline: startedAt + timeoutMs, pollMs, sleep, now });

  const timedOut = job.timedOut === true;
  if (timedOut) {
    // Stop spending cloud tokens on a race nobody is waiting for any more.
    await runtime.cancelJob(id).catch(() => {});
  } else if (job.status !== 'completed') {
    throw new ProviderError('race_failed', `The race ended as "${job.status}", with no answer.`);
  }

  const found = await firstUsable(runtime, id, candidateSeqs(job, attempts));
  if (!found) {
    throw new ProviderError(
      timedOut ? 'race_timeout' : 'race_empty',
      timedOut
        ? `The race had no usable attempt after ${Math.round(timeoutMs / 1000)} s and was cancelled.`
        : 'The race finished but none of its attempts has an answer.'
    );
  }

  return {
    text: usableText(found.attempt),
    ...describeAttempt(found.attempt),
    jobId: id,
    seq: found.seq,
    attempts: Number.isInteger(job.generated) && job.generated > 0 ? job.generated : attempts,
    lanes: countLanes(job),
    partial: timedOut,
    elapsedMs: now() - startedAt
  };
}

module.exports = {
  FINAL_STATUSES,
  RACE_POLL_MS,
  RACE_TIMEOUT_MS,
  candidateSeqs,
  countLanes,
  describeAttempt,
  runRace
};
