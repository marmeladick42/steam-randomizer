// Encrypted store for the Steam Web API key. Uses Electron safeStorage (DPAPI on Windows, bound to the OS user).
// Always lives in userData, never next to the .exe. Call only after app.whenReady().
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const VERSION = 1;
let cached; // undefined = not loaded yet, '' = no key

function filePath() {
  return path.join(app.getPath('userData'), 'secrets.json');
}

// Linux without a keyring falls back to a hardcoded password: treat that as unavailable.
function isAvailable() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
  return true;
}

function removeFile() {
  try {
    fs.rmSync(filePath(), { force: true });
  } catch (err) {
    console.error('[secrets] cannot remove key store:', err.code || err.name);
  }
}

function load() {
  let raw;
  try {
    raw = fs.readFileSync(filePath(), 'utf8');
  } catch {
    return '';
  }
  try {
    const data = JSON.parse(raw);
    if (data.v !== VERSION || typeof data.apiKey !== 'string' || !data.apiKey) throw new Error('unexpected format');
    return safeStorage.decryptString(Buffer.from(data.apiKey, 'base64'));
  } catch {
    // Corrupted, or copied from another machine / user (DPAPI can't decrypt): start over.
    console.warn('[secrets] key store is unreadable, removing it');
    removeFile();
    return '';
  }
}

function getApiKey() {
  if (cached === undefined) cached = isAvailable() ? load() : '';
  return cached;
}

// Returns true if the key was persisted, false if it is kept in memory for this session only.
function setApiKey(key) {
  if (!isAvailable()) {
    cached = key;
    return false;
  }
  const file = filePath();
  const tmp = `${file}.tmp`;
  const data = { v: VERSION, apiKey: safeStorage.encryptString(key).toString('base64') };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  cached = key;
  return true;
}

function clearApiKey() {
  removeFile();
  cached = '';
}

module.exports = { isAvailable, getApiKey, setApiKey, clearApiKey, filePath };
