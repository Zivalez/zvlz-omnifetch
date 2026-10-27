/* Small UI toolkit: icons, dropdowns, menus, sheets, custom scrollbars, toast, thumbnails. */

export function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}

/* ───────────── Icons ───────────── */

const PATHS = {
  video: '<rect x="2" y="4" width="9.5" height="8" rx="2"/><path d="m11.5 7 2.8-1.7v5.4L11.5 9"/>',
  audio: '<path d="M6 11.5V3.8l7-1.6v7.6"/><circle cx="4.4" cy="11.6" r="1.6"/><circle cx="11.4" cy="9.8" r="1.6"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="2"/><circle cx="5.8" cy="6.6" r="1.1"/><path d="m3 12 3.6-3.4 2.4 2.2 1.8-1.6L13 12"/>',
  download: '<path d="M8 2.5v7.2M4.8 6.8 8 10l3.2-3.2M3 13h10"/>',
  more: '<circle cx="3.6" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="12.4" cy="8" r="1.1" fill="currentColor" stroke="none"/>',
  chevron: '<path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>',
  chevronRight: '<path d="m6.5 4.5 3.5 3.5-3.5 3.5"/>',
  check: '<path d="m3.5 8.4 3 3 6-6.4"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="2"/><path d="M10.5 5.5v-1a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.3v3.6"/><circle cx="8" cy="5.2" r=".6" fill="currentColor" stroke="none"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
  queue: '<path d="M8 2.5v6.7M5.2 6.6 8 9.4l2.8-2.8"/><path d="M2.5 10.5v1a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-1"/>',
  history: '<path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.7"/><path d="M2.6 2.6v2.6h2.6M8 5.2V8l2 1.3"/>',
  settings: '<g transform="scale(0.6667)" stroke-width="2.1"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></g>',
  folder: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.6h4.8A1.5 1.5 0 0 1 14 6.1v5.4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>',
  panel: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M10 3v10"/>',
  refresh: '<path d="M13 7.5A5 5 0 0 0 4 5.2L3 6.4M3 2.8v3.6h3.6M3 8.5A5 5 0 0 0 12 10.8l1-1.2M13 13.2V9.6H9.4"/>',
  back: '<path d="M9.5 3.5 5 8l4.5 4.5"/>',
  record: '<circle cx="8" cy="8" r="5.3"/><circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none"/>',
  alert: '<path d="M8 2.2 14.2 13H1.8L8 2.2Z"/><path d="M8 6.6v3"/><circle cx="8" cy="11.2" r=".6" fill="currentColor" stroke="none"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.3" rx="1.8"/><path d="M5.5 7V5.4a2.5 2.5 0 0 1 5 0V7"/>',
  subtitle: '<rect x="2" y="3.2" width="12" height="9.6" rx="2"/><path d="M4.6 8h2.2M8.6 8h2.8M4.6 10.3h3.4M9.8 10.3h1.6"/>',
  file: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/>',
  trash: '<path d="M3 4.6h10M6.4 4.6V3h3.2v1.6M4.6 4.6l.6 8.4h5.6l.6-8.4"/>',
  pause: '<path d="M5.6 3.5v9M10.4 3.5v9"/>',
  play: '<path d="M5.4 3.6v8.8L12.4 8z" fill="currentColor"/>',
};

export function icon(name, size = 16) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.4');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = PATHS[name] || PATHS.file;
  return s;
}

export function iconButton(name, label, onClick, cls = '') {
  return h('button', { class: `icon-btn ${cls}`, type: 'button', 'aria-label': label, title: label, onclick: onClick }, icon(name, 16));
}

/* ───────────── Custom scrollbar (no native bar) ───────────── */

export function scrollArea(content, cls = '') {
  const view = h('div', { class: 'sc-view' }, content);
  const thumb = h('div', { class: 'sc-thumb' });
  const track = h('div', { class: 'sc-track', hidden: true }, thumb);
  const root = h('div', { class: `sc ${cls}` }, view, track);
  let idle = 0;

  const update = () => {
    const { scrollHeight: sh, clientHeight: ch, scrollTop: st } = view;
    const can = sh > ch + 1;
    track.hidden = !can;
    if (!can) return;
    const th = Math.max(32, (ch * ch) / sh);
    thumb.style.height = `${th}px`;
    thumb.style.transform = `translateY(${(st / (sh - ch)) * (ch - th)}px)`;
  };
  let raf = 0;
  view.addEventListener('scroll', () => {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); });
    root.classList.add('is-scrolling');
    clearTimeout(idle);
    idle = setTimeout(() => root.classList.remove('is-scrolling'), 800);
  }, { passive: true });
  const ro = new ResizeObserver(update);
  ro.observe(view);
  ro.observe(content);

  thumb.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    thumb.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startTop = view.scrollTop;
    root.classList.add('is-dragging');
    const move = (ev) => {
      const { scrollHeight: sh, clientHeight: ch } = view;
      const th = thumb.offsetHeight;
      view.scrollTop = startTop + ((ev.clientY - startY) * (sh - ch)) / Math.max(1, ch - th);
    };
    const up = () => {
      root.classList.remove('is-dragging');
      thumb.removeEventListener('pointermove', move);
      thumb.removeEventListener('pointerup', up);
    };
    thumb.addEventListener('pointermove', move);
    thumb.addEventListener('pointerup', up);
  });
  track.addEventListener('pointerdown', (e) => {
    if (e.target !== track) return;
    const r = thumb.getBoundingClientRect();
    view.scrollBy({ top: e.clientY < r.top ? -view.clientHeight * 0.9 : view.clientHeight * 0.9, behavior: 'smooth' });
  });

  root.view = view;
  root.refresh = update;
  requestAnimationFrame(update);
  return root;
}

/* ───────────── Overlay layer: menus, selects, sheets, toast ───────────── */

const overlay = () => document.getElementById('overlay');
let menuState = null;

export function pruneMenu() {
  if (menuState && !document.contains(menuState.anchor)) closeMenu();
}

export function closeMenu() {
  if (!menuState) return;
  const { el, anchor, off } = menuState;
  menuState = null;
  off();
  el.remove();
  if (anchor) anchor.setAttribute('aria-expanded', 'false');
}

/**
 * items: [{label, hint, icon, disabled, selected, danger, divider, onSelect}]
 * opts: {width, align: 'left'|'right', matchWidth}
 */
export function openMenu(anchor, items, opts = {}) {
  const wasOpen = menuState && menuState.anchor === anchor;
  closeMenu();
  if (wasOpen) return;

  const list = h('div', { class: 'menu-list', role: 'menu' });
  for (const it of items) {
    if (it.divider) { list.append(h('div', { class: 'menu-div', role: 'separator' })); continue; }
    const b = h('button', {
      class: `menu-item${it.selected ? ' is-selected' : ''}${it.danger ? ' is-danger' : ''}`,
      type: 'button', role: 'menuitem', disabled: it.disabled,
    },
    it.icon ? icon(it.icon, 15) : null,
    h('span', { class: 'mi-text' }, h('span', { class: 'mi-label' }, it.label), it.hint ? h('span', { class: 'mi-hint' }, it.hint) : null),
    it.selected ? icon('check', 14) : null);
    b.addEventListener('click', () => { closeMenu(); anchor.focus?.(); it.onSelect?.(); });
    list.append(b);
  }
  const area = scrollArea(list, 'menu-scroll');
  const el = h('div', { class: 'menu' }, area);
  overlay().append(el);

  const rect = anchor.getBoundingClientRect();
  const width = opts.matchWidth ? rect.width : opts.width || 220;
  el.style.width = `${width}px`;
  const mh = Math.min(el.offsetHeight, 280);
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = opts.align === 'right' ? rect.right - width : rect.left;
  left = Math.max(8, Math.min(left, vw - width - 8));
  const below = vh - rect.bottom - 10;
  const above = rect.top - 10;
  const openUp = below < mh && above > below;
  el.style.left = `${left}px`;
  el.style.maxHeight = `${Math.max(120, openUp ? above : below)}px`;
  area.style.maxHeight = el.style.maxHeight;
  if (openUp) { el.style.bottom = `${vh - rect.top + 6}px`; el.classList.add('is-up'); }
  else el.style.top = `${rect.bottom + 6}px`;

  anchor.setAttribute('aria-expanded', 'true');

  const focusables = () => [...list.querySelectorAll('.menu-item:not(:disabled)')];
  const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
  const onKey = (e) => {
    const f = focusables();
    const i = f.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const a = anchor; closeMenu(); a.focus?.(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); f[(i + 1) % f.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); f[(i - 1 + f.length) % f.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); f[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); f[f.length - 1]?.focus(); }
    else if (e.key === 'Tab') closeMenu();
  };
  const onScroll = (e) => { if (!el.contains(e.target)) closeMenu(); };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('blur', closeMenu);
  const off = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('blur', closeMenu);
  };
  menuState = { el, anchor, off };
  requestAnimationFrame(() => (list.querySelector('.is-selected:not(:disabled)') || focusables()[0])?.focus({ preventScroll: false }));
}

/** Custom replacement for <select>. options: [{value,label,hint,disabled}] */
export function Select({ options, value, onChange, label, cls = '' }) {
  const cur = options.find((o) => o.value === value) || options[0];
  const single = options.length <= 1;
  const btn = h('button', {
    class: `select ${cls}${single ? ' is-static' : ''}`, type: 'button', 'aria-label': label, 'aria-haspopup': 'listbox', 'aria-expanded': 'false', disabled: single,
  },
  h('span', { class: 'select-label' }, cur ? cur.label : '—'),
  cur && cur.hint ? h('span', { class: 'select-hint' }, cur.hint) : null,
  single ? null : icon('chevron', 14));
  btn.addEventListener('click', () => openMenu(btn, options.map((o) => ({
    label: o.label, hint: o.hint, disabled: o.disabled, selected: o.value === (cur && cur.value),
    onSelect: () => onChange(o.value),
  })), { matchWidth: false, width: Math.max(btn.offsetWidth, 230) }));
  return btn;
}

export function MenuButton({ label, items, align = 'right', iconName = 'more', cls = '' }) {
  const btn = h('button', { class: `icon-btn ${cls}`, type: 'button', 'aria-label': label, title: label, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon(iconName, 16));
  btn.addEventListener('click', () => openMenu(btn, typeof items === 'function' ? items() : items, { align, width: 220 }));
  return btn;
}

export function Switch({ checked, onChange, label }) {
  const b = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(!!checked), 'aria-label': label }, h('span', { class: 'switch-knob' }));
  b.addEventListener('click', () => {
    const next = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(next));
    onChange?.(next);
  });
  return b;
}

/* Sheets */
let sheetClose = null;
export function closeSheet(result) { if (sheetClose) sheetClose(result); }

export function openSheet({ title, body, actions = [] }) {
  closeMenu();
  closeSheet();
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const close = (r) => { sheetClose = null; backdrop.remove(); document.removeEventListener('keydown', onKey, true); prev?.focus?.(); resolve(r); };
    const bodyScroll = scrollArea(h('div', { class: 'sheet-body' }, body), 'sheet-scroll');
    const btns = actions.map((a) => h('button', {
      class: `btn ${a.primary ? 'primary' : 'ghost'}`, type: 'button', onclick: () => close(a.value),
    }, a.label));
    const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'sheet-head' }, h('h2', {}, title), iconButton('x', 'Close', () => close(undefined))),
      bodyScroll,
      btns.length ? h('div', { class: 'sheet-foot' }, btns) : null);
    const backdrop = h('div', { class: 'backdrop', onpointerdown: (e) => { if (e.target === backdrop) close(undefined); } }, sheet);
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(undefined); } };
    document.addEventListener('keydown', onKey, true);
    overlay().append(backdrop);
    sheetClose = close;
    requestAnimationFrame(() => (btns.find((b) => b.classList.contains('primary')) || btns[0] || sheet.querySelector('.icon-btn'))?.focus());
  });
}

export function confirmSheet({ title, message, confirmLabel = 'Confirm' }) {
  return openSheet({
    title, body: h('p', { class: 'sheet-text' }, message),
    actions: [{ label: 'Cancel', value: false }, { label: confirmLabel, value: true, primary: true }],
  }).then(Boolean);
}

let toastTimer = 0;
export function toast(message, action) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status' }, h('span', {}, message),
    action ? h('button', { class: 'toast-action', type: 'button', onclick: () => { t.remove(); action.onClick(); } }, action.label) : null);
  overlay().append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 4200);
}

/* ───────────── Thumbnails: first frame → poster → site icon → app icon ───────────── */

const frameQueue = [];
let frameActive = 0;
function pumpFrames() {
  while (frameActive < 2 && frameQueue.length) {
    const job = frameQueue.shift();
    frameActive++;
    job().catch(() => {}).finally(() => { frameActive--; pumpFrames(); });
  }
}
let playing = null;
export function stopAllPreviews() { if (playing) { playing.stop(); playing = null; } }

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const canHover = matchMedia('(hover: hover)').matches;

/**
 * item: {id, kind, type, posterUrl, manifestUrl, live, drm}
 * opts: {favicon, appIcon, frameUrl}
 */
export function createThumb(item, opts) {
  const el = h('div', { class: `thumb thumb-${item.kind}` });
  const ph = h('div', { class: 'thumb-ph' }, h('img', { class: 'thumb-appicon', src: opts.appIcon, alt: '' }), icon(item.kind === 'audio' ? 'audio' : item.kind === 'image' ? 'image' : 'video', 14));
  el.append(ph);
  let destroyed = false, preview = null, ready = false, io = null;

  /** Draw a media element into a small canvas: keeps only a tiny bitmap, frees decoders and big images. */
  const snapshot = (source, w, hgt, max = 480) => {
    const scale = Math.min(1, max / Math.max(w, 1));
    const c = h('canvas', { class: 'thumb-img thumb-snap' });
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(hgt * scale));
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    return c;
  };

  const showImage = (src, cls, downscale = true) => new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      if (destroyed) return resolve(false);
      let node = img;
      if (downscale && img.naturalWidth > 520) {
        try { node = snapshot(img, img.naturalWidth, img.naturalHeight, 520); } catch { node = img; }
      }
      node.classList.add('thumb-img');
      if (cls) node.classList.add(cls);
      el.append(node);
      el.classList.add('has-art');
      resolve(true);
    };
    img.onerror = () => resolve(false);
    img.src = src;
  });

  const fallbackChain = async () => {
    if (item.kind === 'image') {
      if (item.posterUrl && await showImage(item.posterUrl)) return;
      if (item.manifestUrl && await showImage(item.manifestUrl)) return;
      return;
    }
    if (item.posterUrl && await showImage(item.posterUrl)) return;
    if (opts.favicon) await showImage(opts.favicon, 'is-favicon', false);
  };

  /** Build a muted player for a URL. Always release it with destroy(). */
  const makePlayer = (url, type) => {
    const video = h('video', { class: 'thumb-video', playsinline: true, preload: 'auto' });
    video.muted = true;
    video.loop = true;
    let hls = null, dash = null;
    const p = {
      video,
      onFatal: null,
      startLoad: () => hls?.startLoad(),
      play: () => (dash ? Promise.resolve(dash.play()) : video.play()),
      stopLoad: () => hls?.stopLoad(),
      destroy() {
        try { hls?.destroy(); } catch { /* noop */ }
        try { dash?.reset(); } catch { /* noop */ }
        hls = null; dash = null;
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.remove();
      },
    };
    if (type === 'hls' && window.Hls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: false, startLevel: 0, maxBufferLength: 6, capLevelToPlayerSize: true });
      hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) p.onFatal?.(); });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (type === 'dash' && window.dashjs) {
      dash = dashjs.MediaPlayer().create();
      dash.initialize(video, url, false);
      dash.on('error', () => p.onFatal?.());
    } else if (type !== 'hls' && type !== 'dash') {
      video.src = url;
    } else {
      queueMicrotask(() => p.onFatal?.());
    }
    video.addEventListener('error', () => p.onFatal?.(), { once: true });
    return p;
  };

  /** Capture the first frame once, keep it as a small bitmap, then release the player completely. */
  const captureFrame = () => new Promise((resolve) => {
    const p = makePlayer(opts.frameUrl, item.type);
    const v = p.video;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let node = null;
      if (ok && !destroyed && v.videoWidth > 0) {
        try { node = snapshot(v, v.videoWidth, v.videoHeight, 480); } catch { node = null; }
      }
      p.destroy();
      if (node) {
        ready = true;
        el.append(node);
        el.classList.add('has-art', 'has-frame');
      }
      resolve(!!node);
    };
    const timer = setTimeout(() => finish(false), 14000);
    p.onFatal = () => finish(false);
    if (item.type === 'hls' || item.type === 'dash') {
      v.addEventListener('loadeddata', () => finish(true), { once: true });
    } else {
      v.addEventListener('loadedmetadata', () => { try { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); } catch { /* noop */ } }, { once: true });
      v.addEventListener('seeked', () => finish(true), { once: true });
      v.addEventListener('loadeddata', () => setTimeout(() => finish(v.readyState >= 2), 1500), { once: true });
    }
  });

  const frameCandidate = item.kind === 'video' && !item.drm && !item.live && !!opts.frameUrl;
  const begin = () => {
    if (destroyed) return;
    if (frameCandidate) {
      frameQueue.push(async () => {
        if (destroyed) return;
        if (!await captureFrame() && !destroyed) await fallbackChain();
      });
      pumpFrames();
    } else {
      fallbackChain();
    }
  };

  // Only do the work once the card is (nearly) on screen.
  io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    io = null;
    begin();
  }, { rootMargin: '240px' });
  io.observe(el);

  const api = {
    el,
    canPreview: () => ready && canHover && !reduceMotion,
    /** Hover preview: a short-lived player on top of the snapshot. */
    play() {
      if (!api.canPreview()) return;
      stopAllPreviews();
      playing = api;
      const p = makePlayer(opts.frameUrl, item.type);
      preview = p;
      p.onFatal = () => api.stop();
      p.video.addEventListener('playing', () => p.video.classList.add('is-on'), { once: true });
      el.append(p.video);
      p.play().catch(() => {});
    },
    stop() {
      if (preview) { preview.destroy(); preview = null; }
      if (playing === api) playing = null;
    },
    destroy() {
      destroyed = true;
      io?.disconnect();
      api.stop();
      el.remove();
    },
  };
  return api;
}
