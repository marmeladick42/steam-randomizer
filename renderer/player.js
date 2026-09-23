// Trailer player styled after the Steam store's: title bar, a progress bar with the buffered range and
// frame previews, volume, quality and speed settings, theater and full screen.
// Streams play through hls.js (renderer/vendor), which exposes the quality levels; browsers without
// Media Source Extensions fall back to native HLS, without the quality menu.
(() => {
  // Steam keeps a storyboard next to every stream: AVIF tiles of 5x6 frames, one frame per 3 s (90 s a tile).
  const TILE_COLS = 5;
  const TILE_ROWS = 6;
  const FRAME_SECONDS = 3;
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const SEEK_STEP = 5;
  const VOLUME_STEP = 0.1;
  const IDLE_MS = 2500;

  const Hls = window.Hls;
  const useHls = !!Hls?.isSupported();
  const nativeHls = !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl');

  let speed = 1; // lasts for the session, like in most players

  function h(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const child of children) if (child) node.append(child);
    return node;
  }

  function icon(id) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${id}`);
    svg.append(use);
    return svg;
  }

  const setIcon = (button, id) => button.querySelector('use').setAttribute('href', `#${id}`);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pad = (n) => String(n).padStart(2, '0');

  function formatTime(seconds) {
    const s = Math.floor(Number.isFinite(seconds) ? seconds : 0);
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor(s / 60) % 60;
    return hours ? `${hours}:${pad(minutes)}:${pad(s % 60)}` : `${minutes}:${pad(s % 60)}`;
  }

  // <dir>/hls_264_master.m3u8?t=… -> <dir>/dash_thumbnails/thumbnails-00001.avif?t=…
  function storyboard(src) {
    const [path, query] = src.split('?');
    const dir = path.slice(0, path.lastIndexOf('/') + 1);
    return (tile) => `${dir}dash_thumbnails/thumbnails-${String(tile).padStart(5, '0')}.avif${query ? `?${query}` : ''}`;
  }

  // t: translate(key); prefs: { get() -> { volume, muted, autoNext, quality }, set(patch) };
  // wide: 'enter' | 'exit' | null, onWide(); onEnded() -> true when the gallery moved on.
  function create({ src, poster, title, category, start = 0, t, prefs, wide, onWide, onEnded, onError }) {
    const ac = new AbortController();
    const on = (target, type, fn, options) => target.addEventListener(type, fn, { signal: ac.signal, ...options });
    const button = (cls, iconId, action) => {
      const b = h('button', { type: 'button', class: `player-btn ${cls}` }, [icon(iconId)]);
      on(b, 'click', action);
      return b;
    };

    const video = h('video', { playsinline: '', poster });
    const spinner = h('div', { class: 'player-spinner' });
    const replay = h('button', { type: 'button', class: 'player-replay hidden', title: t('player.replay') }, [icon('i-replay')]);
    const top = h('div', { class: 'player-top' }, [
      category && h('span', { class: 'player-category', text: category }),
      h('span', { class: 'player-title', text: title }),
    ]);

    const buffered = h('div', { class: 'player-buffered' });
    const played = h('div', { class: 'player-played' });
    const previewImg = h('div', { class: 'player-preview-img' });
    const previewTime = h('span', { class: 'player-preview-time' });
    const preview = h('div', { class: 'player-preview' }, [previewImg, previewTime]);
    const progress = h('div', { class: 'player-progress' }, [h('div', { class: 'player-track' }, [buffered, played]), preview]);

    const playBtn = button('player-play', 'i-play', () => togglePlay());
    const muteBtn = button('player-mute', 'i-volume', () => toggleMute());
    const volume = h('input', { type: 'range', class: 'player-volume-slider', min: '0', max: '1', step: '0.01', 'aria-label': t('player.volume') });
    const timeLabel = h('span', { class: 'player-time' });

    // settings: quality (hls.js only), speed, auto-advance
    const qualityList = h('div', { class: 'player-qualities' });
    const qualitySection = h('div', { class: 'player-menu-section hidden' }, [
      h('div', { class: 'player-menu-title', text: t('player.quality') }),
      qualityList,
    ]);
    const speedValue = h('span', { class: 'player-menu-value' });
    const speedSlider = h('input', { type: 'range', class: 'player-speed-slider', min: '0', max: String(SPEEDS.length - 1), step: '1', 'aria-label': t('player.speed') });
    const speedTicks = h('div', { class: 'player-speed-ticks' }, SPEEDS.map((s, i) => {
      const tick = h('span', { text: `${s}` });
      tick.style.left = `${(i * 100) / (SPEEDS.length - 1)}%`;
      return tick;
    }));
    const autoNext = h('input', { type: 'checkbox' });
    autoNext.checked = prefs.get().autoNext !== false; // on unless turned off
    on(autoNext, 'change', () => prefs.set({ autoNext: autoNext.checked }));
    // two columns, so the menu fits the small player on the card: quality | speed and auto-advance
    const menu = h('div', { class: 'player-menu hidden' }, [
      qualitySection,
      h('div', { class: 'player-menu-main' }, [
        h('div', { class: 'player-menu-section' }, [
          h('div', { class: 'player-menu-title' }, [h('span', { text: t('player.speed') }), speedValue]),
          speedSlider,
          speedTicks,
        ]),
        h('label', { class: 'check' }, [autoNext, h('span', { text: t('player.autoNext') })]),
      ]),
    ]);
    const gearBtn = button('player-gear', 'i-gear', () => toggleMenu());
    gearBtn.title = t('player.settings');
    const settings = h('div', { class: 'player-settings' }, [gearBtn, menu]);

    const wideBtn = wide && button('player-wide', wide === 'exit' ? 'i-unwide' : 'i-wide', () => onWide());
    if (wideBtn) wideBtn.title = t(wide === 'exit' ? 'player.unwide' : 'player.wide');
    const fsBtn = button('player-fs', 'i-fullscreen', () => toggleFullscreen());
    fsBtn.title = t('player.fullscreen');

    const bottom = h('div', { class: 'player-bottom' }, [
      progress,
      h('div', { class: 'player-controls' }, [
        playBtn,
        h('div', { class: 'player-volume' }, [muteBtn, volume]),
        timeLabel,
        h('span', { class: 'player-spacer' }),
        settings,
        wideBtn,
        fsBtn,
      ]),
    ]);
    const root = h('div', { class: 'player loading paused', tabindex: '0' }, [video, spinner, replay, top, bottom]);

    let hls = null;
    let duration = 0;
    let raf = 0;
    let idleTimer = 0;
    let scrubbing = false;
    let destroyed = false;
    let mediaRecovered = false;

    // ---- playback ----
    function togglePlay() {
      if (video.paused || video.ended) video.play().catch(() => {});
      else video.pause();
    }

    function seekTo(time) {
      if (!duration) return;
      video.currentTime = clamp(time, 0, duration);
      renderTime();
    }

    function renderTime(time = video.currentTime) {
      played.style.width = `${duration ? clamp(time / duration, 0, 1) * 100 : 0}%`;
      timeLabel.textContent = `${formatTime(time)} / ${formatTime(duration)}`;
    }

    function renderBuffered() {
      let end = 0;
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= video.currentTime + 0.5) end = Math.max(end, video.buffered.end(i));
      }
      buffered.style.width = duration ? `${clamp(end / duration, 0, 1) * 100}%` : '0';
    }

    // timeupdate fires only ~4 times a second, too coarse for a smooth bar
    function frame() {
      if (!scrubbing) renderTime();
      renderBuffered();
      raf = requestAnimationFrame(frame);
    }

    on(video, 'durationchange', () => {
      duration = Number.isFinite(video.duration) ? video.duration : 0;
      renderTime();
    });
    on(video, 'progress', renderBuffered);
    on(video, 'play', () => {
      root.classList.remove('paused', 'ended');
      replay.classList.add('hidden');
      setIcon(playBtn, 'i-pause');
      playBtn.title = t('player.pause');
      cancelAnimationFrame(raf);
      frame();
      wake();
    });
    on(video, 'pause', () => {
      root.classList.add('paused');
      setIcon(playBtn, 'i-play');
      playBtn.title = t('player.play');
      cancelAnimationFrame(raf);
      renderTime();
      renderBuffered();
      wake();
    });
    on(video, 'ended', () => {
      if (autoNext.checked && onEnded()) return;
      root.classList.add('ended');
      replay.classList.remove('hidden');
      setIcon(playBtn, 'i-replay');
      playBtn.title = t('player.replay');
    });
    for (const type of ['loadstart', 'waiting', 'seeking']) on(video, type, () => root.classList.add('loading'));
    for (const type of ['playing', 'canplay', 'seeked', 'pause', 'error']) on(video, type, () => root.classList.remove('loading'));
    on(video, 'error', () => destroyed || hls || onError()); // hls.js reports its own errors below
    on(video, 'click', () => togglePlay());
    on(video, 'dblclick', () => toggleFullscreen());
    on(replay, 'click', () => togglePlay());

    // ---- volume ----
    const saved = prefs.get();
    if (Number.isFinite(saved.volume)) video.volume = clamp(saved.volume, 0, 1);
    video.muted = !!saved.muted;

    function renderVolume() {
      const level = video.muted ? 0 : video.volume;
      volume.value = String(level);
      volume.style.setProperty('--fill', `${level * 100}%`);
      setIcon(muteBtn, level === 0 ? 'i-mute' : level < 0.5 ? 'i-volume-low' : 'i-volume');
      muteBtn.title = t(level === 0 ? 'player.unmute' : 'player.mute');
    }

    function toggleMute() {
      if (video.muted || video.volume === 0) {
        video.muted = false;
        if (video.volume === 0) video.volume = 0.5;
      } else {
        video.muted = true;
      }
    }

    function changeVolume(delta) {
      video.volume = clamp(video.volume + delta, 0, 1);
      video.muted = video.volume === 0;
    }

    on(volume, 'input', () => {
      video.volume = Number(volume.value);
      video.muted = video.volume === 0;
    });
    on(video, 'volumechange', () => {
      renderVolume();
      prefs.set({ volume: video.volume, muted: video.muted });
    });

    // ---- speed ----
    function setSpeed(s) {
      speed = s;
      video.defaultPlaybackRate = s; // load() resets playbackRate to this
      video.playbackRate = s;
      const index = SPEEDS.indexOf(s);
      speedSlider.value = String(index);
      speedSlider.style.setProperty('--fill', `${(index * 100) / (SPEEDS.length - 1)}%`);
      speedValue.textContent = s === 1 ? t('player.speedNormal') : `${s}×`;
    }
    on(speedSlider, 'input', () => setSpeed(SPEEDS[Number(speedSlider.value)]));

    // ---- quality: Auto plus every level of the stream, highest first ----
    let qualityButtons = [];
    let selectedLevel = -1; // -1: automatic

    function buildQualities() {
      const levels = hls.levels.map((level, index) => ({ index, height: level.height })).filter((l) => l.height);
      const unique = [...new Map(levels.map((l) => [l.height, l])).values()].sort((a, b) => b.height - a.height);
      if (unique.length < 2) return;
      qualityButtons = [{ index: -1 }, ...unique].map((l) => {
        const b = h('button', { type: 'button', class: 'player-quality' });
        b.dataset.level = String(l.index);
        if (l.index >= 0) b.textContent = `${l.height}p`;
        on(b, 'click', () => setQuality(l.index, l.height));
        return b;
      });
      qualityList.replaceChildren(...qualityButtons);
      qualitySection.classList.remove('hidden');
      // the saved choice, when this stream has that height
      const preferred = unique.find((l) => l.height === prefs.get().quality);
      if (preferred) {
        selectedLevel = preferred.index;
        hls.startLevel = preferred.index;
        hls.nextLevel = preferred.index;
      }
      renderQuality();
    }

    function setQuality(index, height) {
      selectedLevel = index;
      hls.nextLevel = index; // switches from the next fragment on, without dropping what is on screen; -1 is automatic
      prefs.set({ quality: index < 0 ? null : height });
      renderQuality();
    }

    // "Auto" names the level it is playing right now
    function renderQuality() {
      const current = hls.levels[hls.currentLevel];
      for (const b of qualityButtons) {
        const level = Number(b.dataset.level);
        b.classList.toggle('active', level === selectedLevel);
        if (level < 0) b.textContent = current && selectedLevel < 0 ? `${t('player.auto')} (${current.height}p)` : t('player.auto');
      }
    }

    // ---- progress bar: hover preview and scrubbing ----
    const tileUrl = storyboard(src);
    const missingTiles = new Set();
    const requestedTiles = new Set();

    const ratioAt = (e) => {
      const rect = progress.getBoundingClientRect();
      return clamp((e.clientX - rect.left) / rect.width, 0, 1);
    };

    function showPreview(ratio) {
      if (!duration) return;
      const time = ratio * duration;
      const index = Math.floor(time / FRAME_SECONDS);
      const tile = Math.floor(index / (TILE_COLS * TILE_ROWS)) + 1;
      const cell = index % (TILE_COLS * TILE_ROWS);
      const url = tileUrl(tile);
      // tiles load only on hover; a missing one leaves just the time label
      if (!requestedTiles.has(tile)) {
        requestedTiles.add(tile);
        const probe = new Image();
        probe.onerror = () => {
          missingTiles.add(tile);
          preview.classList.add('no-image');
        };
        probe.src = url;
      }
      preview.classList.toggle('no-image', missingTiles.has(tile));
      previewImg.style.backgroundImage = `url("${url}")`;
      previewImg.style.backgroundPosition = `${((cell % TILE_COLS) * 100) / (TILE_COLS - 1)}% ${(Math.floor(cell / TILE_COLS) * 100) / (TILE_ROWS - 1)}%`;
      previewTime.textContent = formatTime(time);
      preview.classList.add('visible');
      // keep the preview inside the player
      const half = preview.offsetWidth / 2;
      preview.style.left = `${clamp(ratio * progress.clientWidth, half, progress.clientWidth - half)}px`;
    }

    on(progress, 'pointermove', (e) => {
      showPreview(ratioAt(e));
      if (scrubbing) renderTime(ratioAt(e) * duration);
    });
    on(progress, 'pointerleave', () => scrubbing || preview.classList.remove('visible'));
    on(progress, 'pointerdown', (e) => {
      if (!duration || e.button !== 0) return;
      scrubbing = true;
      progress.setPointerCapture(e.pointerId);
      root.classList.add('scrubbing');
      renderTime(ratioAt(e) * duration);
      showPreview(ratioAt(e));
    });
    const endScrub = (e) => {
      if (!scrubbing) return;
      scrubbing = false;
      root.classList.remove('scrubbing');
      seekTo(ratioAt(e) * duration);
      if (!progress.matches(':hover')) preview.classList.remove('visible');
      wake();
    };
    on(progress, 'pointerup', endScrub);
    on(progress, 'pointercancel', endScrub);

    // ---- settings menu ----
    const menuOpen = () => !menu.classList.contains('hidden');
    function toggleMenu() {
      menu.classList.toggle('hidden');
      gearBtn.classList.toggle('active', menuOpen());
      if (hls && menuOpen()) renderQuality();
      wake();
    }
    function closeMenu() {
      menu.classList.add('hidden');
      gearBtn.classList.remove('active');
      wake();
    }
    // With the menu open, a press anywhere else in the player only closes it: no pause, seek or button press.
    // The menu closes on pointerdown, so the click that follows has to be swallowed too.
    let swallowClick = false;
    on(root, 'pointerdown', (e) => {
      swallowClick = false;
      if (!menuOpen() || settings.contains(e.target)) return;
      e.stopPropagation();
      swallowClick = true;
      closeMenu();
    }, { capture: true });
    on(root, 'click', (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    }, { capture: true });
    on(root, 'dblclick', (e) => swallowClick && e.stopPropagation(), { capture: true });
    // a press outside the player closes the menu and does whatever it normally does
    on(document, 'pointerdown', (e) => menuOpen() && !root.contains(e.target) && closeMenu());

    // ---- full screen ----
    function toggleFullscreen() {
      if (document.fullscreenElement === root) document.exitFullscreen().catch(() => {});
      else root.requestFullscreen().catch(() => {});
    }
    on(document, 'fullscreenchange', () => {
      const full = document.fullscreenElement === root;
      setIcon(fsBtn, full ? 'i-fullscreen-exit' : 'i-fullscreen');
      fsBtn.title = t(full ? 'player.exitFullscreen' : 'player.fullscreen');
      if (wideBtn) wideBtn.classList.toggle('hidden', full);
    });

    // ---- controls hide while playing and the mouse rests ----
    function wake() {
      root.classList.remove('idle');
      clearTimeout(idleTimer);
      if (video.paused || scrubbing || menuOpen()) return;
      idleTimer = setTimeout(() => {
        if (bottom.matches(':hover')) wake();
        else root.classList.add('idle');
      }, IDLE_MS);
    }
    on(root, 'pointermove', wake);
    on(root, 'pointerdown', wake);
    on(root, 'pointerleave', () => {
      if (!video.paused && !scrubbing && !menuOpen()) root.classList.add('idle');
    });

    // ---- keyboard (the player is focusable; handled keys don't reach the page shortcuts) ----
    // e.code, not e.key, so the letters work in any keyboard layout
    const keys = {
      Space: togglePlay,
      KeyK: togglePlay,
      ArrowLeft: () => seekTo(video.currentTime - SEEK_STEP),
      ArrowRight: () => seekTo(video.currentTime + SEEK_STEP),
      ArrowUp: () => changeVolume(VOLUME_STEP),
      ArrowDown: () => changeVolume(-VOLUME_STEP),
      KeyM: toggleMute,
      KeyF: toggleFullscreen,
    };
    on(root, 'keydown', (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      wake();
      if (e.code === 'Escape' && menuOpen()) {
        e.stopPropagation();
        return closeMenu();
      }
      // a focused control keeps its own keys: Space/Enter press a button or checkbox, arrows move a slider
      const control = e.target !== root && e.target.matches('button, input');
      const sliderKey = e.target.matches('input[type="range"]') && e.code.startsWith('Arrow');
      if (control && (e.code === 'Space' || e.code === 'Enter' || sliderKey)) {
        e.stopPropagation();
        return;
      }
      const action = keys[e.code];
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      action();
    });

    function destroy() {
      destroyed = true;
      ac.abort();
      cancelAnimationFrame(raf);
      clearTimeout(idleTimer);
      if (document.fullscreenElement === root) document.exitFullscreen().catch(() => {});
      video.pause();
      // stops every request of the stream; pausing alone keeps it buffering
      hls?.destroy();
      video.removeAttribute('src');
      video.load();
      root.remove();
    }

    setSpeed(speed);
    renderVolume();
    renderTime();
    if (useHls) {
      // trailers autoplay on every rolled game, so buffer 12 s ahead instead of hls.js's 30 s:
      // less wasted traffic when the game is skipped, still plenty against stalls
      hls = new Hls({ enableWorker: false, startPosition: start > 0 ? start : -1, maxBufferLength: 12 });
      hls.on(Hls.Events.MANIFEST_PARSED, buildQualities);
      hls.on(Hls.Events.LEVEL_SWITCHED, () => renderQuality());
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || destroyed) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered) {
          mediaRecovered = true;
          hls.recoverMediaError();
        } else {
          onError();
        }
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    } else {
      if (start > 0) on(video, 'loadedmetadata', () => (video.currentTime = start), { once: true });
      video.src = src;
    }
    video.play().catch(() => {});

    // time: where to pick up when the trailer moves to another container (from the start once it has ended)
    return { el: root, destroy, time: () => (video.ended ? 0 : video.currentTime) };
  }

  window.TrailerPlayer = { create, supported: useHls || nativeHls };
})();
