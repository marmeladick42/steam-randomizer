// Browser replacement for preload.js: the same `window.api`, backed by web/server.js.
// Profile, region and language live in this browser; the Steam API key never leaves the server.
(() => {
  const LOCAL_KEY = 'sr.web.settings';
  const progressListeners = new Set();

  const local = {
    get() {
      try {
        return JSON.parse(localStorage.getItem(LOCAL_KEY)) || {};
      } catch {
        return {};
      }
    },
    set(patch) {
      const next = { ...local.get(), ...patch };
      try {
        localStorage.setItem(LOCAL_KEY, JSON.stringify(next));
      } catch {
        /* settings then last for this page only */
      }
      memory = next;
    },
  };
  let memory = local.get();
  let defaults = { cc: 'us', lang: 'russian' };

  const failure = (error, code) => ({ ok: false, error, code });

  const post = (name, body = {}) =>
    fetch(`api/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  async function call(name, body) {
    try {
      const res = await post(name, body);
      return await res.json();
    } catch {
      return failure('Нет связи с сервером', 'OFFLINE');
    }
  }

  const visitor = () => ({ steamId: memory.steamId || '', cc: memory.cc || defaults.cc, lang: memory.lang || defaults.lang });

  async function roll(payload) {
    let res;
    try {
      res = await post('roll', { ...payload, ...visitor() });
    } catch {
      return failure('Нет связи с сервером', 'OFFLINE');
    }
    if (!String(res.headers.get('content-type')).includes('ndjson')) {
      try {
        return await res.json();
      } catch {
        return failure(`Сервер вернул ошибку ${res.status}`, 'SERVER');
      }
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          if (msg.progress) progressListeners.forEach((cb) => cb(msg.progress));
          else return msg;
        }
      }
    } catch {
      /* falls through to the error below */
    }
    return failure('Соединение с сервером прервалось', 'OFFLINE');
  }

  const unavailable = () => Promise.resolve(failure('Ключ API задаётся только на сервере', 'WEB'));

  window.api = {
    platform: 'web',
    async getConfig() {
      const res = await call('config');
      if (!res.ok) return res;
      defaults = { cc: res.data.cc, lang: res.data.lang };
      return { ok: true, data: { web: true, hasKey: res.data.hasKey, keyHint: '', encryptionAvailable: true, ...visitor() } };
    },
    saveKey: unavailable,
    removeKey: unavailable,
    async saveProfile(input) {
      const text = String(input || '').trim();
      if (!text) {
        local.set({ steamId: '' });
        return { ok: true, data: null };
      }
      const res = await call('profile', { input: text });
      if (res.ok) local.set({ steamId: res.data.steamid });
      return res;
    },
    async saveRegion({ cc, lang }) {
      if (!/^[a-z]{2}$/.test(cc) || !/^[a-z]{2,12}$/.test(lang)) return failure('Некорректный регион или язык');
      local.set({ cc, lang });
      return { ok: true, data: true };
    },
    async getProfile() {
      if (!memory.steamId) return { ok: true, data: null };
      return call('player', { steamId: memory.steamId });
    },
    getTags: () => call('tags', visitor()),
    getOwned: (force) => call('owned', { steamId: memory.steamId || '', force: !!force }),
    roll,
    async open(url) {
      if (/^https:\/\//.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
      else if (/^steam:\/\//.test(url)) window.location.href = url;
      else return failure('Недопустимая ссылка');
      return { ok: true, data: true };
    },
    // Hands the link to the Steam client if it is installed; "В браузере" covers the rest.
    async openApp(appid) {
      window.location.href = `steam://store/${Number(appid)}`;
      return { ok: true, data: true };
    },
    window: () => {},
    onRollProgress(cb) {
      progressListeners.add(cb);
      return () => progressListeners.delete(cb);
    },
    onWindowState: () => {},
  };
})();
