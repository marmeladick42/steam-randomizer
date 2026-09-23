// Thin wrappers around the public Steam store endpoints and the Steam Web API.
const STORE = 'https://store.steampowered.com';
const API = 'https://api.steampowered.com';
const ASSET_BASE = 'https://shared.fastly.steamstatic.com/store_item_assets/';
const VIDEO_BASE = 'https://video.fastly.steamstatic.com/store_trailers/';
const i18n = require('../renderer/i18n');

const SEARCH_PAGE_SIZE = 100;
const ITEMS_BATCH = 50;

// `key` names an `err.*` string in renderer/i18n.js. The message is in the default language (logs, tests);
// the IPC / HTTP layer turns the key into the user's language with i18n.errorText().
class SteamError extends Error {
  constructor(key, { params, status, code } = {}) {
    super(i18n.translate(i18n.DEFAULT_LANG, `err.${key}`, params));
    this.key = key;
    this.params = params;
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { timeout = 20000, retries = 2 } = {}) {
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await request(url, timeout);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) break;
    await sleep(2000 * (attempt + 1));
  }
  return parseResponse(res);
}

async function request(url, timeout) {
  try {
    return await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': 'SteamRandomizer/1.0', Accept: 'application/json' },
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new SteamError('networkTimeout', { code: 'NETWORK' });
    throw new SteamError('network', { params: { reason: err.message }, code: 'NETWORK' });
  }
}

async function parseResponse(res) {
  if (res.status === 401 || res.status === 403) {
    throw new SteamError('badKey', { status: res.status, code: 'BAD_KEY' });
  }
  if (res.status === 429) {
    throw new SteamError('rateLimit', { status: 429, code: 'RATE_LIMIT' });
  }
  if (!res.ok) throw new SteamError('steamStatus', { params: { status: String(res.status) }, status: res.status });
  try {
    return await res.json();
  } catch {
    throw new SteamError('badResponse', { status: res.status });
  }
}

// Small in-memory TTL cache: rerolls with the same filters reuse search pages and item data,
// which keeps us under the store's rate limit.
const CACHE_TTL = 10 * 60e3;
const CACHE_MAX = 5000;
const cache = new Map();

function cached(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
  cache.delete(key);
  return undefined;
}

function remember(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { value, at: Date.now() });
  return value;
}

const qs = (params) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

// ---- Web API (needs key) ----

// Any 17-digit public SteamID works for checking that the key is accepted.
const PROBE_STEAMID = '76561197960287930';

async function validateKey(key) {
  if (!/^[0-9A-Fa-f]{32}$/.test(key)) {
    throw new SteamError('keyFormat', { code: 'BAD_FORMAT' });
  }
  await getJson(`${API}/ISteamUser/GetPlayerSummaries/v2/?${qs({ key, steamids: PROBE_STEAMID })}`);
  return true;
}

async function resolveSteamId(key, input) {
  const raw = String(input || '').trim();
  if (!raw) throw new SteamError('profileEmpty', { code: 'EMPTY' });
  let m = raw.match(/(?:^|\/profiles\/)(7656\d{13})(?:\/|$)/);
  if (m) return m[1];
  m = raw.match(/\/id\/([^/?#]+)/);
  const vanity = m ? m[1] : raw.replace(/^@/, '');
  if (!/^[\w.-]{2,64}$/.test(vanity)) throw new SteamError('profileBad', { code: 'BAD_PROFILE' });
  const data = await getJson(`${API}/ISteamUser/ResolveVanityURL/v1/?${qs({ key, vanityurl: vanity })}`);
  if (data?.response?.success !== 1) throw new SteamError('profileNotFoundNamed', { params: { name: vanity }, code: 'NOT_FOUND' });
  return data.response.steamid;
}

async function getPlayerSummary(key, steamid) {
  const data = await getJson(`${API}/ISteamUser/GetPlayerSummaries/v2/?${qs({ key, steamids: steamid })}`);
  const p = data?.response?.players?.[0];
  if (!p) throw new SteamError('profileNotFound', { code: 'NOT_FOUND' });
  return { steamid: p.steamid, name: p.personaname, avatar: p.avatarmedium, url: p.profileurl, visible: p.communityvisibilitystate === 3 };
}

async function getOwnedGames(key, steamid) {
  const data = await getJson(
    `${API}/IPlayerService/GetOwnedGames/v1/?${qs({ key, steamid, include_appinfo: 1, include_played_free_games: 1 })}`,
  );
  const games = data?.response?.games;
  if (!games) {
    throw new SteamError('libraryPrivate', { code: 'PRIVATE' });
  }
  return games.map((g) => ({ appid: g.appid, name: g.name, playtime: g.playtime_forever || 0, lastPlayed: g.rtime_last_played || 0 }));
}

// ---- Store (no key) ----

async function getTags(lang) {
  const data = await getJson(`${STORE}/tagdata/populartags/${encodeURIComponent(lang)}`);
  return data.map((t) => ({ id: t.tagid, name: t.name }));
}

async function searchPage(params, start) {
  const url = `${STORE}/search/results/?${qs({ query: '', ...params, start, count: SEARCH_PAGE_SIZE, infinite: 1 })}`;
  const hit = cached(url);
  if (hit) return hit;
  const data = await getJson(url);
  if (!data || typeof data.results_html !== 'string') throw new SteamError('searchResponse');
  const appids = [...new Set([...data.results_html.matchAll(/data-ds-appid="(\d+)"/g)].map((m) => Number(m[1])))];
  return remember(url, { total: Number(data.total_count) || 0, appids });
}

async function getItemsBatch(appids, { cc, lang }) {
  const input = {
    ids: appids.map((appid) => ({ appid })),
    context: { language: lang, country_code: cc.toUpperCase() },
    data_request: {
      include_assets: true,
      include_release: true,
      include_platforms: true,
      include_reviews: true,
      include_basic_info: true,
      include_tag_count: 20,
    },
  };
  const data = await getJson(`${API}/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`);
  return (data?.response?.store_items || []).filter((it) => it.success === 1);
}

async function getItems(appids, settings) {
  const keyOf = (appid) => `item:${settings.cc}:${settings.lang}:${appid}`;
  const out = [];
  const missing = [];
  for (const appid of appids) {
    const hit = cached(keyOf(appid));
    if (hit) out.push(hit);
    else missing.push(appid);
  }
  const batches = [];
  for (let i = 0; i < missing.length; i += ITEMS_BATCH) batches.push(missing.slice(i, i + ITEMS_BATCH));
  // A few batches at a time keeps us well under the Web API rate limits.
  for (let i = 0; i < batches.length; i += 4) {
    const results = await Promise.all(batches.slice(i, i + 4).map((b) => getItemsBatch(b, settings)));
    for (const item of results.flat()) out.push(remember(keyOf(item.appid), item));
  }
  return out;
}

async function getAppDetails(appid, { cc, lang }) {
  try {
    const data = await getJson(`${STORE}/api/appdetails?${qs({ appids: appid, cc, l: lang })}`);
    return data?.[appid]?.success ? data[appid].data : null;
  } catch {
    return null; // details are decorative; the card still renders from GetItems
  }
}

// Only the rolled game needs trailers, so they aren't part of the batched GetItems request.
// Unlike appdetails this also covers age-gated games and lists every trailer, with an all_ages flag.
async function getTrailers(appid, { cc, lang }) {
  const key = `trailers:${cc}:${lang}:${appid}`;
  const hit = cached(key);
  if (hit) return hit;
  const input = {
    ids: [{ appid }],
    context: { language: lang, country_code: cc.toUpperCase() },
    data_request: { include_trailers: true },
  };
  try {
    const data = await getJson(`${API}/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`, { retries: 0 });
    const t = data?.response?.store_items?.[0]?.trailers || {};
    return remember(key, [...(t.highlights || []), ...(t.other_trailers || [])].map(parseTrailer).filter(Boolean));
  } catch {
    return []; // trailers are decorative; the card still renders from screenshots
  }
}

function parseTrailer(t) {
  const hls = (t.adaptive_trailers || []).find((a) => a.encoding === 'hls_h264');
  if (!hls || !t.screenshot_medium || !t.trailer_url_format) return null;
  const asset = (file) => ASSET_BASE + t.trailer_url_format.replace('${FILENAME}', file);
  const query = t.trailer_url_format.split('?')[1];
  return {
    name: t.trailer_name || '',
    category: t.trailer_category || 0, // 1 gameplay, 2 teaser, 3 main or cinematic; 0 = not set
    thumb: asset(t.screenshot_medium),
    poster: t.screenshot_full ? asset(t.screenshot_full) : null, // older trailers only have the 293x165 thumb
    hls: `${VIDEO_BASE}${hls.cdn_path}${query ? `?${query}` : ''}`,
    allAges: t.all_ages !== false,
  };
}

function assetUrl(item, key) {
  const a = item.assets;
  if (!a || !a[key] || !a.asset_url_format) return null;
  return ASSET_BASE + a.asset_url_format.replace('${FILENAME}', a[key]);
}

module.exports = {
  SteamError,
  SEARCH_PAGE_SIZE,
  validateKey,
  resolveSteamId,
  getPlayerSummary,
  getOwnedGames,
  getTags,
  searchPage,
  getItems,
  getAppDetails,
  getTrailers,
  assetUrl,
};
