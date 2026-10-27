'use strict';

/**
 * The app's own persistent state.
 *
 * There is no account system and no database: RSS sources, AI personalities,
 * news items, comments and the local participant live in a single JSON file
 * (`server/data/state.json`, or SELO_STATE_FILE). Writes are debounced, atomic
 * (tmp file + rename) and chmod 0600 where the platform supports it, because
 * the file is user data.
 *
 * The file is on the `server-data` volume in Docker, so it survives restarts.
 */

const fs = require('node:fs');
const path = require('node:path');

const { normalizeAppSettings } = require('./app-settings');

// Keep the file bounded: news and comments are append-only logs.
const MAX_NEWS = 1000;
const MAX_COMMENTS = 5000;
const SAVE_DEBOUNCE_MS = 400;

function defaultStateFile() {
  return process.env.SELO_STATE_FILE || path.join(__dirname, 'data', 'state.json');
}

function emptyState() {
  return {
    version: 1,
    participantId: null,
    rssSources: [],
    users: [],
    news: [],
    comments: [],
    // Deployment-wide discussion settings (how many agents see one news item).
    settings: normalizeAppSettings(),
    updatedAt: null
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalize(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return state;

  state.participantId = typeof raw.participantId === 'string' ? raw.participantId : null;
  state.rssSources = asArray(raw.rssSources).filter(
    source => source && typeof source === 'object' && typeof source.url === 'string'
  );
  state.users = asArray(raw.users).filter(user => user && typeof user === 'object' && user.id);
  // Newest first, like the in-memory list.
  state.news = asArray(raw.news).filter(item => item && typeof item === 'object' && item.id).slice(0, MAX_NEWS);
  state.comments = asArray(raw.comments)
    .filter(comment => comment && typeof comment === 'object' && comment.id)
    .slice(-MAX_COMMENTS);
  state.settings = normalizeAppSettings(raw.settings);
  state.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
  return state;
}

function createStateStore(filePath = defaultStateFile()) {
  let timer = null;
  let pending = null;

  function read() {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`Could not read state (${error.code || 'error'}); starting empty.`);
      }
      return emptyState();
    }

    try {
      return normalize(JSON.parse(raw));
    } catch {
      console.warn('State file is not valid JSON; starting empty.');
      return emptyState();
    }
  }

  function writeNow(state) {
    const payload = normalize(state);
    payload.updatedAt = new Date().toISOString();

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Windows and some filesystems do not implement POSIX modes.
    }
    return payload;
  }

  /**
   * Debounced save. Mutations are frequent (every fetched article, every
   * comment), so a burst of changes costs one write.
   */
  function write(state) {
    pending = state;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const next = pending;
      pending = null;
      if (!next) return;
      try {
        writeNow(next);
      } catch (error) {
        console.error('Could not save state:', error.message);
      }
    }, SAVE_DEBOUNCE_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const next = pending;
    pending = null;
    if (!next) return false;
    try {
      writeNow(next);
      return true;
    } catch (error) {
      console.error('Could not save state on flush:', error.message);
      return false;
    }
  }

  return {
    filePath,
    read,
    write,
    writeNow,
    flush
  };
}

module.exports = {
  MAX_COMMENTS,
  MAX_NEWS,
  SAVE_DEBOUNCE_MS,
  createStateStore,
  defaultStateFile,
  emptyState,
  normalize
};
