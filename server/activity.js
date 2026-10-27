'use strict';

/**
 * Live "who is talking to which model right now" tracker.
 *
 * Every Meterless call is registered here twice: once when the request is
 * handed to the provider (`begin`) and once when it finishes (`end`). The
 * snapshot it produces powers the header statistics: per agent + model how
 * many requests are in flight and how many have already been processed, plus
 * the overall totals.
 *
 * The tracker is deliberately dumb: no timers of its own, every change calls
 * `onChange(snapshot)` so the caller decides how often that is broadcast.
 */

function createActivityTracker({ onChange = null, now = Date.now } = {}) {
  // requestId -> { id, userName, userId, model, newsId, startedAt, startedAtMs }
  const inFlight = new Map();
  // `${userName}\u0000${model}` -> per-agent counters
  const agents = new Map();
  let sequence = 0;
  let completed = 0;
  let failed = 0;

  function agentKey(userName, model) {
    return `${userName}\u0000${model}`;
  }

  function ensureAgent(userName, model) {
    const key = agentKey(userName, model);
    let agent = agents.get(key);
    if (!agent) {
      agent = {
        userName: userName || 'unknown user',
        model: model || 'unknown model',
        inFlight: 0,
        completed: 0,
        failed: 0,
        lastActivityAt: null
      };
      agents.set(key, agent);
    }
    return agent;
  }

  function notify() {
    if (typeof onChange !== 'function') return;
    try {
      onChange(snapshot());
    } catch {
      // A broken listener must never break a Meterless request.
    }
  }

  /**
   * Register the start of a request.
   * @returns {number} handle to pass to `end()`
   */
  function begin({ userName = '', model = '', userId = null, newsId = null } = {}) {
    sequence += 1;
    const record = {
      id: sequence,
      userName: userName || '',
      userId: userId || null,
      model: model || '',
      newsId: newsId || null,
      startedAt: new Date(now()).toISOString(),
      startedAtMs: now()
    };
    inFlight.set(record.id, record);

    const agent = ensureAgent(record.userName, record.model);
    agent.inFlight += 1;
    agent.lastActivityAt = record.startedAt;

    notify();
    return record.id;
  }

  /**
   * Register the end of a request. Returns the original record (or null when
   * the handle is unknown, which keeps a double `end()` harmless).
   */
  function end(handle, { ok = true } = {}) {
    const record = inFlight.get(handle);
    if (!record) return null;
    inFlight.delete(handle);

    const agent = ensureAgent(record.userName, record.model);
    agent.inFlight = Math.max(0, agent.inFlight - 1);
    if (ok) {
      agent.completed += 1;
      completed += 1;
    } else {
      agent.failed += 1;
      failed += 1;
    }
    agent.lastActivityAt = new Date(now()).toISOString();

    notify();
    return record;
  }

  function snapshot() {
    const at = now();
    const running = [];
    let totalInFlight = 0;

    for (const record of inFlight.values()) {
      totalInFlight += 1;
      running.push({
        id: record.id,
        userName: record.userName,
        userId: record.userId,
        model: record.model,
        newsId: record.newsId,
        startedAt: record.startedAt,
        elapsedMs: Math.max(0, at - record.startedAtMs)
      });
    }

    running.sort((left, right) => left.startedAtMs - right.startedAtMs);

    const byAgent = Array.from(agents.values())
      .map(agent => ({ ...agent }))
      .sort((left, right) => {
        if (right.inFlight !== left.inFlight) return right.inFlight - left.inFlight;
        const leftTotal = left.completed + left.failed;
        const rightTotal = right.completed + right.failed;
        if (rightTotal !== leftTotal) return rightTotal - leftTotal;
        return left.userName.localeCompare(right.userName);
      });

    return {
      updatedAt: new Date(at).toISOString(),
      inFlight: totalInFlight,
      completed,
      failed,
      requests: running,
      agents: byAgent
    };
  }

  function reset() {
    inFlight.clear();
    agents.clear();
    sequence = 0;
    completed = 0;
    failed = 0;
    notify();
  }

  return {
    begin,
    end,
    snapshot,
    reset
  };
}

module.exports = {
  createActivityTracker
};
