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
 *   Zetaris unreachable           -> the file is used; the first later save that
 *                                    succeeds replaces the Zetaris copy with it
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
  logger = console
}) {
  if (!local) throw new Error('Persistence needs a local state store.');
  if (typeof snapshot !== 'function') throw new Error('Persistence needs a snapshot() function.');

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

  async function run() {
    do {
      rerun = false;
      dirty = false;
      try {
        // Zetaris was unreachable at start-up: set the schema up on first contact.
        if (!remoteReady) {
          await remote.ensureSchema();
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
    local.write(snapshot());
    if (immediate) local.flush();
    if (remote) {
      dirty = true;
      scheduleRemote(immediate ? 0 : remoteDebounceMs);
    }
  }

  /** Write everything now. Used on shutdown; waits for Zetaris, but not for long. */
  async function flush({ waitMs = SHUTDOWN_WAIT_MS } = {}) {
    local.write(snapshot());
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
