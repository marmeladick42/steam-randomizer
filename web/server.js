// Web version: serves renderer/ to browsers and runs Steam requests on this machine.
// The Steam API key stays here (server.env or env vars) and is never sent to visitors.
// Profile, region and language are per visitor: the browser keeps them and sends them with each request.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { parse } = require('../lib/env');
const steam = require('../lib/steam');
const randomizer = require('../lib/randomizer');
const i18n = require('../renderer/i18n');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');
const CONFIG_FILE = path.join(ROOT, 'server.env');

const MAX_BODY = 64 * 1024;
const MAX_ROLLS_AT_ONCE = 4;
const OWNED_TTL = 30 * 60e3;
const OWNED_FORCE_MIN_AGE = 60e3; // "refresh library" can't bypass the cache more often than this
const OWNED_CACHE_MAX = 300;
// Requests per IP per minute.
const LIMITS = { roll: 8, steam: 40, static: 300 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

function loadConfig() {
  let file = {};
  try {
    file = parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    /* env vars only */
  }
  const get = (name, fallback = '') => String(process.env[name] || file[name] || fallback).trim();
  return {
    key: get('STEAM_API_KEY'),
    port: Number(get('PORT', 3000)),
    host: get('HOST', '127.0.0.1'),
    cc: get('STEAM_REGION', 'us'),
    lang: get('STEAM_LANGUAGE', 'russian'),
  };
}

const config = loadConfig();

// ---------- helpers ----------

// Like SteamError: `key` names an `err.*` string in renderer/i18n.js, translated per visitor in errorBody().
class HttpError extends Error {
  constructor(status, key, code, params) {
    super(i18n.translate(i18n.DEFAULT_LANG, `err.${key}`, params));
    this.status = status;
    this.key = key;
    this.params = params;
    this.code = code;
  }
}

const badRequest = (key) => new HttpError(400, key, 'BAD_REQUEST');

// Behind cloudflared every request comes from loopback; the real visitor IP is in the proxy headers.
// Those headers are trusted only on loopback connections, where nobody else can set them.
function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const loopback = remote === '::1' || remote.startsWith('127.') || remote === '::ffff:127.0.0.1';
  if (loopback) {
    const forwarded = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0];
    if (forwarded) return forwarded.trim();
  }
  return remote;
}

const hits = new Map(); // `${bucket}:${ip}` -> { count, resetAt }

function rateLimit(bucket, ip) {
  const id = `${bucket}:${ip}`;
  const now = Date.now();
  let entry = hits.get(id);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + 60e3 };
    hits.set(id, entry);
  }
  if (++entry.count > LIMITS[bucket]) {
    const wait = Math.ceil((entry.resetAt - now) / 1000);
    throw new HttpError(429, 'tooMany', 'TOO_MANY', { wait });
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of hits) if (entry.resetAt <= now) hits.delete(id);
}, 60e3).unref();

// Steam error texts never contain the key today; this keeps it that way if that ever changes.
const scrub = (text) => (config.key ? String(text).split(config.key).join('***') : String(text));

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
  res.end(data);
}

// The interface language comes from the X-UI-Lang header that web/api.js sends with every request.
function uiLang(req) {
  const lang = String(req.headers['x-ui-lang'] || '');
  return i18n.LANGS.includes(lang) ? lang : config.lang;
}

function errorBody(err, where, lang) {
  if (err instanceof HttpError || err instanceof steam.SteamError) {
    const message = err.code === 'BAD_KEY' ? i18n.translate(lang, 'err.serverBadKey') : i18n.errorText(err, lang);
    return { ok: false, error: scrub(message), code: err.code };
  }
  console.error(`[${where}]`, scrub(err && err.stack ? err.stack : err));
  return { ok: false, error: i18n.translate(lang, 'err.internal'), code: 'SERVER' };
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw badRequest('expectJson');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'bodyTooLarge', 'BAD_REQUEST');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw badRequest('badJson');
  }
}

// ---------- input validation ----------

function visitorSettings(body) {
  const cc = body.cc || config.cc;
  const lang = body.lang || config.lang;
  if (!/^[a-z]{2}$/.test(cc) || !/^[a-z]{2,12}$/.test(lang)) throw badRequest('badRegion');
  return { key: config.key, steamId: steamIdOf(body, false), cc, lang };
}

function steamIdOf(body, required = true) {
  const id = body.steamId ? String(body.steamId) : '';
  if (id && !/^7656\d{13}$/.test(id)) throw badRequest('badSteamId');
  if (required && !id) throw new steam.SteamError('noProfile', { code: 'NO_PROFILE' });
  return id;
}

const idList = (value, max) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw badRequest('badList');
  return value.map((v) => {
    if (!Number.isSafeInteger(v) || v < 0) throw badRequest('badId');
    return v;
  });
};

const OS_IDS = ['win', 'mac', 'linux'];

// Only known filter fields reach the randomizer, with sane types.
function cleanFilters(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw badRequest('badFilterInput');
  const out = {};
  const scalar = (v) => (v === null || v === undefined ? '' : typeof v === 'number' || typeof v === 'boolean' ? v : String(v).slice(0, 32));
  for (const key of ['priceMode', 'priceMin', 'priceMax', 'minDiscount', 'minPositive', 'minReviews', 'maxReviews', 'yearFrom',
    'yearTo', 'deck', 'vr', 'language', 'playtime', 'playtimeHours']) {
    out[key] = scalar(f[key]);
  }
  for (const key of ['onSale', 'topSellers', 'hideUnreleased', 'hideEarlyAccess', 'hideAdult', 'excludeOwned', 'noRepeat']) {
    out[key] = f[key] === undefined ? undefined : !!f[key];
  }
  out.includeTags = idList(f.includeTags, 50);
  out.excludeTags = idList(f.excludeTags, 50);
  out.players = idList(f.players, 20);
  out.features = idList(f.features, 20);
  if (!Array.isArray(f.os || []) || (f.os || []).some((o) => !OS_IDS.includes(o))) throw badRequest('badPlatforms');
  out.os = [...new Set(f.os || [])];
  if (out.language && !/^[a-z_]{2,24}$/.test(out.language)) throw badRequest('badLanguage');
  return out;
}

// ---------- Steam data shared between visitors ----------

const tagCache = new Map(); // lang -> Map(id -> name)
const ownedCache = new Map(); // steamid -> { games, fetchedAt }

async function tagNames(lang) {
  if (!tagCache.has(lang)) {
    const tags = await steam.getTags(lang);
    tagCache.set(lang, new Map(tags.map((t) => [t.id, t.name])));
  }
  return tagCache.get(lang);
}

async function ownedGames(steamId, force = false) {
  const hit = ownedCache.get(steamId);
  const age = hit ? Date.now() - hit.fetchedAt : Infinity;
  if (hit && age < OWNED_TTL && !(force && age > OWNED_FORCE_MIN_AGE)) return hit.games;
  const games = await steam.getOwnedGames(config.key, steamId);
  ownedCache.delete(steamId);
  if (ownedCache.size >= OWNED_CACHE_MAX) ownedCache.delete(ownedCache.keys().next().value);
  ownedCache.set(steamId, { games, fetchedAt: Date.now() });
  return games;
}

// ---------- API ----------

const routes = {
  config: {
    bucket: 'static',
    run: () => ({ hasKey: !!config.key, cc: config.cc, lang: config.lang }),
  },
  profile: {
    bucket: 'steam',
    run: async (body) => {
      const input = String(body.input || '').slice(0, 200);
      const steamid = await steam.resolveSteamId(config.key, input);
      return steam.getPlayerSummary(config.key, steamid);
    },
  },
  player: {
    bucket: 'steam',
    run: (body) => steam.getPlayerSummary(config.key, steamIdOf(body)),
  },
  tags: {
    bucket: 'steam',
    run: async (body) => {
      const names = await tagNames(visitorSettings(body).lang);
      return [...names].map(([id, name]) => ({ id, name }));
    },
  },
  owned: {
    bucket: 'steam',
    run: async (body) => {
      const games = await ownedGames(steamIdOf(body), !!body.force);
      return { count: games.length, unplayed: games.filter((g) => g.playtime === 0).length };
    },
  },
};

let activeRolls = 0;

// Streams NDJSON: {progress} lines while searching, then one {ok, data | error} line.
async function handleRoll(req, res, body) {
  const s = visitorSettings(body);
  const mode = body.mode === 'library' ? 'library' : 'store';
  const filters = cleanFilters(body.filters);
  randomizer.assertConsistent(filters, { library: mode === 'library' });
  const history = idList(body.history, 100);
  if (mode === 'library' || filters.excludeOwned) steamIdOf(body);

  if (activeRolls >= MAX_ROLLS_AT_ONCE) {
    throw new HttpError(503, 'busy', 'BUSY');
  }
  activeRolls++;
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const write = (obj) => !res.writableEnded && res.write(`${JSON.stringify(obj)}\n`);
  try {
    const exclude = new Set(filters.noRepeat ? history : []);
    const onProgress = (p) => {
      if (controller.signal.aborted) throw new Error('client disconnected');
      write({ progress: p });
    };
    let result;
    if (mode === 'library') {
      result = await randomizer.rollLibrary(filters, s, { owned: await ownedGames(s.steamId), exclude, onProgress });
    } else {
      if (filters.excludeOwned) (await ownedGames(s.steamId)).forEach((g) => exclude.add(g.appid));
      result = await randomizer.rollStore(filters, s, { exclude, onProgress });
    }
    let names = new Map();
    try {
      names = await tagNames(s.lang);
    } catch {
      /* tags are optional on the card */
    }
    write({ ok: true, data: await randomizer.describe(result, s, names) });
  } catch (err) {
    if (!controller.signal.aborted) write(errorBody(err, 'roll', uiLang(req)));
  } finally {
    activeRolls--;
    res.end();
  }
}

async function handleApi(req, res, name, ip) {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'badMethod', 'BAD_REQUEST');
    if (name === 'roll') {
      rateLimit('roll', ip);
      return await handleRoll(req, res, await readJson(req));
    }
    const route = Object.hasOwn(routes, name) ? routes[name] : null;
    if (!route) throw new HttpError(404, 'unknownRequest', 'BAD_REQUEST');
    rateLimit(route.bucket, ip);
    const body = await readJson(req);
    sendJson(res, 200, { ok: true, data: await route.run(body) });
  } catch (err) {
    if (res.headersSent) return res.end();
    sendJson(res, err instanceof HttpError ? err.status : 200, errorBody(err, name, uiLang(req)));
  }
}

// ---------- static files ----------

// Electron's index.html plus the browser api shim, with fetch to this server allowed by the CSP.
function webIndex() {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  const csp = "connect-src 'none'";
  const scripts = '<script src="data.js"></script>';
  if (!html.includes(csp) || !html.includes(scripts)) throw new Error('renderer/index.html changed: update webIndex() in web/server.js');
  return html.replace(csp, "connect-src 'self'").replace(scripts, `<script src="web-api.js"></script>\n  ${scripts}`);
}

function staticFile(urlPath) {
  if (urlPath === '/' || urlPath === '/index.html') return { body: Buffer.from(webIndex()), type: MIME['.html'] };
  if (urlPath === '/web-api.js') return { body: fs.readFileSync(path.join(__dirname, 'api.js')), type: MIME['.js'] };
  if (urlPath === '/favicon.ico') return { body: fs.readFileSync(path.join(ROOT, 'build', 'icon.ico')), type: MIME['.ico'] };
  let rel;
  try {
    rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  } catch {
    return null;
  }
  const file = path.resolve(RENDERER, rel);
  const type = MIME[path.extname(file).toLowerCase()];
  // Only files inside renderer/ with a known type: never main.js, lib/, server.env and so on.
  if (!type || !file.startsWith(RENDERER + path.sep) || file.endsWith('.html')) return null;
  try {
    return { body: fs.readFileSync(file), type };
  } catch {
    return null;
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
};

async function onRequest(req, res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const ip = clientIp(req);
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400).end();
    return;
  }
  const api = url.pathname.match(/^\/api\/([a-z]+)$/);
  if (api) return handleApi(req, res, api[1], ip);

  try {
    rateLimit('static', ip);
  } catch (err) {
    res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' }).end(err.message);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  let file;
  try {
    file = staticFile(url.pathname);
  } catch (err) {
    console.error('[static]', err.message);
    res.writeHead(500).end();
    return;
  }
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Не найдено');
    return;
  }
  res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.body.length, 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : file.body);
}

// ---------- start ----------

async function checkKey() {
  if (!config.key) {
    throw new Error(`Не задан STEAM_API_KEY. Создайте файл ${CONFIG_FILE} со строкой STEAM_API_KEY=ваш_ключ (см. README).`);
  }
  try {
    await steam.validateKey(config.key);
  } catch (err) {
    if (err.code === 'NETWORK' || err.code === 'RATE_LIMIT') {
      console.warn(`[server] не удалось проверить ключ: ${err.message}. Продолжаю запуск.`);
      return;
    }
    throw new Error(`Ключ Steam API не подходит: ${scrub(err.message)}`);
  }
}

async function start() {
  await checkKey();
  if (!/^[a-z]{2}$/.test(config.cc) || !/^[a-z]{2,12}$/.test(config.lang)) {
    throw new Error('Некорректные STEAM_REGION или STEAM_LANGUAGE');
  }
  webIndex(); // fail now rather than on the first visitor
  const server = http.createServer((req, res) => {
    onRequest(req, res).catch((err) => {
      console.error('[request]', scrub(err && err.stack ? err.stack : err));
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.requestTimeout = 5 * 60e3;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const shownHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  console.log(`[server] Steam Randomizer: http://${shownHost}:${config.port}`);
  return { server, port: config.port };
}

module.exports = { start, config };

if (require.main === module) {
  start().catch((err) => {
    console.error(`[server] ${err.message}`);
    process.exit(1);
  });
}
