const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { EnvFile } = require('./lib/env');
const secrets = require('./lib/secrets');
const steam = require('./lib/steam');
const randomizer = require('./lib/randomizer');
const i18n = require('./renderer/i18n');

const DEFAULTS = { cc: 'us', lang: 'russian' };

// .env holds only non-secret settings (region, language, profile); the API key lives in lib/secrets.
// Dev: .env in the project folder. Packaged: next to the .exe when writable, else in userData.
function resolveEnvPath() {
  if (!app.isPackaged) return path.join(app.getAppPath(), '.env');
  const dir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return path.join(dir, '.env');
  } catch {
    return path.join(app.getPath('userData'), '.env');
  }
}

// Every place resolveEnvPath() may have chosen in the past, for the legacy key migration.
function legacyEnvPaths() {
  if (!app.isPackaged) return [path.join(app.getAppPath(), '.env')];
  const dir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  return [path.join(dir, '.env'), path.join(app.getPath('userData'), '.env')];
}

// One-time move of STEAM_API_KEY from plain-text .env into the encrypted store.
function migrateLegacyKey() {
  for (const file of legacyEnvPaths()) {
    const legacy = new EnvFile(file);
    const key = legacy.get('STEAM_API_KEY').trim();
    if (!key) continue;
    try {
      if (!secrets.getApiKey()) secrets.setApiKey(key);
      // Without encryption keep .env as is, otherwise the key would be lost after restart.
      if (secrets.isAvailable()) legacy.update({ STEAM_API_KEY: '' });
    } catch (err) {
      console.error('[migrate] cannot move API key out of', file, err.code || err.name);
    }
  }
}

let env;
let win;
const tagCache = new Map(); // lang -> Map(id -> name)
let ownedCache = null; // { steamid, games, fetchedAt }

function settings() {
  const e = env.read();
  return {
    key: secrets.getApiKey(),
    steamId: e.STEAM_ID || '',
    cc: e.STEAM_REGION || DEFAULTS.cc,
    lang: e.STEAM_LANGUAGE || DEFAULTS.lang,
  };
}

function uiLang() {
  try {
    return settings().lang;
  } catch {
    return DEFAULTS.lang;
  }
}

async function tagNames(lang) {
  if (!tagCache.has(lang)) {
    const tags = await steam.getTags(lang);
    tagCache.set(lang, new Map(tags.map((t) => [t.id, t.name])));
  }
  return tagCache.get(lang);
}

async function ownedGames(force = false) {
  const s = settings();
  if (!s.steamId) throw new steam.SteamError('noProfile', { code: 'NO_PROFILE' });
  if (force || !ownedCache || ownedCache.steamid !== s.steamId || Date.now() - ownedCache.fetchedAt > 30 * 60e3) {
    ownedCache = { steamid: s.steamId, games: await steam.getOwnedGames(s.key, s.steamId), fetchedAt: Date.now() };
  }
  return ownedCache.games;
}

// Wraps IPC handlers so the renderer always gets { ok, data } / { ok:false, error, code },
// with `error` in the interface language.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, data: await fn(event, ...args) };
    } catch (err) {
      if (!(err instanceof steam.SteamError)) console.error(`[${channel}]`, err);
      return { ok: false, error: i18n.errorText(err, uiLang()), code: err.code };
    }
  });
}

function registerIpc() {
  handle('config:get', () => {
    const s = settings();
    return {
      hasKey: !!s.key,
      keyHint: s.key ? `••••${s.key.slice(-4)}` : '',
      steamId: s.steamId,
      cc: s.cc,
      lang: s.lang,
      keyStorePath: secrets.filePath(),
      envPath: env.filePath,
      encryptionAvailable: secrets.isAvailable(),
    };
  });

  handle('config:saveKey', async (_e, key) => {
    const clean = String(key || '').trim();
    await steam.validateKey(clean);
    secrets.setApiKey(clean);
    return true;
  });

  handle('config:removeKey', () => {
    secrets.clearApiKey();
    return true;
  });

  handle('config:saveProfile', async (_e, input) => {
    const s = settings();
    if (!String(input || '').trim()) {
      env.update({ STEAM_ID: '' });
      ownedCache = null;
      return null;
    }
    const steamid = await steam.resolveSteamId(s.key, input);
    const profile = await steam.getPlayerSummary(s.key, steamid);
    env.update({ STEAM_ID: steamid });
    ownedCache = null;
    return profile;
  });

  handle('config:saveRegion', (_e, { cc, lang }) => {
    if (!/^[a-z]{2}$/.test(cc) || !/^[a-z]{2,12}$/.test(lang)) throw new steam.SteamError('badRegion');
    env.update({ STEAM_REGION: cc, STEAM_LANGUAGE: lang });
    return true;
  });

  handle('steam:profile', async () => {
    const s = settings();
    if (!s.key || !s.steamId) return null;
    return steam.getPlayerSummary(s.key, s.steamId);
  });

  handle('steam:tags', async () => {
    const names = await tagNames(settings().lang);
    return [...names].map(([id, name]) => ({ id, name }));
  });

  handle('steam:owned', async (_e, force) => {
    const games = await ownedGames(force);
    return { count: games.length, unplayed: games.filter((g) => g.playtime === 0).length };
  });

  handle('steam:roll', async (event, { mode, filters, history }) => {
    randomizer.assertConsistent(filters, { library: mode === 'library' });
    const s = settings();
    const exclude = new Set(filters.noRepeat ? history || [] : []);
    const onProgress = (p) => event.sender.send('roll:progress', p);
    let result;
    if (mode === 'library') {
      result = await randomizer.rollLibrary(filters, s, { owned: await ownedGames(), exclude, onProgress });
    } else {
      if (filters.excludeOwned) (await ownedGames()).forEach((g) => exclude.add(g.appid));
      result = await randomizer.rollStore(filters, s, { exclude, onProgress });
    }
    let names = new Map();
    try {
      names = await tagNames(s.lang);
    } catch {
      /* tags are optional on the card */
    }
    return randomizer.describe(result, s, names, filters);
  });

  handle('shell:open', (_e, url) => {
    if (!/^(https:\/\/|steam:\/\/)/.test(url)) throw new steam.SteamError('badLink');
    return shell.openExternal(url);
  });

  // Opens the Steam client store page, falling back to the browser if Steam isn't installed.
  handle('shell:openApp', async (_e, appid) => {
    const id = Number(appid);
    try {
      await shell.openExternal(`steam://store/${id}`);
    } catch {
      await shell.openExternal(`https://store.steampowered.com/app/${id}/`);
    }
  });

  ipcMain.on('window:action', (_e, action) => {
    if (!win) return;
    if (action === 'minimize') win.minimize();
    if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
    if (action === 'close') win.close();
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    frame: false,
    backgroundColor: '#12141b',
    title: 'Steam Randomizer',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  win.on('maximize', () => win.webContents.send('window:state', true));
  win.on('unmaximize', () => win.webContents.send('window:state', false));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  env = new EnvFile(resolveEnvPath());
  migrateLegacyKey();
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
