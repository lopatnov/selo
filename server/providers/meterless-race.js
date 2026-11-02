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

const { JOB_REQUEST_TIMEOUT_MS, ProviderError } = require('./meterless-runtime');

// Longer than a chat call, shorter than a night: a summary waits for this.
const RACE_TIMEOUT_MS = 150_000;
const RACE_POLL_MS = 2_000;
// After the race deadline there is still a read of what landed; it gets this
// much, and no request that waits for an answer is allowed past it.
const RACE_GRACE_MS = 15_000;
// A cancel is cleanup nobody waits for: it is sent without holding the caller up,
// and gives up on its own after this long.
const CANCEL_TIMEOUT_MS = 10_000;
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

/**
 * How many lanes answered, when the runtime says. A lane that only failed (a
 * model that is gone answers 404) is a lane that took part but is no star, so
 * lanes that report attempts are counted; without those numbers, every lane.
 */
function countLanes(job) {
  const stats = job?.lane_stats;
  if (Array.isArray(stats)) return stats.length || null;
  if (!stats || typeof stats !== 'object') return null;
  const lanes = Object.values(stats);
  const reporting = lanes.filter(lane => Number.isFinite(lane?.attempts));
  const answered = reporting.length > 0 ? reporting.filter(lane => lane.attempts > 0) : lanes;
  return answered.length || null;
}

/** Attempt numbers to try, best first: the winner, the runner-up, then in order. */
function candidateSeqs(job, attempts) {
  const known = Number.isInteger(job?.generated) && job.generated > 0 ? job.generated : attempts;
  const listed = [job?.winner_seq, job?.runner_up_seq].filter(Number.isInteger);
  const all = Array.from({ length: Math.max(known, attempts) }, (_, index) => index + 1);
  return [...new Set([...listed, ...all])];
}

/**
 * The first attempt in `seqs` that has text; sequential, so the winner is read
 * first. Stops, empty-handed, once the hard deadline has passed.
 */
async function firstUsable(runtime, jobId, seqs, { hardDeadline, now, budget }) {
  if (seqs.length === 0 || now() >= hardDeadline) return null;
  const [seq, ...rest] = seqs;
  const attempt = await runtime.getJobAttempt(jobId, seq, budget()).catch(() => null);
  return usableText(attempt) && attempt.ok !== false
    ? { seq, attempt }
    : firstUsable(runtime, jobId, rest, { hardDeadline, now, budget });
}

/**
 * Poll until the job is in a final status; flagged `timedOut` when the deadline
 * passes first. No request is sent once the hard deadline has passed, and a pause
 * between polls never runs past the deadline.
 */
async function waitForJob(runtime, jobId, { deadline, hardDeadline, pollMs, sleep, now, budget }) {
  if (now() >= hardDeadline) return { timedOut: true };
  const job = await runtime.getJob(jobId, budget());
  if (FINAL_STATUSES.has(String(job?.status))) return job;
  if (now() >= deadline) return { ...job, timedOut: true };
  await sleep(Math.max(0, Math.min(pollMs, deadline - now())));
  return waitForJob(runtime, jobId, { deadline, hardDeadline, pollMs, sleep, now, budget });
}

/**
 * Stop a race nobody is waiting for. Fire and forget: the caller is not held up by
 * it, it can neither throw nor mask the real error, and it times out by itself.
 */
function cancelInBackground(runtime, jobId) {
  try {
    Promise.resolve(runtime.cancelJob(jobId, { timeoutMs: CANCEL_TIMEOUT_MS })).catch(() => {});
  } catch {
    // A cancel that cannot even start is not worth failing the race over.
  }
}

/**
 * Race `messages` across the runtime's lanes and return the winning text.
 *
 * @returns {Promise<{ text: string, lane: string|null, model: string|null,
 *   jobId: string, seq: number, attempts: number, lanes: number|null,
 *   failed: number, partial: boolean, elapsedMs: number }>}
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
    graceMs = RACE_GRACE_MS,
    pollMs = RACE_POLL_MS,
    sleep = sleepFor,
    now = Date.now
  } = {}
) {
  if (!runtime || typeof runtime.submitRace !== 'function') {
    throw new ProviderError('race_unsupported', 'This runtime provider cannot run a race.');
  }

  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  // Nothing after the submit may outlive this, however slow the runtime is.
  const hardDeadline = deadline + graceMs;
  // Each request waits no longer than the time that is left.
  const budget = () => ({
    timeoutMs: Math.min(JOB_REQUEST_TIMEOUT_MS, Math.max(0, hardDeadline - now()))
  });

  const { id } = await runtime.submitRace({ messages, attempts, title });

  let job;
  try {
    job = await waitForJob(runtime, id, { deadline, hardDeadline, pollMs, sleep, now, budget });
  } catch (error) {
    // Nobody is waiting for this race any more: stop it spending cloud tokens.
    cancelInBackground(runtime, id);
    throw error;
  }

  const timedOut = job.timedOut === true;
  if (timedOut) {
    cancelInBackground(runtime, id);
  } else if (job.status !== 'completed') {
    throw new ProviderError('race_failed', `The race ended as "${job.status}", with no answer.`);
  }

  const found = await firstUsable(runtime, id, candidateSeqs(job, attempts), { hardDeadline, now, budget });
  if (!found) {
    const outOfTime = timedOut || now() >= hardDeadline;
    throw new ProviderError(
      outOfTime ? 'race_timeout' : 'race_empty',
      outOfTime
        ? `The race had no usable attempt within ${Math.round((timeoutMs + graceMs) / 1000)} s and was cancelled.`
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
    failed: Number.isInteger(job.failed) && job.failed > 0 ? job.failed : 0,
    partial: timedOut,
    elapsedMs: now() - startedAt
  };
}

module.exports = {
  FINAL_STATUSES,
  RACE_GRACE_MS,
  RACE_POLL_MS,
  RACE_TIMEOUT_MS,
  candidateSeqs,
  countLanes,
  describeAttempt,
  runRace
};
