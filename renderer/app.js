// `api` is exposed by preload.js via contextBridge (desktop) or by web/api.js (browser, `api.platform === 'web'`).
const D = window.DATA;
const I = window.I18N;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const MIN_ROLL_MS = 1400;
const HISTORY_LIMIT = 24;

const state = {
  config: null,
  mode: 'store',
  filters: { ...D.DEFAULT_FILTERS },
  preset: null,
  tags: [],
  tagNames: new Map(),
  history: [],
  current: null,
  rolling: false,
  owned: null,
};

// ---------- helpers ----------
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage is a convenience only */
    }
  },
};

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function svgIcon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

let toastTimer;
function toast(message, isError = false) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3800);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- i18n ----------
// The interface language is the "Язык интерфейса и описаний" setting (config.lang), shared with Steam descriptions and tags.
const uiLang = () => state.config?.lang || I.DEFAULT_LANG;
const t = (key, params, options) => I.translate(uiLang(), key, params, options);

function applyStaticText() {
  document.documentElement.lang = I.locale(uiLang()).slice(0, 2);
  for (const node of $$('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of $$('[data-i18n-html]')) node.innerHTML = t(node.dataset.i18nHtml); // trusted strings from i18n.js
  for (const node of $$('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder);
  for (const node of $$('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);
}

// Re-renders every piece of text already on screen, so switching the language needs no reload.
function applyLanguage() {
  applyStaticText();
  renderStaticFilters();
  writeFiltersToDom();
  renderModeText();
  renderFilterHelp();
  renderHistory();
  if (state.owned) renderOwnedStats();
  if (!$('#gameCard').classList.contains('hidden')) showGame(state.current);
  // The message came from the backend in the previous language; don't leave it half-translated.
  if (!$('#errorState').classList.contains('hidden')) setStage('empty');
  if (!$('#view-settings').hidden) renderSettings();
}

function setError(node, message) {
  node.textContent = message || '';
  node.hidden = !message;
}

// ---------- views ----------
function showView(name) {
  const viewId = name === 'store' || name === 'library' ? 'main' : name;
  $$('.view').forEach((v) => (v.hidden = v.id !== `view-${viewId}`));
  $('#nav').classList.toggle('locked', name === 'setup');
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (viewId === 'main') setMode(name);
  if (name === 'settings') renderSettings();
}

function setMode(mode) {
  if (state.mode !== mode && !state.rolling) setStage('empty');
  state.mode = mode;
  document.body.dataset.mode = mode;
  store.set('sr.mode', mode);
  renderModeText();
  const needsProfile = mode === 'library' && !state.config.steamId;
  $('#libraryNotice').classList.toggle('hidden', !needsProfile);
  $('#rollBtn').disabled = needsProfile || state.rolling;
  if (mode === 'library' && !needsProfile) loadOwnedStats();
  updateSummary();
}

function renderModeText() {
  $('#modeEyebrow').textContent = t(state.mode === 'library' ? 'mode.library' : 'mode.store');
}

// ---------- setup (API key) ----------
function initSetup() {
  $('#toggleKey').addEventListener('click', () => {
    const input = $('#setupKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  $('#setupKey').addEventListener('keydown', (e) => e.key === 'Enter' && $('#setupSave').click());
  $('#setupCancel').addEventListener('click', () => showView(state.mode));

  $('#setupSave').addEventListener('click', async () => {
    const btn = $('#setupSave');
    const errorBox = $('#setupError');
    const key = $('#setupKey').value.trim();
    const profile = $('#setupProfile').value.trim();
    setError(errorBox, '');
    if (!key) return setError(errorBox, t('setup.noKey'));

    btn.disabled = true;
    btn.textContent = t('setup.checking');
    try {
      const res = await api.saveKey(key);
      if (!res.ok) {
        const message = res.code === 'BAD_KEY' ? t('setup.badKey') : res.error;
        return setError(errorBox, message);
      }
      if (profile) {
        btn.textContent = t('setup.findingProfile');
        const pr = await api.saveProfile(profile);
        if (!pr.ok) {
          await reloadConfig();
          $('#setupKey').value = '';
          return setError(errorBox, t('setup.profileFailed', { error: pr.error }));
        }
      }
      $('#setupKey').value = '';
      await reloadConfig();
      toast(t('setup.saved'));
      await afterKeyReady();
    } finally {
      btn.disabled = false;
      btn.textContent = t('setup.save');
    }
  });
}

function openSetup({ cancellable = false } = {}) {
  $('#setupKeyStorePath').textContent = state.config.keyStorePath;
  renderKeyStorageWarning();
  $('#setupCancel').classList.toggle('hidden', !cancellable);
  $('#setupProfile').closest('.field').classList.toggle('hidden', !!state.config.steamId);
  setError($('#setupError'), '');
  showView('setup');
  $('#setupKey').focus();
}

// Without OS encryption the key is kept in memory only; say so wherever the key is managed.
function renderKeyStorageWarning() {
  const volatile = state.config.encryptionAvailable === false;
  $$('[data-volatile-key]').forEach((node) => node.classList.toggle('hidden', !volatile));
}

async function reloadConfig() {
  const res = await api.getConfig();
  if (res.ok) state.config = res.data;
  const region = D.REGIONS.find((r) => r.id === state.config.cc);
  $('#currencyLabel').textContent = region ? region.currency : '';
  renderFilterHelp();
}

function renderFilterHelp() {
  const help = D.FILTER_HELP[uiLang()] || D.FILTER_HELP[I.DEFAULT_LANG];
  $('#filterHelpBtn').setAttribute('aria-label', help.label);
  $('#filterHelpPop').replaceChildren(
    el('h3', { text: help.title }),
    el('p', { text: help.lead }),
    el('h4', { text: help.adviceTitle }),
    el('ul', {}, help.advice.map((line) => el('li', { text: line }))),
    el('details', {}, [
      el('summary', { text: help.detailsSummary }),
      ...help.details.map((d) => el('p', d.webOnly ? { text: d.text, 'data-web-only': '' } : { text: d.text })),
    ]),
  );
}

function bindFilterHelp() {
  const box = $('#filterHelp');
  const btn = $('#filterHelpBtn');
  // Hover and focus open it via CSS; a click pins it open for touch screens and keyboard users.
  // Closing also drops focus, otherwise :focus-within would keep it visible.
  const setOpen = (open) => {
    box.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
    if (!open && box.contains(document.activeElement)) document.activeElement.blur();
  };
  btn.addEventListener('click', () => setOpen(!box.classList.contains('open')));
  document.addEventListener('click', (e) => {
    if (!box.contains(e.target)) setOpen(false);
  });
  box.addEventListener('keydown', (e) => e.key === 'Escape' && setOpen(false));
}

// ---------- filters ----------
// Rebuilt on every language change; writeFiltersToDom() then restores the checked state and select values.
function renderStaticFilters() {
  const year = String(new Date().getFullYear());
  $('#presets').replaceChildren(
    ...D.PRESETS.map((p) =>
      el('button', { class: 'preset', title: t(`preset.${p.id}.hint`, { year }), 'data-preset': p.id, text: t(`preset.${p.id}`), onclick: () => applyPreset(p) }),
    ),
  );
  const checkList = (container, ids, group, prefix) =>
    container.replaceChildren(
      ...ids.map((id) =>
        el('label', { class: 'check' }, [
          el('input', { type: 'checkbox', 'data-f-group': group, value: String(id) }),
          el('span', { text: t(`${prefix}.${id}`) }),
        ]),
      ),
    );
  checkList($('#playersList'), D.PLAYERS, 'players', 'player');
  checkList($('#featuresList'), D.FEATURES, 'features', 'feature');
  $('#languageSelect').replaceChildren(...D.LANGUAGES.map((id) => el('option', { value: id, text: t(`lang.${id || 'any'}`) })));
  $('#regionSelect').replaceChildren(
    ...D.REGIONS.map((r) => el('option', { value: r.id, text: `${t(`region.${r.id}`)} (${r.usdOnly ? t('region.usdOnly') : r.currency})` })),
  );
  if (state.config) $('#regionSelect').value = state.config.cc;
}

function applyPreset(preset) {
  const keep = { noRepeat: state.filters.noRepeat, hideAdult: state.filters.hideAdult, excludeOwned: state.filters.excludeOwned };
  if (state.preset === preset.id) {
    state.filters = { ...D.DEFAULT_FILTERS, ...keep };
    state.preset = null;
  } else {
    state.filters = normalizeFilters({ ...D.DEFAULT_FILTERS, ...keep, ...preset.filters });
    state.preset = preset.id;
  }
  writeFiltersToDom();
  saveFilters();
}

const isNumericGroup = (group) => group !== 'os';

function readFiltersFromDom() {
  const f = { ...state.filters };
  for (const input of $$('[data-f]')) {
    const key = input.dataset.f;
    if (input.type === 'checkbox') f[key] = input.checked;
    else if (input.type === 'range' || key === 'minDiscount') f[key] = Number(input.value);
    else f[key] = input.value;
  }
  for (const group of new Set($$('[data-f-group]').map((i) => i.dataset.fGroup))) {
    f[group] = $$(`[data-f-group="${group}"]:checked`).map((i) => (isNumericGroup(group) ? Number(i.value) : i.value));
  }
  return f;
}

function writeFiltersToDom() {
  const f = state.filters;
  for (const input of $$('[data-f]')) {
    const value = f[input.dataset.f];
    if (input.type === 'checkbox') input.checked = !!value;
    else input.value = value ?? '';
  }
  for (const input of $$('[data-f-group]')) {
    const list = (f[input.dataset.fGroup] || []).map(String);
    input.checked = list.includes(input.value);
  }
  for (const seg of $$('[data-seg]')) {
    for (const b of seg.querySelectorAll('button')) b.classList.toggle('active', b.dataset.value === f[seg.dataset.seg]);
  }
  $$('.preset').forEach((b) => b.classList.toggle('active', b.dataset.preset === state.preset));
  updateDerivedUi();
  renderTags();
}

const RANGE_PAIRS = [
  ['priceMin', 'priceMax'],
  ['minReviews', 'maxReviews'],
  ['yearFrom', 'yearTo'],
];

// Resolves filter combinations that can never match anything, so a roll doesn't burn Steam requests on them.
// `changedKey` is the field the user just committed: in an inverted range the other bound follows it.
function normalizeFilters(f, changedKey) {
  const n = { ...f };
  for (const key of ['priceMin', 'priceMax', 'minReviews', 'maxReviews']) {
    if (n[key] !== '' && Number(n[key]) < 0) n[key] = '0';
  }
  if (n.priceMode === 'free') {
    Object.assign(n, { priceMin: '', priceMax: '', onSale: false, minDiscount: 0 });
  }
  if (n.priceMode === 'paid' && n.priceMax !== '' && Number(n.priceMax) <= 0) n.priceMax = '';
  for (const [lo, hi] of RANGE_PAIRS) {
    if (n[lo] === '' || n[hi] === '' || Number(n[lo]) <= Number(n[hi])) continue;
    if (changedKey === hi) n[lo] = n[hi];
    else n[hi] = n[lo];
  }
  return n;
}

function updateDerivedUi() {
  $$('.paid-only').forEach((node) => node.classList.toggle('hidden', state.filters.priceMode === 'free'));
  const range = $('[data-f="minPositive"]');
  $('#minPositiveValue').textContent = `${range.value}%`;
  range.style.setProperty('--fill', `${(range.value / range.max) * 100}%`);
  $('#playtimeHoursField').classList.toggle('hidden', !['under', 'over'].includes(state.filters.playtime));
  updateSummary();
}

function saveFilters() {
  store.set('sr.filters', { filters: state.filters, preset: state.preset });
}

// Input events keep state live while typing; normalization runs on commit (change / segment click)
// so a half-typed number isn't rewritten under the cursor.
function commitFilters(changedKey) {
  const normalized = normalizeFilters(state.filters, changedKey);
  if (JSON.stringify(normalized) === JSON.stringify(state.filters)) return;
  state.filters = normalized;
  writeFiltersToDom();
  saveFilters();
}

function onFiltersChanged() {
  state.filters = readFiltersFromDom();
  state.preset = null;
  $$('.preset').forEach((b) => b.classList.remove('active'));
  updateDerivedUi();
  saveFilters();
}

function bindFilterBlocks() {
  for (const title of $$('#filters .block-title')) {
    const block = title.parentElement;
    const setCollapsed = (collapsed) => {
      block.classList.toggle('collapsed', collapsed);
      title.setAttribute('aria-expanded', String(!collapsed));
    };
    title.setAttribute('role', 'button');
    title.tabIndex = 0;
    setCollapsed(true);
    title.addEventListener('click', () => setCollapsed(!block.classList.contains('collapsed')));
    title.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      title.click();
    });
  }
}

function bindFilters() {
  bindFilterBlocks();
  $('#filters').addEventListener('input', (e) => {
    if (e.target.matches('[data-f], [data-f-group]')) onFiltersChanged();
  });
  $('#filters').addEventListener('change', (e) => {
    if (e.target.matches('[data-f]')) commitFilters(e.target.dataset.f);
  });
  for (const seg of $$('[data-seg]')) {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      state.filters[seg.dataset.seg] = b.dataset.value;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      onFiltersChanged();
      commitFilters(seg.dataset.seg);
    });
  }
  $('#resetFilters').addEventListener('click', () => {
    state.filters = { ...D.DEFAULT_FILTERS };
    state.preset = null;
    writeFiltersToDom();
    saveFilters();
  });
  $('#tagSearch').addEventListener('input', renderTagList);
}

function updateSummary() {
  const f = state.filters;
  const parts = [];
  const names = (ids) => ids.map((id) => state.tagNames.get(id) || `#${id}`);
  if (f.includeTags.length) parts.push(t('summary.tags', { list: names(f.includeTags).join(', ') }));
  if (f.excludeTags.length) parts.push(t('summary.without', { list: names(f.excludeTags).join(', ') }));
  if (state.mode === 'store') {
    if (f.priceMode === 'free') parts.push(t('summary.free'));
    if (f.priceMode === 'paid') parts.push(t('summary.paid'));
    if (f.priceMin || f.priceMax) {
      parts.push(t('summary.price', { min: String(f.priceMin || 0), max: String(f.priceMax || '∞'), currency: $('#currencyLabel').textContent }));
    }
    if (f.onSale || f.minDiscount) parts.push(f.minDiscount ? t('summary.discountFrom', { n: f.minDiscount }) : t('summary.onSale'));
    if (f.language) parts.push(t('summary.language', { name: t(`lang.${f.language}`) }));
    if (f.topSellers) parts.push(t('summary.topSellers'));
  } else {
    const h = String(f.playtimeHours);
    const pt = { never: t('summary.neverPlayed'), under: t('summary.under', { h }), over: t('summary.over', { h }) }[f.playtime];
    if (pt) parts.push(pt);
  }
  if (f.minPositive) parts.push(t('summary.positive', { n: f.minPositive }));
  if (f.minReviews || f.maxReviews) parts.push(t('summary.reviews', { min: String(f.minReviews || 0), max: String(f.maxReviews || '∞') }));
  if (f.yearFrom || f.yearTo) parts.push(t('summary.years', { from: String(f.yearFrom || '…'), to: String(f.yearTo || '…') }));
  const cats = [
    ...D.PLAYERS.filter((id) => f.players.includes(id)).map((id) => t(`player.${id}`)),
    ...D.FEATURES.filter((id) => f.features.includes(id)).map((id) => t(`feature.${id}`)),
  ];
  if (cats.length) parts.push(cats.map((name) => name.toLowerCase()).join(', '));
  if (f.os.length) parts.push(f.os.map((o) => ({ win: 'Windows', mac: 'macOS', linux: 'SteamOS' })[o]).join('/'));
  if (f.deck !== 'any') parts.push(t(f.deck === 'verified' ? 'summary.deckVerified' : 'summary.deckPlayable'));
  if (f.vr !== 'any') parts.push(t(f.vr === 'only' ? 'summary.vrOnly' : 'summary.noVr'));
  if (f.hideEarlyAccess) parts.push(t('summary.noEarlyAccess'));
  $('#filterSummary').textContent = parts.length ? parts.join(' · ') : t('summary.none');
}

// ---------- tags ----------
async function loadTags() {
  const res = await api.getTags();
  if (!res.ok) {
    $('#tagList').replaceChildren(el('div', { class: 'muted small', text: t('tags.loadFailed', { error: res.error }) }));
    return;
  }
  state.tags = res.data;
  state.tagNames = new Map(res.data.map((tag) => [tag.id, tag.name]));
  renderTags();
  updateSummary();
}

function tagStateOf(id) {
  if (state.filters.includeTags.includes(id)) return 'inc';
  if (state.filters.excludeTags.includes(id)) return 'exc';
  return '';
}

function cycleTag(id) {
  const f = state.filters;
  const current = tagStateOf(id);
  f.includeTags = f.includeTags.filter((t) => t !== id);
  f.excludeTags = f.excludeTags.filter((t) => t !== id);
  if (current === '') f.includeTags.push(id);
  else if (current === 'inc') f.excludeTags.push(id);
  state.preset = null;
  $$('.preset').forEach((b) => b.classList.remove('active'));
  renderTags();
  updateSummary();
  saveFilters();
}

function removeTag(id) {
  state.filters.includeTags = state.filters.includeTags.filter((t) => t !== id);
  state.filters.excludeTags = state.filters.excludeTags.filter((t) => t !== id);
  renderTags();
  updateSummary();
  saveFilters();
}

function renderTags() {
  const f = state.filters;
  const chips = [
    ...f.includeTags.map((id) => ['inc', id]),
    ...f.excludeTags.map((id) => ['exc', id]),
  ].map(([cls, id]) =>
    el('span', { class: `tag-chip ${cls}`, title: t('tags.remove'), text: state.tagNames.get(id) || `#${id}`, onclick: () => removeTag(id) }),
  );
  $('#tagSelected').replaceChildren(...chips);
  const count = f.includeTags.length + f.excludeTags.length;
  $('#tagCounter').textContent = count ? `(${count})` : '';
  renderTagList();
}

function renderTagList() {
  if (!state.tags.length) return;
  const q = $('#tagSearch').value.trim().toLowerCase();
  const list = q ? state.tags.filter((tag) => tag.name.toLowerCase().includes(q)) : state.tags;
  const rows = list.slice(0, 200).map((tag) => {
    const st = tagStateOf(tag.id);
    return el('div', { class: `tag-row ${st}`, onclick: () => cycleTag(tag.id) }, [
      el('span', { class: 'state' }),
      el('span', { class: 'name', text: tag.name }),
    ]);
  });
  if (!rows.length) rows.push(el('div', { class: 'muted small', text: t('tags.notFound') }));
  $('#tagList').replaceChildren(...rows);
}

// ---------- rolling ----------
function setStage(which) {
  for (const [id, name] of [['#emptyState', 'empty'], ['#rollingState', 'rolling'], ['#errorState', 'error'], ['#gameCard', 'game']]) {
    $(id).classList.toggle('hidden', which !== name);
  }
  if (which !== 'game') $('#stageBg').classList.remove('visible');
}

async function roll() {
  if (state.rolling) return;
  state.rolling = true;
  const btn = $('#rollBtn');
  btn.disabled = true;
  btn.classList.add('spinning');
  setStage('rolling');
  $('#stage').scrollTo({ top: 0, behavior: 'smooth' });

  const pool = state.history.map((h) => h.header).filter(Boolean);
  const reel = $('#reelImg');
  reel.src = pool[0] || '';
  let tick = 0;
  const spin = setInterval(() => {
    if (pool.length) reel.src = pool[tick++ % pool.length];
  }, 90);
  $('#rollingText').textContent = t(state.mode === 'library' ? 'rolling.library' : 'rolling.store');
  const unsubscribe = api.onRollProgress((p) => {
    pool.push(...p.previews);
    $('#rollingText').textContent = t('rolling.progress', { checked: p.checked, total: p.total });
  });

  const started = Date.now();
  const res = await api.roll({
    mode: state.mode,
    filters: state.filters,
    history: state.history.map((h) => h.appid),
  });
  await wait(Math.max(0, MIN_ROLL_MS - (Date.now() - started)));

  clearInterval(spin);
  unsubscribe();
  state.rolling = false;
  btn.classList.remove('spinning');
  btn.disabled = state.mode === 'library' && !state.config.steamId;

  if (!res.ok) {
    if (res.code === 'BAD_KEY' && !state.config.web) {
      toast(t('error.keyExpired'), true);
      await reloadConfig();
      return openSetup();
    }
    $('#errorTitle').textContent = t(I.has(`errorTitle.${res.code}`) ? `errorTitle.${res.code}` : 'errorTitle.default');
    $('#errorText').textContent = res.error;
    setStage('error');
    return;
  }
  showGame(res.data);
  addToHistory(res.data);
}

function showGame(g) {
  state.current = g;
  setStage('game');
  $('#gName').textContent = g.name;
  if (!g.poolSize) $('#gPool').textContent = '';
  else $('#gPool').textContent = t(g.playtime !== null ? 'game.poolLibrary' : 'game.poolStore', { n: g.poolSize });
  setImage($('#gHeader'), g.header);
  $('#gDesc').textContent = g.description || t('game.noDescription');

  const rv = $('#gReviews');
  if (g.reviews && g.reviews.count) {
    rv.textContent = t('game.reviewSummary', { label: g.reviews.label, percent: g.reviews.percent, count: g.reviews.count });
    rv.className = g.reviews.percent >= 70 ? 'rv-positive' : g.reviews.percent >= 40 ? 'rv-mixed' : 'rv-negative';
  } else {
    rv.textContent = t('game.noReviews');
    rv.className = '';
  }
  $('#gDate').textContent = g.releaseDate || '—';
  $('#gDev').textContent = g.developers.join(', ') || '—';
  $('#gPub').textContent = g.publishers.join(', ') || '—';
  $('#gTags').replaceChildren(...(g.tags.length ? g.tags : g.genres).map((t) => el('span', { text: t })));

  // media
  gallery.shots = g.screenshots.length ? g.screenshots : g.header ? [{ thumb: g.header, full: g.header }] : [];
  gallery.index = 0;
  resetImageCache();
  gallery.shots.forEach((s) => preload(s.thumb));
  $('#gShots').replaceChildren(
    ...gallery.shots.map((s, i) => el('img', { class: 'skeleton', src: s.thumb, alt: '', onload: (e) => e.target.classList.remove('skeleton'), onclick: () => showShot(i) })),
  );
  showShot(0);
  // warm up the remaining full-size shots so switching between them is instant
  gallery.shots.forEach((s) => preload(s.full));

  const bg = $('#stageBg');
  const bgUrl = g.background || g.screenshots[0]?.full || '';
  bg.dataset.want = bgUrl;
  bg.classList.remove('visible');
  if (bgUrl) {
    preload(bgUrl).then(() => {
      if (bg.dataset.want !== bgUrl || $('#gameCard').classList.contains('hidden')) return;
      bg.style.backgroundImage = `url("${bgUrl}")`;
      bg.classList.add('visible');
    });
  }

  // badges
  const badges = [];
  const osNames = { win: ['i-win', 'Windows'], mac: ['i-mac', 'macOS'], linux: ['i-linux', 'SteamOS'] };
  for (const [key, [icon, title]] of Object.entries(osNames)) {
    if (g.platforms[key]) badges.push(el('span', { class: 'badge', title }, [svgIcon(icon)]));
  }
  if (g.deck > 0) badges.push(el('span', { class: `badge ${g.deck === 3 ? 'hot' : ''}`, text: t('game.deckBadge', { label: t(`deckLabel.${g.deck}`) }) }));
  if (g.vr) badges.push(el('span', { class: 'badge hot', text: 'VR' }));
  if (g.metacritic) {
    const cls = g.metacritic >= 75 ? '' : g.metacritic >= 50 ? 'mid' : 'low';
    badges.push(el('span', { class: `badge meta ${cls}`, title: 'Metacritic', text: `MC ${g.metacritic}` }));
  }
  if (g.playtime !== null) {
    const hours = g.playtime / 60;
    badges.push(el('span', { class: 'badge hot', text: g.playtime ? t('game.played', { h: hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours) }) : t('game.notLaunched') }));
  }
  $('#gBadges').replaceChildren(...badges);

  // price
  const price = $('#gPrice');
  const p = g.price;
  if (g.playtime !== null) {
    price.replaceChildren(el('span', { class: 'final', text: t('game.inLibrary') }));
  } else if (!p) {
    price.replaceChildren(el('span', { class: 'orig', text: t('game.noPrice') }));
  } else if (p.free) {
    price.replaceChildren(el('span', { class: 'final', text: t('game.free') }));
  } else if (p.discount) {
    price.replaceChildren(
      el('span', { class: 'discount', text: `-${p.discount}%` }),
      el('span', {}, [el('span', { class: 'orig', text: p.formattedOriginal || '' }), el('span', { class: 'final', text: p.formatted })]),
    );
  } else {
    price.replaceChildren(el('span', { class: 'final', text: p.formatted }));
  }
}

// ---------- image loading ----------
// Chromium keeps painting an <img>'s previous picture until the new src arrives,
// so images are swapped only once decoded, and stale ones are dropped right away.
const imageCache = new Map();
const loadedImages = new Set();

function preload(url) {
  if (!imageCache.has(url)) {
    const img = new Image();
    img.src = url;
    imageCache.set(url, img.decode().then(() => loadedImages.add(url), () => {}));
  }
  return imageCache.get(url);
}

function resetImageCache() {
  imageCache.clear();
  loadedImages.clear();
}

// a src-less <img> paints Chromium's broken-image icon, so empty ones get a transparent pixel
const BLANK_IMG = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function showImage(img, src, skeleton = false) {
  img.src = src;
  img.classList.toggle('skeleton', skeleton);
}

// placeholder: a low-res version to show while the full one loads;
// keepOld: leave the current picture up until the new one is ready
function setImage(img, url, { placeholder, keepOld = false } = {}) {
  img.dataset.want = url || '';
  if (!url) return showImage(img, BLANK_IMG);
  if (img.getAttribute('src') === url) return;
  if (loadedImages.has(url)) return showImage(img, url);
  const hasPicture = img.getAttribute('src') && img.getAttribute('src') !== BLANK_IMG;
  if (!keepOld || !hasPicture) {
    if (placeholder && loadedImages.has(placeholder)) showImage(img, placeholder);
    else showImage(img, BLANK_IMG, true);
  }
  if (placeholder) {
    preload(placeholder).then(() => {
      if (img.dataset.want === url && img.classList.contains('skeleton')) showImage(img, placeholder);
    });
  }
  preload(url).then(() => {
    if (img.dataset.want === url) showImage(img, url);
  });
}

// ---------- screenshots ----------
const gallery = { shots: [], index: 0 };

function showShot(i) {
  const n = gallery.shots.length;
  gallery.index = n ? (i + n) % n : 0;
  const shot = gallery.shots[gallery.index];
  setImage($('#gMedia'), shot?.full, { placeholder: shot?.thumb });
  $$('.media-arrow').forEach((b) => b.classList.toggle('hidden', n < 2));
  const strip = $('#gShots');
  [...strip.children].forEach((img, idx) => {
    img.classList.toggle('active', idx === gallery.index);
    if (idx !== gallery.index) return;
    // keep the active thumb visible without scrolling the page itself
    if (img.offsetLeft < strip.scrollLeft) strip.scrollLeft = img.offsetLeft;
    else if (img.offsetLeft + img.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = img.offsetLeft + img.offsetWidth - strip.clientWidth;
  });
  if (!$('#lightbox').classList.contains('hidden')) renderLightbox();
}

function renderLightbox() {
  const n = gallery.shots.length;
  setImage($('#lightboxImg'), gallery.shots[gallery.index].full, { keepOld: true });
  $('#lightboxCount').textContent = `${gallery.index + 1} / ${n}`;
  $$('.lightbox-arrow').forEach((b) => b.classList.toggle('hidden', n < 2));
}

function openLightbox() {
  if (!gallery.shots.length) return;
  $('#lightbox').classList.remove('hidden');
  renderLightbox();
}

function closeLightbox() {
  $('#lightbox').classList.add('hidden');
  setImage($('#lightboxImg'), null);
}

// ---------- history ----------
function addToHistory(g) {
  state.history = [g, ...state.history.filter((h) => h.appid !== g.appid)].slice(0, HISTORY_LIMIT);
  store.set('sr.history', state.history);
  renderHistory();
}

function renderHistory() {
  const items = state.history.map((h) =>
    el('div', { class: 'history-item', title: h.name, onclick: () => {
      showGame(h);
      $('#stage').scrollTo({ top: 0, behavior: 'smooth' });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } }, [
      el('img', { src: h.header || '', alt: '', loading: 'lazy' }),
      el('div', { text: h.name }),
    ]),
  );
  if (!items.length) items.push(el('div', { class: 'history-empty', text: t('history.empty') }));
  $('#historyList').replaceChildren(...items);
  $('#clearHistory').classList.toggle('hidden', !state.history.length);
}

// ---------- profile / library ----------
async function loadProfile() {
  const chip = $('#profileChip');
  if (!state.config.steamId) return chip.classList.add('hidden');
  const res = await api.getProfile();
  if (!res.ok || !res.data) return chip.classList.add('hidden');
  state.profile = res.data;
  $('#profileAvatar').src = res.data.avatar;
  $('#profileName').textContent = res.data.name;
  chip.classList.remove('hidden');
}

async function loadOwnedStats(force = false) {
  const box = $('#libraryStats');
  box.textContent = t('library.loading');
  const res = await api.getOwned(force);
  if (!res.ok) {
    box.textContent = res.error;
    return false;
  }
  state.owned = res.data;
  renderOwnedStats();
  return true;
}

function renderOwnedStats() {
  $('#libraryStats').innerHTML = t('library.stats', { count: state.owned.count, unplayed: state.owned.unplayed }, { bold: true });
}

// ---------- settings ----------
function renderSettings() {
  const c = state.config;
  $('#keyStatus').textContent = c.hasKey ? t('settings.keySaved', { hint: c.keyHint }) : t('settings.keyNotSet');
  $('#settingsKeyStorePath').textContent = c.keyStorePath || '';
  renderKeyStorageWarning();
  $('#profileInput').value = '';
  $('#profileInput').placeholder = c.steamId ? t('profile.current', { id: c.steamId }) : t('profile.placeholder');
  setError($('#profileError'), '');
  const card = $('#settingsProfile');
  if (state.profile && c.steamId) {
    $('#settingsAvatar').src = state.profile.avatar;
    $('#settingsProfileName').textContent = state.profile.name;
    $('#settingsProfileId').textContent = state.profile.steamid;
    card.classList.remove('hidden');
  } else {
    card.classList.add('hidden');
  }
  $('#refreshOwned').classList.toggle('hidden', !c.steamId);
  $('#regionSelect').value = c.cc;
  $('#uiLangSelect').value = c.lang;
}

function initSettings() {
  for (const l of D.UI_LANGUAGES) $('#uiLangSelect').append(el('option', { value: l.id, text: l.name }));

  $('#changeKey').addEventListener('click', () => openSetup({ cancellable: true }));
  $('#removeKey').addEventListener('click', async () => {
    if (!confirm(t('settings.confirmRemoveKey'))) return;
    await api.removeKey();
    await reloadConfig();
    openSetup();
  });

  const saveProfile = async () => {
    const btn = $('#saveProfile');
    const input = $('#profileInput').value.trim();
    if (!input && !state.config.steamId) return;
    if (!input && !confirm(t('profile.confirmUnlink'))) return;
    btn.disabled = true;
    const res = await api.saveProfile(input);
    btn.disabled = false;
    if (!res.ok) return setError($('#profileError'), res.error);
    state.profile = res.data;
    await reloadConfig();
    await loadProfile();
    renderSettings();
    toast(res.data ? t('profile.saved', { name: res.data.name }) : t('profile.unlinked'));
    if (res.data && !(await loadOwnedStats(true))) setError($('#profileError'), $('#libraryStats').textContent);
  };
  $('#saveProfile').addEventListener('click', saveProfile);
  $('#profileInput').addEventListener('keydown', (e) => e.key === 'Enter' && saveProfile());

  $('#refreshOwned').addEventListener('click', async () => {
    if (await loadOwnedStats(true)) toast(t('profile.libraryUpdated', { n: state.owned.count }));
    else toast($('#libraryStats').textContent, true);
  });

  $('#saveRegion').addEventListener('click', async () => {
    const langChanged = $('#uiLangSelect').value !== state.config.lang;
    const res = await api.saveRegion({ cc: $('#regionSelect').value, lang: $('#uiLangSelect').value });
    if (!res.ok) return toast(res.error, true);
    await reloadConfig();
    if (langChanged) {
      applyLanguage();
      await loadTags();
    }
    updateSummary();
    toast(t('region.saved'));
  });
}

// ---------- boot ----------
async function afterKeyReady() {
  showView(state.mode);
  loadTags();
  loadProfile();
}

function bindGlobal() {
  $$('[data-win]').forEach((b) => b.addEventListener('click', () => api.window(b.dataset.win)));
  $$('#nav button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-open]');
    if (link) api.open(link.dataset.open);
  });
  $('#profileChip').addEventListener('click', () => showView('settings'));
  $('#goSettings').addEventListener('click', () => showView('settings'));
  $('#rollBtn').addEventListener('click', roll);
  $('#errorRetry').addEventListener('click', roll);
  $('#gReroll').addEventListener('click', roll);
  $('#gOpenSteam').addEventListener('click', () => state.current && api.openApp(state.current.appid));
  $('#gOpenWeb').addEventListener('click', () => state.current && api.open(state.current.storeUrl));
  $('#clearHistory').addEventListener('click', () => {
    state.history = [];
    store.set('sr.history', []);
    renderHistory();
  });
  $('#gMedia').addEventListener('click', openLightbox);
  $('#gMediaPrev').addEventListener('click', () => showShot(gallery.index - 1));
  $('#gMediaNext').addEventListener('click', () => showShot(gallery.index + 1));
  $('#lightboxPrev').addEventListener('click', () => showShot(gallery.index - 1));
  $('#lightboxNext').addEventListener('click', () => showShot(gallery.index + 1));
  $('#lightboxClose').addEventListener('click', closeLightbox);
  $('#lightboxFull').addEventListener('click', (e) => {
    e.preventDefault();
    api.open(gallery.shots[gallery.index].full);
  });
  $('#lightbox').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (!$('#lightbox').classList.contains('hidden')) {
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') showShot(gallery.index - 1);
      else if (e.key === 'ArrowRight') showShot(gallery.index + 1);
      else return;
      e.preventDefault();
      return;
    }
    const typing = e.target.matches('input, select, textarea');
    if (!typing && e.code === 'Space' && !$('#view-main').hidden) {
      e.preventDefault();
      if (!$('#rollBtn').disabled) roll();
    }
  });
}

async function init() {
  document.body.classList.toggle('web', api.platform === 'web');
  const saved = store.get('sr.filters', null);
  if (saved) {
    state.filters = normalizeFilters({ ...D.DEFAULT_FILTERS, ...saved.filters });
    state.preset = saved.preset || null;
  }
  state.history = store.get('sr.history', []);
  state.mode = store.get('sr.mode', 'store') === 'library' ? 'library' : 'store';

  renderStaticFilters();
  bindFilters();
  bindGlobal();
  bindFilterHelp();
  renderFilterHelp();
  initSetup();
  initSettings();
  writeFiltersToDom();
  renderHistory();

  const res = await api.getConfig();
  if (!res.ok) return toast(t('config.failed', { error: res.error }), true);
  state.config = res.data;
  await reloadConfig();
  applyLanguage();

  // The web server refuses to start without a key, and visitors can't enter one anyway.
  if (!state.config.hasKey && !state.config.web) openSetup();
  else afterKeyReady();
}

init();
