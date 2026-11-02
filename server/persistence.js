'use strict';

/**
 * Where the app's state is saved, and which copy wins at start-up.
 *
 *   remote  the Zetaris store - the system of record when it is configured
 *   local   the JSON file (`state-store.js`) - a mirror that is always written,
 *           so the app keeps working, and loses nothing, while Zetaris is down
 *
 * Every change goes to the local file first and to Zetaris right after (the
 * remote write is debounced and never overlaps itself). If Zetaris refuses, the
 * snapshot stays dirty and is retried until it goes through.
 *
 * Start-up reconciliation, decided by `updatedAt`:
 *
 *   Zetaris empty, file has data  -> the file is migrated into Zetaris
 *   file newer than Zetaris       -> the file wins (Zetaris was down at the last save)
 *   otherwise                     -> Zetaris wins, the file is refreshed from it
 *   Zetaris unreachable           -> the file is used until Zetaris answers; before
 *                                    the first save then, Zetaris is read once
 *                                    more: records it holds that this server never
 *                                    loaded are adopted (`adopt`), never overwritten
 *
 * The local file is written only when something changed, so a clean restart
 * finds Zetaris at least as new as the file and loads from Zetaris.
 */

const REMOTE_DEBOUNCE_MS = 1500;
const RETRY_MS = 30_000;
const SHUTDOWN_WAIT_MS = 10_000;
// A Zetaris that hangs must not keep the app from starting.
const BOOT_TIMEOUT_MS = 20_000;

function hasData(state) {
  return Boolean(
    state &&
      (state.rssSources.length > 0 ||
        state.users.length > 0 ||
        state.news.length > 0 ||
        state.comments.length > 0)
  );
}

const COLLECTIONS = ['rssSources', 'users', 'news', 'comments'];

/**
 * The Meterless log entries Zetaris holds that this server does not. Log ids are
 * a per-machine counter, so an entry is identified by its id *and* time. A log
 * that is full has dropped its oldest entries on its own: those are not missing.
 */
function remoteOnlyLog(remoteLog, localLog) {
  const local = localLog?.entries ?? [];
  const known = new Set(local.map(entry => `${entry.id}|${entry.at}`));
  const full = local.length > 0 && local.length >= (localLog?.limit ?? Infinity);
  const oldest = full ? Math.min(...local.map(entry => entry.id)) : -Infinity;
  return (remoteLog?.entries ?? []).filter(
    entry => !known.has(`${entry.id}|${entry.at}`) && entry.id >= oldest
  );
}

/**
 * The records in `remoteState` whose id this server does not hold, per
 * collection (and in the Meterless log), and how many there are.
 */
function remoteOnly(remoteState, current) {
  const found = {};
  let count = 0;
  for (const name of COLLECTIONS) {
    const known = new Set((current[name] ?? []).map(record => record.id));
    found[name] = (remoteState[name] ?? []).filter(record => !known.has(record.id));
    count += found[name].length;
  }
  found.meterlessLog = remoteOnlyLog(remoteState.meterlessLog, current.meterlessLog);
  count += found.meterlessLog.length;
  return { found, count };
}

function unref(handle) {
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
}

function time(value) {
  const parsed = Date.parse(value || '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

function createPersistence({
  local,
  remote = null,
  snapshot,
  remoteDebounceMs = REMOTE_DEBOUNCE_MS,
  retryMs = RETRY_MS,
  bootTimeoutMs = BOOT_TIMEOUT_MS,
  // Called with the records Zetaris holds that this server never loaded (see
  // `remoteOnly`); it must add them to the live state. Without it such records
  // pause saving instead of being overwritten.
  adopt = null,
  logger = console
}) {
  if (!local) throw new Error('Persistence needs a local state store.');
  if (typeof snapshot !== 'function') throw new TypeError('Persistence needs a snapshot() function.');

  let hydrated = false;
  let remoteReady = false;
  let source = remote ? 'pending' : 'local';
  let dirty = false;
  let inFlight = null;
  let rerun = false;
  let timer = null;
  let retryTimer = null;
  let lastSavedAt = null;
  let lastCounts = null;
  let lastError = null;
  let lastLogged = null;

  function fail(error) {
    lastError = error?.message ?? String(error);
    dirty = true;
    if (lastLogged !== lastError) {
      logger.warn(`Zetaris storage: ${lastError} - the local file keeps the data and the save is retried.`);
      lastLogged = lastError;
    }
    if (!retryTimer) {
      retryTimer = unref(
        setTimeout(() => {
          retryTimer = null;
          push().catch(() => {});
        }, retryMs)
      );
    }
  }

  function recovered() {
    lastError = null;
    if (lastLogged !== null) {
      logger.log('Zetaris storage: saving works again.');
      lastLogged = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  /**
   * Zetaris answered for the first time since a failed start-up. Whatever it
   * holds that this server does not is kept: adopted into the live state, or - if
   * nothing can adopt it - saving stays paused rather than overwrite it.
   */
  function adoptRemoteRecords(remoteState) {
    if (!remoteState) return;
    const current = snapshot();
    const { found, count } = remoteOnly(remoteState, current);
    if (count === 0) return;

    // Log entries are numbered per machine, so two logs that both hold entries
    // cannot be merged: only an empty local log can take the Zetaris one over.
    const logCannotMerge =
      found.meterlessLog.length > 0 && (current.meterlessLog?.entries.length ?? 0) > 0;

    if (typeof adopt === 'function' && !logCannotMerge) {
      adopt(found, remoteState);
      logger.warn(`Zetaris storage: adopted ${count} record(s) that Zetaris held and this server had not loaded.`);
      return;
    }
    throw new Error(
      `Zetaris holds ${count} record(s) this server has not loaded, so saving is paused ` +
        'instead of overwriting them. Restart the server to load the Zetaris data.'
    );
  }

  async function run() {
    do {
      rerun = false;
      dirty = false;
      try {
        // Zetaris was unreachable at start-up: set the schema up on first contact,
        // and look at what it holds before the first save can replace it.
        if (!remoteReady) {
          await remote.ensureSchema();
          adoptRemoteRecords(await remote.read());
          remoteReady = true;
          if (source === 'local-fallback') source = 'local-resynced';
        }
        const result = await remote.write(snapshot());
        lastSavedAt = result.savedAt;
        lastCounts = result.counts;
        recovered();
      } catch (error) {
        fail(error);
        return;
      }
    } while (rerun);
  }

  function push() {
    if (!remote) return Promise.resolve();
    if (inFlight) {
      rerun = true;
      return inFlight;
    }
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function scheduleRemote(delayMs) {
    if (!remote) return;
    if (timer) {
      if (delayMs > 0) return; // a pending write already covers this change
      clearTimeout(timer);
    }
    timer = unref(
      setTimeout(() => {
        timer = null;
        push().catch(() => {});
      }, delayMs)
    );
  }

  /**
   * Load the state once, before the server starts answering. Never throws: a
   * broken Zetaris degrades to the local file.
   */
  async function hydrate() {
    try {
      return await loadState();
    } finally {
      // Until now the live state is empty: nothing may be written from it.
      hydrated = true;
    }
  }

  async function loadState() {
    const localState = local.read();
    if (!remote) return { state: localState, source };

    // The log has its own local file and is loaded before this runs.
    const localLog = snapshot().meterlessLog;
    const localHasData = hasData(localState) || Boolean(localLog && localLog.entries.length > 0);

    let bootTimer;
    const tooSlow = new Promise((resolve, reject) => {
      bootTimer = setTimeout(
        () => reject(new Error(`Zetaris did not answer within ${Math.round(bootTimeoutMs / 1000)} s`)),
        bootTimeoutMs
      );
    });

    try {
      const remoteState = await Promise.race([
        (async () => {
          await remote.ensureSchema();
          return remote.read();
        })(),
        tooSlow
      ]);
      remoteReady = true;

      if (!remoteState) {
        if (localHasData) {
          source = 'local-migrated';
          dirty = true;
          scheduleRemote(0);
          return { state: localState, source };
        }
        source = 'empty';
        return { state: localState, source };
      }

      if (time(localState.updatedAt) > time(remoteState.updatedAt)) {
        source = 'local-newer';
        dirty = true;
        scheduleRemote(0);
        return { state: localState, source };
      }

      source = 'zetaris';
      // Keep the mirror equal to the system of record, with Zetaris's timestamp.
      try {
        local.writeNow(remoteState, { keepTimestamp: true });
      } catch (error) {
        logger.warn(`Could not refresh the local state file: ${error.message}`);
      }
      lastCounts = {
        rss_sources: remoteState.rssSources.length,
        users: remoteState.users.length,
        news: remoteState.news.length,
        comments: remoteState.comments.length,
        meterless_log: remoteState.meterlessLog ? remoteState.meterlessLog.entries.length : 0
      };
      lastSavedAt = remoteState.updatedAt;
      return { state: remoteState, source };
    } catch (error) {
      source = 'local-fallback';
      fail(error);
      return { state: localState, source };
    } finally {
      clearTimeout(bootTimer);
    }
  }

  /** A change happened. `immediate` is for data that cannot be regenerated. */
  function schedule({ immediate = false } = {}) {
    if (!hydrated) return;
    local.write(snapshot());
    if (immediate) local.flush();
    if (remote) {
      dirty = true;
      scheduleRemote(immediate ? 0 : remoteDebounceMs);
    }
  }

  /**
   * Write what is pending now. Used on shutdown; waits for Zetaris, but not for
   * long. The local file is written only if a change is pending (a fresh
   * timestamp on unchanged data would make the file look newer than Zetaris at
   * the next start), and nothing is written before the state has been loaded.
   */
  async function flush({ waitMs = SHUTDOWN_WAIT_MS } = {}) {
    if (!hydrated) return;
    local.flush();
    if (!remote) return;

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty && !inFlight) return;

    let waiting;
    const limit = new Promise(resolve => {
      waiting = setTimeout(resolve, waitMs);
    });
    try {
      await Promise.race([push(), limit]);
    } finally {
      clearTimeout(waiting);
    }
  }

  function status() {
    let health = 'local';
    if (remote) {
      if (lastError) health = 'degraded';
      else if (dirty || inFlight) health = 'pending';
      else health = 'synced';
    }
    return {
      backend: remote ? 'zetaris' : 'local',
      ...(remote ? remote.describe() : {}),
      health,
      source,
      lastSavedAt,
      lastError,
      counts: lastCounts,
      localFile: local.filePath
    };
  }

  return { hydrate, schedule, flush, status };
}

module.exports = {
  BOOT_TIMEOUT_MS,
  REMOTE_DEBOUNCE_MS,
  RETRY_MS,
  createPersistence,
  hasData
};
