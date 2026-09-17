// `api` is exposed by preload.js via contextBridge.
const D = window.DATA;
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

const fmtNum = (n) => Number(n).toLocaleString('ru-RU');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function plural(n, forms) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return forms[0];
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return forms[1];
  return forms[2];
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
  $('#modeEyebrow').textContent = mode === 'library' ? 'Ваша библиотека Steam' : 'Весь каталог Steam';
  const needsProfile = mode === 'library' && !state.config.steamId;
  $('#libraryNotice').classList.toggle('hidden', !needsProfile);
  $('#rollBtn').disabled = needsProfile || state.rolling;
  if (mode === 'library' && !needsProfile) loadOwnedStats();
  updateSummary();
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
    if (!key) return setError(errorBox, 'Вставьте ключ API.');

    btn.disabled = true;
    btn.textContent = 'Проверяем ключ…';
    try {
      const res = await api.saveKey(key);
      if (!res.ok) {
        const message = res.code === 'BAD_KEY' ? 'Steam не принял этот ключ. Проверьте, что он скопирован полностью.' : res.error;
        return setError(errorBox, message);
      }
      if (profile) {
        btn.textContent = 'Ищем профиль…';
        const pr = await api.saveProfile(profile);
        if (!pr.ok) {
          await reloadConfig();
          $('#setupKey').value = '';
          return setError(errorBox, `Ключ сохранён, но профиль не найден: ${pr.error}. Исправьте ссылку или оставьте поле пустым.`);
        }
      }
      $('#setupKey').value = '';
      await reloadConfig();
      toast('Ключ сохранён');
      await afterKeyReady();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Проверить и сохранить';
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
}

// ---------- filters ----------
function renderStaticFilters() {
  const presets = $('#presets');
  for (const p of D.PRESETS) {
    presets.append(el('button', { class: 'preset', title: p.hint, 'data-preset': p.id, text: p.name, onclick: () => applyPreset(p) }));
  }
  const checkList = (container, items, group) => {
    for (const item of items) {
      container.append(
        el('label', { class: 'check' }, [
          el('input', { type: 'checkbox', 'data-f-group': group, value: String(item.id) }),
          el('span', { text: item.name }),
        ]),
      );
    }
  };
  checkList($('#playersList'), D.PLAYERS, 'players');
  checkList($('#featuresList'), D.FEATURES, 'features');
  for (const l of D.LANGUAGES) $('#languageSelect').append(el('option', { value: l.id, text: l.name }));
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
  if (f.includeTags.length) parts.push(`метки: ${names(f.includeTags).join(', ')}`);
  if (f.excludeTags.length) parts.push(`без: ${names(f.excludeTags).join(', ')}`);
  if (state.mode === 'store') {
    if (f.priceMode === 'free') parts.push('бесплатные');
    if (f.priceMode === 'paid') parts.push('платные');
    if (f.priceMin || f.priceMax) parts.push(`цена ${f.priceMin || 0}–${f.priceMax || '∞'} ${$('#currencyLabel').textContent}`);
    if (f.onSale || f.minDiscount) parts.push(f.minDiscount ? `скидка от ${f.minDiscount}%` : 'со скидкой');
    if (f.language) parts.push(`язык: ${D.LANGUAGES.find((l) => l.id === f.language)?.name}`);
    if (f.topSellers) parts.push('лидеры продаж');
  } else {
    const pt = { never: 'не запускались', under: `< ${f.playtimeHours} ч`, over: `≥ ${f.playtimeHours} ч` }[f.playtime];
    if (pt) parts.push(pt);
  }
  if (f.minPositive) parts.push(`${f.minPositive}%+ положительных`);
  if (f.minReviews || f.maxReviews) parts.push(`отзывов ${f.minReviews || 0}–${f.maxReviews || '∞'}`);
  if (f.yearFrom || f.yearTo) parts.push(`${f.yearFrom || '…'}–${f.yearTo || '…'} г.`);
  const cats = [...D.PLAYERS, ...D.FEATURES].filter((c) => [...f.players, ...f.features].includes(c.id));
  if (cats.length) parts.push(cats.map((c) => c.name.toLowerCase()).join(', '));
  if (f.os.length) parts.push(f.os.map((o) => ({ win: 'Windows', mac: 'macOS', linux: 'SteamOS' })[o]).join('/'));
  if (f.deck !== 'any') parts.push(f.deck === 'verified' ? 'Deck: проверено' : 'Deck: играбельно');
  if (f.vr !== 'any') parts.push(f.vr === 'only' ? 'только VR' : 'без VR');
  if (f.hideEarlyAccess) parts.push('без раннего доступа');
  $('#filterSummary').textContent = parts.length
    ? parts.join(' · ')
    : 'Фильтры не заданы — подойдёт любая игра';
}

// ---------- tags ----------
async function loadTags() {
  const res = await api.getTags();
  if (!res.ok) {
    $('#tagList').replaceChildren(el('div', { class: 'muted small', text: `Не удалось загрузить метки: ${res.error}` }));
    return;
  }
  state.tags = res.data;
  state.tagNames = new Map(res.data.map((t) => [t.id, t.name]));
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
    el('span', { class: `tag-chip ${cls}`, title: 'Убрать', text: state.tagNames.get(id) || `#${id}`, onclick: () => removeTag(id) }),
  );
  $('#tagSelected').replaceChildren(...chips);
  const count = f.includeTags.length + f.excludeTags.length;
  $('#tagCounter').textContent = count ? `(${count})` : '';
  renderTagList();
}

function renderTagList() {
  if (!state.tags.length) return;
  const q = $('#tagSearch').value.trim().toLowerCase();
  const list = q ? state.tags.filter((t) => t.name.toLowerCase().includes(q)) : state.tags;
  const rows = list.slice(0, 200).map((t) => {
    const st = tagStateOf(t.id);
    return el('div', { class: `tag-row ${st}`, onclick: () => cycleTag(t.id) }, [
      el('span', { class: 'state' }),
      el('span', { class: 'name', text: t.name }),
    ]);
  });
  if (!rows.length) rows.push(el('div', { class: 'muted small', text: 'Ничего не найдено' }));
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
  $('#rollingText').textContent = state.mode === 'library' ? 'Перебираем вашу библиотеку…' : 'Ищем в каталоге Steam…';
  const unsubscribe = api.onRollProgress((p) => {
    pool.push(...p.previews);
    $('#rollingText').textContent = `Проверено ${fmtNum(p.checked)} из ${fmtNum(p.total)} ${plural(p.total, ['игры', 'игр', 'игр'])}…`;
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
    if (res.code === 'BAD_KEY') {
      toast('Ключ API больше не действует — введите новый', true);
      await reloadConfig();
      return openSetup();
    }
    $('#errorTitle').textContent = ERROR_TITLES[res.code] || 'Что-то пошло не так';
    $('#errorText').textContent = res.error;
    setStage('error');
    return;
  }
  showGame(res.data);
  addToHistory(res.data);
}

const ERROR_TITLES = {
  NO_RESULTS: 'Ничего не нашлось',
  NO_MATCH: 'Ничего не нашлось',
  BAD_FILTERS: 'Фильтры противоречат друг другу',
  SAMPLE_LIMIT: 'Упёрлись в лимит проверки',
  RATE_LIMIT: 'Steam ограничил запросы',
  NETWORK: 'Нет связи со Steam',
};

function showGame(g) {
  state.current = g;
  setStage('game');
  $('#gName').textContent = g.name;
  if (!g.poolSize) $('#gPool').textContent = '';
  else if (g.playtime !== null) $('#gPool').textContent = `Выбрано из ${fmtNum(g.poolSize)} игр библиотеки`;
  else $('#gPool').textContent = `Подходящих по поиску Steam: ${fmtNum(g.poolSize)}`;
  $('#gHeader').src = g.header || '';
  $('#gDesc').textContent = g.description || 'Описание недоступно.';

  const rv = $('#gReviews');
  if (g.reviews && g.reviews.count) {
    rv.textContent = `${g.reviews.label} (${g.reviews.percent}% из ${fmtNum(g.reviews.count)})`;
    rv.className = g.reviews.percent >= 70 ? 'rv-positive' : g.reviews.percent >= 40 ? 'rv-mixed' : 'rv-negative';
  } else {
    rv.textContent = 'Нет обзоров';
    rv.className = '';
  }
  $('#gDate').textContent = g.releaseDate || '—';
  $('#gDev').textContent = g.developers.join(', ') || '—';
  $('#gPub').textContent = g.publishers.join(', ') || '—';
  $('#gTags').replaceChildren(...(g.tags.length ? g.tags : g.genres).map((t) => el('span', { text: t })));

  // media
  const shots = g.screenshots.length ? g.screenshots : g.header ? [{ thumb: g.header, full: g.header }] : [];
  const main = $('#gMedia');
  const select = (shot, thumb) => {
    main.src = shot.full;
    $$('#gShots img').forEach((i) => i.classList.toggle('active', i === thumb));
  };
  const thumbs = shots.map((s) => {
    const img = el('img', { src: s.thumb, alt: '', loading: 'lazy' });
    img.addEventListener('click', () => select(s, img));
    return img;
  });
  $('#gShots').replaceChildren(...thumbs);
  if (shots[0]) select(shots[0], thumbs[0]);
  else main.src = '';

  const bg = $('#stageBg');
  bg.style.backgroundImage = g.background ? `url("${g.background}")` : g.screenshots[0] ? `url("${g.screenshots[0].full}")` : 'none';
  bg.classList.add('visible');

  // badges
  const badges = [];
  const osNames = { win: ['i-win', 'Windows'], mac: ['i-mac', 'macOS'], linux: ['i-linux', 'SteamOS'] };
  for (const [key, [icon, title]] of Object.entries(osNames)) {
    if (g.platforms[key]) badges.push(el('span', { class: 'badge', title }, [svgIcon(icon)]));
  }
  if (D.DECK_LABELS[g.deck]) badges.push(el('span', { class: `badge ${g.deck === 3 ? 'hot' : ''}`, text: `Steam Deck: ${D.DECK_LABELS[g.deck]}` }));
  if (g.vr) badges.push(el('span', { class: 'badge hot', text: 'VR' }));
  if (g.metacritic) {
    const cls = g.metacritic >= 75 ? '' : g.metacritic >= 50 ? 'mid' : 'low';
    badges.push(el('span', { class: `badge meta ${cls}`, title: 'Metacritic', text: `MC ${g.metacritic}` }));
  }
  if (g.playtime !== null) {
    const hours = g.playtime / 60;
    badges.push(el('span', { class: 'badge hot', text: g.playtime ? `Сыграно ${hours < 10 ? hours.toFixed(1) : Math.round(hours)} ч` : 'Ещё не запускалась' }));
  }
  $('#gBadges').replaceChildren(...badges);

  // price
  const price = $('#gPrice');
  const p = g.price;
  if (g.playtime !== null) {
    price.replaceChildren(el('span', { class: 'final', text: 'В библиотеке' }));
  } else if (!p) {
    price.replaceChildren(el('span', { class: 'orig', text: 'Цена недоступна' }));
  } else if (p.free) {
    price.replaceChildren(el('span', { class: 'final', text: 'Бесплатно' }));
  } else if (p.discount) {
    price.replaceChildren(
      el('span', { class: 'discount', text: `-${p.discount}%` }),
      el('span', {}, [el('span', { class: 'orig', text: p.formattedOriginal || '' }), el('span', { class: 'final', text: p.formatted })]),
    );
  } else {
    price.replaceChildren(el('span', { class: 'final', text: p.formatted }));
  }
}

// ---------- history ----------
function addToHistory(g) {
  state.history = [g, ...state.history.filter((h) => h.appid !== g.appid)].slice(0, HISTORY_LIMIT);
  store.set('sr.history', state.history);
  renderHistory();
}

function renderHistory() {
  const items = state.history.map((h) =>
    el('div', { class: 'history-item', title: h.name, onclick: () => showGame(h) }, [
      el('img', { src: h.header || '', alt: '', loading: 'lazy' }),
      el('div', { text: h.name }),
    ]),
  );
  if (!items.length) items.push(el('div', { class: 'history-empty', text: 'Здесь появятся игры, которые вам выпадут.' }));
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
  box.textContent = 'Загружаем библиотеку…';
  const res = await api.getOwned(force);
  if (!res.ok) {
    box.textContent = res.error;
    return false;
  }
  state.owned = res.data;
  box.replaceChildren(
    'В библиотеке ',
    el('b', { text: fmtNum(res.data.count) }),
    ` ${plural(res.data.count, ['игра', 'игры', 'игр'])}, не запускались: `,
    el('b', { text: fmtNum(res.data.unplayed) }),
  );
  return true;
}

// ---------- settings ----------
function renderSettings() {
  const c = state.config;
  $('#keyStatus').textContent = c.hasKey ? `Сохранён ${c.keyHint}` : 'Не задан';
  $('#settingsKeyStorePath').textContent = c.keyStorePath;
  renderKeyStorageWarning();
  $('#profileInput').value = '';
  $('#profileInput').placeholder = c.steamId ? `Текущий: ${c.steamId}` : 'https://steamcommunity.com/id/ваш_ник или SteamID64';
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
  for (const r of D.REGIONS) $('#regionSelect').append(el('option', { value: r.id, text: `${r.name} (${r.usdOnly ? 'USD — Steam продаёт в долларах' : r.currency})` }));
  for (const l of D.UI_LANGUAGES) $('#uiLangSelect').append(el('option', { value: l.id, text: l.name }));

  $('#changeKey').addEventListener('click', () => openSetup({ cancellable: true }));
  $('#removeKey').addEventListener('click', async () => {
    if (!confirm('Удалить сохранённый ключ API?')) return;
    await api.removeKey();
    await reloadConfig();
    openSetup();
  });

  const saveProfile = async () => {
    const btn = $('#saveProfile');
    const input = $('#profileInput').value.trim();
    if (!input && !state.config.steamId) return;
    if (!input && !confirm('Отвязать профиль Steam?')) return;
    btn.disabled = true;
    const res = await api.saveProfile(input);
    btn.disabled = false;
    if (!res.ok) return setError($('#profileError'), res.error);
    state.profile = res.data;
    await reloadConfig();
    await loadProfile();
    renderSettings();
    toast(res.data ? `Профиль ${res.data.name} сохранён` : 'Профиль отвязан');
    if (res.data && !(await loadOwnedStats(true))) setError($('#profileError'), $('#libraryStats').textContent);
  };
  $('#saveProfile').addEventListener('click', saveProfile);
  $('#profileInput').addEventListener('keydown', (e) => e.key === 'Enter' && saveProfile());

  $('#refreshOwned').addEventListener('click', async () => {
    if (await loadOwnedStats(true)) toast(`Библиотека обновлена: ${fmtNum(state.owned.count)} игр`);
    else toast($('#libraryStats').textContent, true);
  });

  $('#saveRegion').addEventListener('click', async () => {
    const langChanged = $('#uiLangSelect').value !== state.config.lang;
    const res = await api.saveRegion({ cc: $('#regionSelect').value, lang: $('#uiLangSelect').value });
    if (!res.ok) return toast(res.error, true);
    await reloadConfig();
    if (langChanged) await loadTags();
    updateSummary();
    toast('Регион и язык сохранены');
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
  $('#gMedia').addEventListener('click', (e) => {
    if (!e.target.src) return;
    $('#lightboxImg').src = e.target.src;
    $('#lightbox').classList.remove('hidden');
  });
  $('#lightbox').addEventListener('click', () => $('#lightbox').classList.add('hidden'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('#lightbox').classList.add('hidden');
    const typing = e.target.matches('input, select, textarea');
    if (!typing && e.code === 'Space' && !$('#view-main').hidden) {
      e.preventDefault();
      if (!$('#rollBtn').disabled) roll();
    }
  });
}

async function init() {
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
  initSetup();
  initSettings();
  writeFiltersToDom();
  renderHistory();

  const res = await api.getConfig();
  if (!res.ok) return toast(`Не удалось прочитать настройки: ${res.error}`, true);
  state.config = res.data;
  await reloadConfig();

  if (!state.config.hasKey) openSetup();
  else afterKeyReady();
}

init();
