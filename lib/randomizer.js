// Picks a random game matching the filters.
// Store mode: Steam search narrows the catalogue server-side, then random result pages are
// checked against the filters Steam search can't express (reviews, year, price in local currency...).
// Library mode: the owned-games list is shuffled and checked against the same filters.
const steam = require('./steam');

const EARLY_ACCESS_TAG = 493;
const ADULT_DESCRIPTORS = [3, 4]; // adult-only sexual content, frequent nudity
const MAX_STORE_PAGES = 12;
const PAGES_PER_ROUND = 2;

const randInt = (n) => Math.floor(Math.random() * n);

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Up to `limit` distinct page indexes from [0, pageCount), in random order.
function randomPages(pageCount, limit) {
  if (pageCount <= limit) return shuffle([...Array(pageCount).keys()]);
  const picked = new Set();
  while (picked.size < limit) picked.add(randInt(pageCount));
  return [...picked];
}

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

function buildSearchParams(f, settings) {
  const untags = [...(f.excludeTags || [])];
  if (f.hideEarlyAccess) untags.push(EARLY_ACCESS_TAG);
  return {
    category1: 998, // games only
    cc: settings.cc,
    l: 'english',
    ndl: 1,
    ignore_preferences: 1,
    tags: (f.includeTags || []).join(','),
    untags: untags.join(','),
    os: (f.os || []).join(','),
    supportedlang: f.language || '',
    category3: (f.players || []).join(','),
    category2: (f.features || []).join(','),
    specials: f.onSale ? 1 : '',
    maxprice: f.priceMode === 'free' ? 'free' : '',
    hidef2p: f.priceMode === 'paid' ? 1 : '',
    deck_compatibility: f.deck === 'verified' ? 3 : '',
    vrsupport: f.vr === 'only' ? 402 : '',
    filter: f.topSellers ? 'topsellers' : '',
  };
}

function priceOf(item) {
  const p = item.best_purchase_option;
  if (p && p.final_price_in_cents !== undefined) {
    return {
      final: Number(p.final_price_in_cents) / 100,
      original: Number(p.original_price_in_cents || p.final_price_in_cents) / 100,
      discount: p.discount_pct || 0,
      formatted: p.formatted_final_price,
      formattedOriginal: p.formatted_original_price,
      free: Number(p.final_price_in_cents) === 0,
    };
  }
  if (item.is_free) return { final: 0, original: 0, discount: 0, formatted: null, free: true };
  return null;
}

// Returns true when the item satisfies every filter that can be checked from GetItems data.
// `library` enables the checks Steam search already performs in store mode.
function matches(item, f, { exclude, library }) {
  if (!item.visible || item.type !== 0) return false;
  if (exclude.has(item.appid)) return false;

  const release = item.release || {};
  const released = release.steam_release_date || release.original_steam_release_date;
  const now = Date.now() / 1000;
  if (f.hideUnreleased !== false && (release.is_coming_soon || !released || released > now)) return false;

  const year = released ? new Date(released * 1000).getFullYear() : null;
  const yearFrom = num(f.yearFrom);
  const yearTo = num(f.yearTo);
  if ((yearFrom !== null || yearTo !== null) && year === null) return false;
  if (yearFrom !== null && year < yearFrom) return false;
  if (yearTo !== null && year > yearTo) return false;

  const reviews = item.reviews?.summary_filtered;
  const count = reviews?.review_count || 0;
  const minReviews = num(f.minReviews);
  const maxReviews = num(f.maxReviews);
  const minPositive = num(f.minPositive);
  if (minReviews && count < minReviews) return false;
  if (maxReviews !== null && count > maxReviews) return false;
  if (minPositive && (!reviews || (reviews.percent_positive ?? 0) < minPositive)) return false;

  if (!library) {
    const price = priceOf(item);
    const priceMin = num(f.priceMin);
    const priceMax = num(f.priceMax);
    if (f.priceMode === 'free' && price && !price.free) return false;
    if (f.priceMode === 'paid' && (!price || price.free)) return false;
    if ((priceMin !== null || priceMax !== null) && !price) return false;
    if (priceMin !== null && price.final < priceMin) return false;
    if (priceMax !== null && price.final > priceMax) return false;
    const minDiscount = num(f.minDiscount);
    if (minDiscount && (!price || price.discount < minDiscount)) return false;
  }

  const platforms = item.platforms || {};
  const deck = platforms.steam_deck_compat_category || 0;
  if (f.deck === 'verified' && deck < 3) return false;
  if (f.deck === 'playable' && deck < 2) return false;
  const hasVr = platforms.vr_support && Object.keys(platforms.vr_support).length > 0;
  if (f.vr === 'exclude' && hasVr) return false;
  if (library && f.vr === 'only' && !hasVr) return false;

  const descriptors = item.content_descriptorids || [];
  if (f.hideAdult && descriptors.some((d) => ADULT_DESCRIPTORS.includes(d))) return false;

  if (library) {
    const tags = new Set([...(item.tagids || []), ...(item.tags || []).map((t) => t.tagid)]);
    if ((f.includeTags || []).some((t) => !tags.has(t))) return false;
    if ((f.excludeTags || []).some((t) => tags.has(t))) return false;
    if (f.hideEarlyAccess && tags.has(EARLY_ACCESS_TAG)) return false;

    const osMap = { win: platforms.windows, mac: platforms.mac, linux: platforms.steamos_linux };
    if ((f.os || []).some((os) => !osMap[os])) return false;

    const c = item.categories || {};
    const cats = new Set([
      ...(c.supported_player_categoryids || []),
      ...(c.feature_categoryids || []),
      ...(c.controller_categoryids || []),
    ]);
    if ([...(f.players || []), ...(f.features || [])].some((id) => !cats.has(id))) return false;
  }
  return true;
}

function playtimeMatches(game, f) {
  const hours = game.playtime / 60;
  const limit = num(f.playtimeHours) ?? 0;
  switch (f.playtime) {
    case 'never': return game.playtime === 0;
    case 'under': return hours < limit;
    case 'over': return hours >= limit;
    default: return true;
  }
}

async function rollStore(f, settings, { exclude, onProgress }) {
  const params = buildSearchParams(f, settings);
  const first = await steam.searchPage(params, 0);
  const total = first.total;
  if (!total) {
    throw new steam.SteamError('В Steam нет игр с такими тегами и параметрами. Ослабьте фильтры.', { code: 'NO_RESULTS' });
  }

  const pageCount = Math.ceil(total / steam.SEARCH_PAGE_SIZE);
  const pageOrder = randomPages(pageCount, MAX_STORE_PAGES);

  let checked = 0;
  for (let i = 0; i < pageOrder.length; i += PAGES_PER_ROUND) {
    const pages = pageOrder.slice(i, i + PAGES_PER_ROUND);
    const results = await Promise.all(
      pages.map((p) => (p === 0 ? Promise.resolve(first) : steam.searchPage(params, p * steam.SEARCH_PAGE_SIZE))),
    );
    const appids = [...new Set(results.flatMap((r) => r.appids))].filter((id) => !exclude.has(id));
    if (!appids.length) continue;
    const items = await steam.getItems(appids, settings);
    checked += items.length;
    onProgress?.({
      checked,
      total,
      previews: items.map((it) => steam.assetUrl(it, 'header')).filter(Boolean).slice(0, 12),
    });
    const passing = items.filter((it) => matches(it, f, { exclude, library: false }));
    if (passing.length) {
      return { item: passing[randInt(passing.length)], total, checked };
    }
  }
  throw new steam.SteamError(
    `Проверено ${checked} игр из ${total}, но ни одна не прошла дополнительные фильтры (отзывы, цена, год, Steam Deck). Попробуйте их ослабить.`,
    { code: 'NO_MATCH' },
  );
}

async function rollLibrary(f, settings, { owned, exclude, onProgress }) {
  const candidates = shuffle(owned.filter((g) => !exclude.has(g.appid) && playtimeMatches(g, f)));
  if (!candidates.length) {
    throw new steam.SteamError('В библиотеке нет игр с подходящим временем в игре.', { code: 'NO_RESULTS' });
  }
  const byId = new Map(owned.map((g) => [g.appid, g]));
  let checked = 0;
  for (let i = 0; i < candidates.length; i += 50) {
    const chunk = candidates.slice(i, i + 50);
    const items = await steam.getItems(chunk.map((g) => g.appid), settings);
    checked += chunk.length;
    onProgress?.({
      checked,
      total: candidates.length,
      previews: items.map((it) => steam.assetUrl(it, 'header')).filter(Boolean).slice(0, 12),
    });
    // Owned games may be hidden from the store (delisted), which shouldn't exclude them here.
    const passing = items.filter((it) => matches({ ...it, visible: true }, f, { exclude, library: true }));
    if (passing.length) {
      const item = passing[randInt(passing.length)];
      return { item, total: candidates.length, checked, owned: byId.get(item.appid) };
    }
  }
  throw new steam.SteamError(`Ни одна из ${candidates.length} игр библиотеки не подходит под фильтры.`, { code: 'NO_MATCH' });
}

async function describe(result, settings, tagNames) {
  const { item } = result;
  const details = await steam.getAppDetails(item.appid, settings);
  const reviews = item.reviews?.summary_filtered;
  const released = item.release?.steam_release_date || item.release?.original_steam_release_date;
  const platforms = item.platforms || {};
  const tags = (item.tags?.length ? item.tags.map((t) => t.tagid) : item.tagids || [])
    .map((id) => tagNames.get(id))
    .filter(Boolean)
    .slice(0, 12);

  return {
    appid: item.appid,
    name: item.name,
    header: steam.assetUrl(item, 'header') || details?.header_image || null,
    capsule: steam.assetUrl(item, 'main_capsule') || null,
    background: steam.assetUrl(item, 'page_background') || details?.background || null,
    description: details?.short_description || item.basic_info?.short_description || '',
    developers: details?.developers || (item.basic_info?.developers || []).map((d) => d.name),
    publishers: details?.publishers || (item.basic_info?.publishers || []).map((d) => d.name),
    genres: (details?.genres || []).map((g) => g.description),
    tags,
    releaseDate: details?.release_date?.date || (released ? new Date(released * 1000).toLocaleDateString('ru-RU') : null),
    reviews: reviews
      ? { percent: reviews.percent_positive, count: reviews.review_count, score: reviews.review_score, label: reviews.review_score_label }
      : null,
    price: priceOf(item),
    metacritic: details?.metacritic?.score || null,
    platforms: { win: !!platforms.windows, mac: !!platforms.mac, linux: !!platforms.steamos_linux },
    deck: platforms.steam_deck_compat_category || 0,
    vr: !!(platforms.vr_support && Object.keys(platforms.vr_support).length),
    screenshots: (details?.screenshots || []).slice(0, 8).map((s) => ({ thumb: s.path_thumbnail, full: s.path_full })),
    storeUrl: `https://store.steampowered.com/app/${item.appid}/`,
    playtime: result.owned ? result.owned.playtime : null,
    poolSize: result.total,
    checked: result.checked,
  };
}

module.exports = { buildSearchParams, matches, rollStore, rollLibrary, describe };
