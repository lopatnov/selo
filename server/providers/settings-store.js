'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Small JSON settings store for provider configuration.
 *
 * The Meterless token is persisted under the flat key
 * `meterless_runtime_token`, exactly as the provider contract requires.
 * Writes are atomic and the file is chmod 0600 where the platform allows it.
 */
class SettingsStore {
  constructor(filePath) {
    this.filePath = filePath || defaultSettingsFile();
    this.data = {};
    this.reload();
  }

  reload() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Corrupt settings should not take the server down. Start clean.
        console.warn(`Could not read provider settings (${error.code || 'parse error'}); starting with empty settings.`);
      }
      this.data = {};
    }
    return this.data;
  }

  all() {
    return { ...this.data };
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.persist();
    return value;
  }

  setMany(values) {
    Object.assign(this.data, values);
    this.persist();
    return this.data;
  }

  delete(key) {
    if (Object.prototype.hasOwnProperty.call(this.data, key)) {
      delete this.data[key];
      this.persist();
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Windows and some filesystems do not implement POSIX modes.
    }
  }
}

function defaultSettingsFile() {
  return process.env.SELO_SETTINGS_FILE || path.join(__dirname, '..', 'data', 'settings.json');
}

module.exports = {
  SettingsStore,
  defaultSettingsFile
};
