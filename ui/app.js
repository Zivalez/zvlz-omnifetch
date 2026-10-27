import { fmtBytes, fmtBytesRange, fmtDuration, fmtDate } from '../engine/format.js';
import { reasonCopy, DRM_WHY } from '../engine/reasons.js';
import { previewName, tidyTitle, DEFAULT_TEMPLATE } from '../engine/naming.js';
import {
  h, icon, iconButton, scrollArea, openMenu, closeMenu, pruneMenu, Select, MenuButton, Switch,
  openSheet, closeSheet, confirmSheet, toast, createThumb, stopAllPreviews,
} from './components.js';

const demo = new URLSearchParams(location.search).has('preview');
const root = document.getElementById('app');
const APP_ICON = chrome.runtime?.getURL ? chrome.runtime.getURL('icons/icon48.png') : '../icons/icon48.png';
if (location.pathname.endsWith('popup.html')) document.body.classList.add('popup');
const isPopup = document.body.classList.contains('popup');
let winId = null;
chrome.windows?.getCurrent().then((w) => { winId = w.id; }).catch(() => {});

let state = { items: [], jobs: [], history: [], prefs: {} };
const S = { view: 'media', tab: 'video', search: '', sort: 'order', showUnavailable: false, choices: {}, paused: {} };
const thumbs = new Map();
let ui = {};
let lastSig = '';

const TABS = [['video', 'Video'], ['audio', 'Audio'], ['image', 'Images']];
const SORTS = [['order', 'Page order'], ['size', 'Largest first'], ['duration', 'Longest first'], ['new', 'Newest first']];
const PHASES = { manifest: 'Fetching playlist', checking: 'Verifying completeness', downloading: 'Downloading', assembling: 'Assembling and verifying', saving: 'Saving', done: 'Done' };

/* ───────────── messaging ───────────── */

async function send(t, extra = {}) {
  if (demo) { toast('Design preview. Install the extension to use this.'); return { ok: false }; }
  try {
    const r = await chrome.runtime.sendMessage({ t, ...extra });
    if (r?.state) state = r.state;
    if (r?.error) toast(r.error);
    return r || {};
  } catch {
    toast('Cannot reach the extension. Reload it and the source page.');
    return { ok: false };
  }
}

/* ───────────── helpers ───────────── */

const host = () => state.cache?.page?.host || state.tab?.host || '';
/** Favicon through Chrome's own cache (works offline-safe, never hits chrome:// URLs). */
function faviconUrl() {
  const u = state.cache?.page?.url || (host() ? `https://${host()}/` : '');
  if (!/^https?:/i.test(u) || !chrome.runtime?.getURL) return null;
  return `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(u)}&size=32`;
}
const chosen = (i) => i.variants?.find((v) => v.id === (S.choices[i.id] || i.defaultVariantId) && v.eligible) || i.variants?.find((v) => v.eligible) || i.variants?.[0];
const title = (i) => tidyTitle(i.title, host(), i.kind === 'image' ? 'Image' : i.kind === 'audio' ? 'Audio' : 'Video');
const normExt = (e) => { e = String(e || '').toLowerCase(); return e === 'jpeg' ? 'jpg' : e === 'img' || e === 'bin' || e === 'file' ? '' : e; };
/** Format of the file you will actually get. */
const outExt = (i) => normExt(chosen(i)?.ext || chosen(i)?.container).toUpperCase();
const isStream = (i) => i.type === 'hls' || i.type === 'dash';
const srcLabel = (i) => (i.live ? 'LIVE' : i.drm ? 'DRM' : '');
const typeLabel = (i) => srcLabel(i) || (i.status === 'READY' ? outExt(i) : '') || String(i.type || '').toUpperCase();
const formatLabel = (i) => {
  const out = i.status === 'READY' ? outExt(i) : '';
  const src = isStream(i) ? i.type.toUpperCase() : '';
  return src && out ? `${src} → ${out}` : out || src || '';
};
const variantLabel = (v) => (v?.label || 'Original').replace(/^gambar$/i, 'Image').replace(/audio saja/i, 'Audio only').replace(/^File media$/i, 'Media file');
const itemUrl = (i) => chosen(i)?.manifestUrl || i.manifestUrl;
const codecName = (c) => {
  if (!c) return '';
  if (/avc|h264/i.test(c)) return 'H.264';
  if (/hvc|hev|h265/i.test(c)) return 'H.265';
  if (/av01/i.test(c)) return 'AV1';
  if (/vp0?9/i.test(c)) return 'VP9';
  if (/mp4a|aac/i.test(c)) return 'AAC';
  if (/opus/i.test(c)) return 'Opus';
  if (/ec-3/i.test(c)) return 'E-AC-3';
  if (/ac-3/i.test(c)) return 'AC-3';
  return c;
};
function fileNameFor(i, v) {
  return previewName(state.prefs.template || DEFAULT_TEMPLATE, {
    title: i.title, host: host(), index: i.index,
    quality: v?.resolution ? `${v.resolution}p` : v?.audioOnly ? 'audio' : '',
    resolution: v?.resolution ? `${v.resolution}p` : '', lang: v?.audioLang,
  }, v?.ext || v?.container || 'mp4');
}
async function copy(text, done = 'Copied') {
  if (!text) { toast('Nothing to copy'); return; }
  toast((await copyText(text)) ? done : 'Could not copy');
}
const unavailableLine = (i) => reasonCopy(i.notReadyReason || 'checking').line;

/* ───────────── downloads ───────────── */

async function download(i, quiet = false) {
  const v = chosen(i);
  if (!v?.eligible) return;
  const r = await send('job:start', { itemId: i.id, variantId: v.id, mode: v.audioOnly ? 'audio' : 'video' });
  if (r.ok !== false && !quiet) toast('Added to downloads', { label: 'View', onClick: () => go('queue') });
  updateBadge();
}

async function downloadAll(list) {
  const bytes = list.reduce((n, i) => n + (chosen(i)?.sizeMax || 0), 0);
  const ok = await confirmSheet({
    title: `Download ${list.length} items?`,
    message: `${bytes ? `Estimated ${fmtBytes(bytes, true)}. ` : ''}They will run one after another in the queue.`,
    confirmLabel: 'Download all',
  });
  if (!ok) return;
  for (const i of list) await download(i, true);
  toast(`${list.length} items added`, { label: 'View', onClick: () => go('queue') });
}

async function zipImages(list) {
  const ok = await confirmSheet({ title: 'Download as ZIP?', message: `${list.length} images will be bundled into one file.`, confirmLabel: 'Download ZIP' });
  if (!ok) return;
  await send('images:download', { itemIds: list.map((i) => i.id), zipMode: 'zip' });
  toast('ZIP is being prepared');
}

/* ───────────── details sheet ───────────── */

function showDetails(i) {
  const v = chosen(i);
  const rows = [
    ['Title', title(i)],
    ['Site', host()],
    ['Source', i.type === 'progressive' ? 'Direct file' : i.type === 'image' ? 'Image' : String(i.type || '').toUpperCase()],
    ['Saved as', outExt(i)],
    ['Duration', fmtDuration(i.duration)],
    ['Quality', v ? variantLabel(v) : ''],
    ['Dimensions', v?.resolution ? `${v.resolution}p` : i.width ? `${i.width}×${i.height}` : ''],
    ['Video codec', codecName(v?.videoCodec)],
    ['Audio codec', codecName(v?.audioCodec)],
    ['Audio language', v?.audioLang || ''],
    ['Segments', i.segmentCount ? String(i.segmentCount) : ''],
    ['Estimated size', v?.sizeMax ? fmtBytesRange(v.sizeMin, v.sizeMax) : ''],
    ['File name', i.status === 'READY' && v ? fileNameFor(i, v) : ''],
  ].filter(([, val]) => val);
  const url = itemUrl(i) || '';
  const body = h('div', { class: 'details' },
    h('dl', {}, rows.map(([k, val]) => [h('dt', {}, k), h('dd', {}, val)])),
    url ? h('div', { class: 'url-box' }, h('span', { class: 'eyebrow' }, 'Source URL'), h('code', {}, url)) : null);
  openSheet({
    title: 'Details', body,
    actions: [{ label: 'Close', value: 'close' }, ...(url ? [{ label: 'Copy URL', value: 'copy', primary: true }] : [])],
  }).then((r) => { if (r === 'copy') copy(url, 'URL copied'); });
}

/* ───────────── cards ───────────── */

function getThumb(i) {
  let t = thumbs.get(i.id);
  if (!t) {
    const url = i.type === 'progressive' ? i.manifestUrl : i.manifestUrl || chosen(i)?.manifestUrl;
    t = createThumb(i, { favicon: faviconUrl(), appIcon: APP_ICON, frameUrl: i.kind === 'video' ? url : null });
    thumbs.set(i.id, t);
  }
  return t;
}

function thumbBox(i) {
  const t = getThumb(i);
  const box = h('div', { class: 'thumb-box', tabindex: i.kind === 'video' ? 0 : null, 'aria-label': i.kind === 'video' ? 'Hover to preview' : null }, t.el);
  const tag = typeLabel(i);
  if (tag && i.kind !== 'image') box.append(h('span', { class: `pill${i.live ? ' is-live' : ''}${i.drm ? ' is-drm' : ''}` }, i.drm ? icon('lock', 10) : null, tag));
  if (i.kind !== 'image' && i.duration && i.status === 'READY') box.append(h('span', { class: 'pill pill-dur' }, fmtDuration(i.duration)));
  if (i.kind === 'video') {
    let timer = 0;
    const start = () => { clearTimeout(timer); timer = setTimeout(() => t.play(), 350); };
    const stop = () => { clearTimeout(timer); t.stop(); };
    box.addEventListener('mouseenter', start);
    box.addEventListener('mouseleave', stop);
    box.addEventListener('focus', start);
    box.addEventListener('blur', stop);
  }
  return box;
}

function moreMenu(i) {
  return MenuButton({
    label: 'More actions',
    items: () => {
      const v = chosen(i);
      const sub = i.subtitles?.[0];
      return [
        { label: 'Copy URL', icon: 'copy', onSelect: () => copy(itemUrl(i), 'URL copied') },
        ...(i.status === 'READY' && v ? [{ label: 'Copy file name', icon: 'file', onSelect: () => copy(fileNameFor(i, v).replace(/\.[^.]+$/, ''), 'File name copied') }] : []),
        ...(sub ? [{ label: 'Download subtitles', icon: 'subtitle', onSelect: () => send('sub:download', { urls: sub.urls, fileName: `${title(i)}.vtt` }) }] : []),
        { divider: true },
        { label: 'Details', icon: 'info', onSelect: () => showDetails(i) },
      ];
    },
  });
}

function qualitySelect(i) {
  const vs = i.variants || [];
  const cur = chosen(i);
  return Select({
    label: 'Quality',
    value: cur?.id,
    options: vs.map((v) => ({
      value: v.id, label: variantLabel(v),
      hint: v.eligible ? (v.sizeMax ? fmtBytesRange(v.sizeMin, v.sizeMax) : '') : 'Unavailable', disabled: !v.eligible,
    })),
    onChange: (id) => { S.choices[i.id] = id; fillMedia(); },
  });
}

function actionFor(i) {
  const a = reasonCopy(i.notReadyReason).action;
  if (a === 'record' && !i.drm) return h('button', { class: 'btn', type: 'button', onclick: async () => { const ok = await confirmSheet({ title: 'Record this tab?', message: 'Recording captures the tab from now on. It is a partial, re-encoded copy, not the whole broadcast.', confirmLabel: 'Start recording' }); if (ok) { await send('rec:start', { fileName: `Recording ${Date.now()}.webm` }); go('queue'); } } }, icon('record', 14), 'Record');
  if (a === 'why-drm') return h('button', { class: 'btn', type: 'button', onclick: () => openSheet({ title: 'Why not?', body: h('p', { class: 'sheet-text' }, DRM_WHY), actions: [{ label: 'Close', value: 1, primary: true }] }) }, 'Why?');
  if (a) return h('button', { class: 'btn', type: 'button', onclick: async (e) => { e.currentTarget.disabled = true; await send('ui:rescan'); fillMedia(); } }, icon('refresh', 14), reasonCopy(i.notReadyReason).action === 'retry' ? 'Try again' : 'Scan again');
  return null;
}

function metaLine(i) {
  return [formatLabel(i), fmtDuration(i.duration)].filter(Boolean).join(' · ');
}

function mediaCard(i) {
  const ready = i.status === 'READY';
  const v = chosen(i);
  const isImg = i.kind === 'image';
  const info = h('div', { class: 'card-info' },
    h('h3', { class: 'card-title', title: title(i) }, title(i)),
    h('p', { class: 'card-meta' }, isImg ? [outExt(i), i.width ? `${i.width}×${i.height}` : ''].filter(Boolean).join(' · ') : metaLine(i)),
    !ready ? h('p', { class: 'card-reason' }, i.status === 'CHECKING' ? reasonCopy('checking').line : unavailableLine(i)) : null);

  const row = h('div', { class: 'card-actions' });
  if (ready) {
    if (!isImg) row.append(qualitySelect(i));
    else row.append(h('span', { class: 'size-chip' }, v?.sizeMax ? fmtBytesRange(v.sizeMin, v.sizeMax) : ''));
    row.append(h('button', { class: 'btn primary', type: 'button', onclick: () => download(i) }, icon('download', 14), 'Download'), moreMenu(i));
  } else {
    const a = i.status === 'CHECKING' ? null : actionFor(i);
    row.append(a || h('span', { class: 'spacer' }), h('span', { class: 'spacer' }), moreMenu(i));
  }
  return h('article', { class: `card card-${i.kind}${ready ? '' : ' is-dim'}`, 'data-id': i.id }, thumbBox(i), info, row);
}

/* ───────────── media view ───────────── */

function matches(i) {
  const q = S.search.trim().toLowerCase();
  return i.kind === S.tab && (!q || title(i).toLowerCase().includes(q) || String(i.title).toLowerCase().includes(q));
}

function sorted(list) {
  const l = [...list];
  if (S.sort === 'size') l.sort((a, b) => (chosen(b)?.sizeMax || 0) - (chosen(a)?.sizeMax || 0));
  if (S.sort === 'duration') l.sort((a, b) => (b.duration || 0) - (a.duration || 0));
  if (S.sort === 'new') l.reverse();
  return l;
}

function emptyState(iconName, heading, text) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon(iconName, 22)), h('strong', {}, heading), text ? h('p', {}, text) : null);
}

const cardCache = new Map();

function cardFor(i) {
  const sig = JSON.stringify([i.status, i.notReadyReason, i.title, i.duration, i.variants, i.live, i.drm, i.posterUrl, i.width, i.height, i.segmentCount, S.choices[i.id], i.subtitles?.length]);
  const hit = cardCache.get(i.id);
  if (hit && hit.sig === sig) return hit.el;
  const el = mediaCard(i);
  cardCache.set(i.id, { sig, el });
  return el;
}

/** Make parent's children equal `els` without touching nodes that are already in the right place. */
function syncChildren(parent, els) {
  let ref = parent.firstChild;
  for (const el of els) {
    if (el === ref) ref = ref.nextSibling;
    else parent.insertBefore(el, ref);
  }
  while (ref) { const n = ref.nextSibling; ref.remove(); ref = n; }
}

function fillMedia(user = true) {
  if (user) { closeMenu(); stopAllPreviews(); }
  const inKind = state.items.filter((i) => i.kind === S.tab);
  const list = sorted(state.items.filter(matches));
  const ready = list.filter((i) => i.status === 'READY' || i.status === 'CHECKING');
  const down = list.filter((i) => i.status !== 'READY' && i.status !== 'CHECKING');
  const readyOnly = ready.filter((i) => i.status === 'READY');
  const noun = { video: 'videos', audio: 'audio', image: 'images' }[S.tab];

  if (!ui.sk) {
    const groupHead = h('button', { class: 'group-head', type: 'button', onclick: () => { S.showUnavailable = !S.showUnavailable; fillMedia(); } },
      h('span', { class: 'chev' }, icon('chevronRight', 14)), 'Unavailable', h('span', { class: 'count' }));
    ui.sk = {
      bulk: h('div', { class: 'bulk' }), list: h('div', { class: 'stack' }), groupHead,
      groupBody: h('div', { class: 'stack' }), group: h('section', { class: 'group' }), empty: h('div'),
    };
    ui.sk.group.append(groupHead, ui.sk.groupBody);
    ui.content.replaceChildren(ui.sk.bulk, ui.sk.list, ui.sk.group, ui.sk.empty);
  }
  const sk = ui.sk;

  const bulk = [];
  if (readyOnly.length > 1) bulk.push(h('button', { class: 'btn small', type: 'button', onclick: () => downloadAll(readyOnly) }, icon('download', 13), `Download all (${readyOnly.length})`));
  if (S.tab === 'image' && readyOnly.length > 1) bulk.push(h('button', { class: 'btn small ghost', type: 'button', onclick: () => zipImages(readyOnly) }, 'As ZIP'));
  sk.bulk.replaceChildren(...bulk);
  sk.bulk.hidden = !bulk.length;

  sk.list.className = S.tab === 'image' ? 'grid' : 'stack';
  syncChildren(sk.list, ready.map(cardFor));

  sk.group.hidden = !down.length;
  sk.groupHead.querySelector('.count').textContent = String(down.length);
  sk.groupHead.setAttribute('aria-expanded', String(S.showUnavailable));
  sk.groupHead.querySelector('.chev').classList.toggle('rot', S.showUnavailable);
  sk.groupBody.hidden = !S.showUnavailable;
  if (S.showUnavailable) syncChildren(sk.groupBody, down.map(cardFor));

  let empty = null;
  if (!ready.length && !down.length) {
    if (state.canInject === false) empty = emptyState('lock', 'This page can’t be scanned', 'Open a regular web page to find media.');
    else if (S.search && inKind.length) empty = emptyState('search', 'No matches', 'Try a different search.');
    else if (state.analyzing) empty = emptyState('refresh', 'Scanning…', 'Checking what this page is playing.');
    else empty = emptyState({ video: 'video', audio: 'audio', image: 'image' }[S.tab], `No ${noun} found`, S.tab === 'image' ? 'Images on this page show up here.' : `Play ${S.tab === 'audio' ? 'some audio' : 'a video'} on this page and it appears here.`);
  }
  sk.empty.replaceChildren(...(empty ? [empty] : []));

  ui.scroll?.refresh();
  const alive = new Set(state.items.map((i) => i.id));
  for (const [id, t] of thumbs) if (!alive.has(id)) { t.destroy(); thumbs.delete(id); }
  for (const id of cardCache.keys()) if (!alive.has(id)) cardCache.delete(id);
  if (!user) pruneMenu();
  updateTabs();
}

function updateTabs() {
  if (!ui.tabs) return;
  ui.tabs.querySelectorAll('button').forEach((b) => {
    const k = b.dataset.tab;
    const n = state.items.filter((i) => i.kind === k && i.status === 'READY').length;
    b.querySelector('.tab-count').textContent = n || '';
    b.setAttribute('aria-selected', String(k === S.tab));
  });
}

function updateBadge() {
  const n = (state.jobs?.length || 0) + Object.keys(state.recStates || {}).length;
  if (!ui.badge) return;
  ui.badge.textContent = n > 9 ? '9+' : String(n);
  ui.badge.hidden = !n;
}

/* ───────────── shell ───────────── */

function siteTile() {
  const fav = faviconUrl();
  const tile = h('div', { class: 'site-tile' }, h('img', { src: APP_ICON, alt: '' }));
  if (fav) {
    const img = h('img', { class: 'site-fav', src: fav, alt: '', referrerpolicy: 'no-referrer' });
    img.onload = () => tile.replaceChildren(img);
    img.onerror = () => {};
  }
  return tile;
}

function mediaHeader() {
  const page = state.cache?.page || state.tab || {};
  ui.badge = h('span', { class: 'badge', hidden: true });
  return h('header', { class: 'top' },
    h('div', { class: 'site' }, siteTile(),
      h('div', { class: 'site-text' }, h('div', { class: 'site-title', title: page.title || '' }, tidyTitle(page.title, page.host, 'No active page')), h('div', { class: 'site-host' }, page.host || state.tab?.host || ''))),
    h('div', { class: 'top-actions' },
      h('span', { class: 'with-badge' }, iconButton('queue', 'Downloads', () => go('queue')), ui.badge),
      iconButton('history', 'History', () => go('history')),
      iconButton('settings', 'Settings', () => go('settings')),
      isPopup ? iconButton('panel', 'Open side panel', () => { chrome.sidePanel.open({ windowId: winId }).then(() => window.close()).catch((e) => toast(`Could not open the side panel: ${e.message || e}`)); }) : null));
}

function mediaChrome() {
  ui.tabs = h('nav', { class: 'tabs', role: 'tablist' }, TABS.map(([k, label]) =>
    h('button', { class: 'tab', type: 'button', role: 'tab', 'data-tab': k, 'aria-selected': String(k === S.tab), onclick: () => { S.tab = k; fillMedia(); } }, label, h('span', { class: 'tab-count' }))));

  const input = h('input', { class: 'search-input', type: 'search', placeholder: 'Search', 'aria-label': 'Search', value: S.search, autocomplete: 'off', spellcheck: 'false' });
  const clear = h('button', { class: 'search-clear', type: 'button', 'aria-label': 'Clear search', hidden: !S.search, onclick: () => { input.value = ''; S.search = ''; clear.hidden = true; fillMedia(); input.focus(); } }, icon('x', 12));
  input.addEventListener('input', () => { S.search = input.value; clear.hidden = !S.search; fillMedia(); });
  const sortBtn = h('button', { class: 'select compact', type: 'button', 'aria-label': 'Sort', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, h('span', { class: 'select-label' }, SORTS.find(([k]) => k === S.sort)[1]), icon('chevron', 14));
  sortBtn.addEventListener('click', () => openMenu(sortBtn, SORTS.map(([k, label]) => ({ label, selected: k === S.sort, onSelect: () => { S.sort = k; sortBtn.querySelector('.select-label').textContent = label; fillMedia(); } })), { width: 190, align: 'right' }));
  const toolbar = h('div', { class: 'toolbar' },
    h('label', { class: 'search' }, icon('search', 14), input, clear),
    sortBtn,
    iconButton('refresh', 'Scan again', async (e) => { const b = e.currentTarget; b.classList.add('is-spinning'); await send('ui:rescan'); b.classList.remove('is-spinning'); fillMedia(); }));

  ui.content = h('div', { class: 'content' });
  ui.scroll = scrollArea(ui.content, 'main-scroll');
  return [ui.tabs, toolbar, ui.scroll];
}

function subHeader(text, extra) {
  return h('header', { class: 'top sub' }, iconButton('back', 'Back', () => go('media')), h('h1', {}, text), h('div', { class: 'top-actions' }, extra));
}

/* ───────────── queue ───────────── */

function jobCard(j) {
  const pct = j.phase === 'done' ? 100 : Math.min(97, Math.round(((j.segIndex || 0) / Math.max(j.segCount || 1, 1)) * 100));
  const failed = j.status === 'failed';
  const paused = !!S.paused[j.id];
  const ctl = (action) => async () => {
    if (action === 'pause' || action === 'resume') S.paused[j.id] = action === 'pause';
    await send('job:control', { jobId: j.id, action });
    renderQueue();
  };
  return h('article', { class: 'card job' },
    h('h3', { class: 'card-title', title: j.fileName }, tidyTitle(j.fileName, '', 'Download')),
    h('p', { class: 'card-meta' }, failed ? 'Failed' : paused ? 'Paused' : PHASES[j.phase] || j.phase),
    h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct }, h('i', { style: `width:${pct}%` })),
    h('div', { class: 'stats' }, h('span', {}, `${j.segIndex || 0} / ${j.segCount || 1} segments`), h('span', {}, `${fmtBytes(j.bytes || 0)} / ${fmtBytes(j.totalBytes, true)}`)),
    j.reason ? h('p', { class: 'card-reason' }, reasonCopy(j.reason).line) : null,
    h('div', { class: 'job-actions' },
      failed ? h('button', { class: 'btn small', type: 'button', onclick: ctl('cancel') }, icon('trash', 13), 'Remove')
        : [h('button', { class: 'btn small', type: 'button', onclick: ctl(paused ? 'resume' : 'pause') }, icon(paused ? 'play' : 'pause', 13), paused ? 'Resume' : 'Pause'),
          h('button', { class: 'btn small ghost', type: 'button', onclick: ctl('cancel') }, 'Cancel')]));
}

function recCard(id) {
  const r = state.recStates[id];
  return h('article', { class: 'card job' },
    h('h3', { class: 'card-title' }, 'Recording this tab'),
    h('p', { class: 'card-meta' }, `Partial capture · ${fmtDuration(r.seconds) || '0:00'} · ${fmtBytes(r.bytes)}`),
    h('div', { class: 'job-actions' }, h('button', { class: 'btn primary small', type: 'button', onclick: async () => { await send('rec:stop', { jobId: id }); renderQueue(); } }, 'Stop & save')));
}

function renderQueue() {
  const recs = Object.keys(state.recStates || {});
  const nodes = [...(state.jobs || []).map(jobCard), ...recs.map(recCard)];
  ui.content.replaceChildren(nodes.length ? h('div', { class: 'stack' }, nodes) : emptyState('queue', 'No active downloads', 'Downloads you start will appear here.'));
  ui.scroll.refresh();
}

/* ───────────── history ───────────── */

/** Find the browser download behind a history entry (by id, else by file name). */
async function findDownload(x) {
  try {
    if (x.downloadId != null) {
      const [d] = await chrome.downloads.search({ id: x.downloadId });
      if (d) return d;
    }
    const esc = String(x.fileName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const [d] = await chrome.downloads.search({ filenameRegex: `${esc}$`, orderBy: ['-startTime'], limit: 1 });
    return d || null;
  } catch { return null; }
}

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|bmp|svg|heic|heif)$/i;

function historyRow(x) {
  const saved = x.status === 'saved';
  const isImage = IMAGE_EXT_RE.test(x.fileName || '');
  const meta = h('p', { class: 'card-meta' }, [x.host || 'Local', x.size ? fmtBytes(x.size) : '', fmtDate(x.date)].filter(Boolean).join(' · '));
  const open = h('button', { class: 'btn small', type: 'button', disabled: true, onclick: async () => {
    const d = await findDownload(x);
    if (!d || !d.exists) { toast('The file is no longer on disk'); return; }
    chrome.downloads.open(d.id);
  } }, icon(isImage ? 'image' : 'play', 13), isImage ? 'Open' : 'Play');
  const folder = h('button', { class: 'btn small', type: 'button', disabled: true, onclick: async () => {
    const d = await findDownload(x);
    if (!d) { toast('This download is no longer in the browser history'); return; }
    chrome.downloads.show(d.id);
  } }, icon('folder', 13), 'Show in folder');

  if (saved) {
    findDownload(x).then((d) => {
      const ok = !!(d && d.exists);
      open.disabled = !ok;
      folder.disabled = !d;
      if (!ok) meta.textContent += ' · File removed';
    });
  }
  return h('article', { class: 'card hist' },
    h('div', { class: 'hist-top' },
      h('div', { class: 'hist-main' }, h('h3', { class: 'card-title', title: x.fileName }, tidyTitle(x.fileName, x.host, 'Download')), meta),
      h('span', { class: `status ${saved ? 'ok' : 'bad'}` }, saved ? 'Saved' : 'Failed')),
    saved ? h('div', { class: 'hist-actions' }, open, folder) : null);
}

function renderHistory() {
  const rows = (state.history || []).map(historyRow);
  ui.content.replaceChildren(rows.length ? h('div', { class: 'stack' }, rows) : emptyState('history', 'No history yet', 'Files you download are listed here, with shortcuts to play them or open their folder.'));
  ui.scroll.refresh();
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try {
    const ta = h('textarea', { style: 'position:fixed;opacity:0;pointer-events:none' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}


const REPO_URL = 'https://github.com/Zivalez/zvlz-omnifetch';
const extVersion = () => { try { return chrome.runtime?.getManifest?.()?.version || ''; } catch { return ''; } };
const openRepo = (path = '') => {
  const url = `${REPO_URL}${path}`;
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) { chrome.tabs.create({ url }); return; }
  } catch { /* fall through to window.open */ }
  window.open(url, '_blank');
};

/* ───────────── settings ───────────── */

function renderSettings() {
  const prefs = { ...state.prefs };
  const tpl = h('input', { class: 'input mono', value: prefs.template || DEFAULT_TEMPLATE, spellcheck: 'false', 'aria-label': 'File name template' });
  const lang = h('input', { class: 'input', value: prefs.audioLang || '', placeholder: 'e.g. en, id', 'aria-label': 'Preferred audio language' });
  const prev = h('p', { class: 'preview' });
  const sample = state.items.find((i) => i.status === 'READY' && i.kind !== 'image') || { title: 'Sample video title', index: 1 };
  const updatePrev = () => { prev.textContent = previewName(tpl.value || DEFAULT_TEMPLATE, { title: sample.title, host: host() || 'example.com', index: sample.index || 1, quality: '1080p', resolution: '1080p', lang: 'en' }, 'mp4'); };
  tpl.addEventListener('input', updatePrev);
  updatePrev();
  const tokens = ['title', 'quality', 'resolution', 'lang', 'host', 'date', 'index'].map((t) => h('button', { class: 'chip', type: 'button', onclick: () => { tpl.value += `{${t}}`; updatePrev(); tpl.focus(); } }, `{${t}}`));
  let showAll = !!prefs.showAllImages;

  const field = (label, ...kids) => h('div', { class: 'field' }, h('label', { class: 'field-label' }, label), ...kids);
  // The version is its own footer, pinned to the bottom of the extension
  // window, not merged with any other text or button.
  const footer = h('div', { class: 'settings-footer' },
    h('p', { class: 'version' }, `ZVLZ OmniFetch ${extVersion()}`));
  ui.content.replaceChildren(h('div', { class: 'settings' },
    field('File name', tpl, h('div', { class: 'chips' }, tokens), h('div', { class: 'preview-wrap' }, h('span', { class: 'eyebrow' }, 'Preview'), prev)),
    field('Preferred audio language', lang),
    h('div', { class: 'field row' }, h('div', {}, h('div', { class: 'field-label' }, 'Show small images'), h('p', { class: 'hint' }, 'Include icons and tiny pictures in the Images tab.')), Switch({ checked: showAll, label: 'Show small images', onChange: (v) => (showAll = v) })),
    h('div', { class: 'settings-actions' },
      h('button', { class: 'btn primary', type: 'button', onclick: async () => { await send('prefs:set', { patch: { template: tpl.value, audioLang: lang.value, showAllImages: showAll } }); toast('Settings saved'); } }, 'Save'),
      h('button', { class: 'btn ghost', type: 'button', onclick: async () => { const r = await send('staging:clear'); if (r.ok !== false) toast('Temporary files cleared'); } }, 'Clear temporary files')),
    field('Support the developer',
      h('div', { class: 'settings-actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => openRepo('') }, icon('github', 14), icon('star', 14), 'Star on GitHub'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => openRepo('/issues') }, icon('github', 14), 'Report an issue')))));
  root.append(footer);
  ui.scroll.refresh();
}

/* ───────────── routing & render ───────────── */

function go(view) {
  S.view = view;
  render();
}

function render() {
  closeMenu();
  closeSheet();
  stopAllPreviews();
  ui = {};
  if (S.view === 'media') {
    root.replaceChildren(mediaHeader(), ...mediaChrome());
    fillMedia();
    updateBadge();
    return;
  }
  const titles = { queue: 'Downloads', history: 'History', settings: 'Settings' };
  const extra = S.view === 'history' && state.history?.length
    ? h('button', { class: 'btn small ghost', type: 'button', onclick: async () => { await send('history:clear'); renderHistory(); } }, 'Clear')
    : null;
  ui.content = h('div', { class: 'content' });
  ui.scroll = scrollArea(ui.content, 'main-scroll');
  root.replaceChildren(subHeader(titles[S.view], extra), ui.scroll);
  ({ queue: renderQueue, history: renderHistory, settings: renderSettings })[S.view]();
}

function onState() {
  const sig = S.view === 'media' ? JSON.stringify([state.items, state.analyzing, state.canInject, state.prefs.showAllImages])
    : S.view === 'queue' ? JSON.stringify([state.jobs, state.recStates])
      : S.view === 'history' ? JSON.stringify(state.history) : '';
  updateBadge();
  if (sig === lastSig) return;
  lastSig = sig;
  if (S.view === 'media') fillMedia(false);
  else if (S.view === 'queue') renderQueue();
  else if (S.view === 'history') renderHistory();
}

window.addEventListener('pagehide', stopAllPreviews);
document.addEventListener('visibilitychange', () => document.hidden && stopAllPreviews());

/* ───────────── design preview data ───────────── */

function demoData() {
  state = {
    ...state, canInject: true, tab: { title: 'Distributed Systems: Lecture 1', host: 'lectures.example.edu' },
    prefs: { template: DEFAULT_TEMPLATE },
    items: [
      { id: 'a', kind: 'video', type: 'hls', title: 'distributed_systems_lecture_01-intro', duration: 2520, segmentCount: 312, status: 'READY', defaultVariantId: 'v1', variants: [{ id: 'v1', label: '1080p · H.264 + AAC', resolution: 1080, sizeMin: 1.2e9, sizeMax: 1.28e9, container: 'mp4', eligible: true, audioLang: 'en' }, { id: 'v2', label: '720p · H.264 + AAC', resolution: 720, sizeMax: 6.4e8, container: 'mp4', eligible: true }, { id: 'v3', label: 'Audio only', audioOnly: true, sizeMax: 3.8e7, container: 'm4a', eligible: true }] },
      { id: 'b', kind: 'video', type: 'progressive', title: 'Product%20demo%20-%20Architecture%20in%20practice.mp4', duration: 72, status: 'READY', variants: [{ id: 'v4', label: '720p', resolution: 720, sizeMax: 1.84e7, container: 'mp4', eligible: true }] },
      { id: 'c', kind: 'video', type: 'hls', title: 'Live: Product Launch', status: 'NOT_READY', live: true, notReadyReason: 'live_stream', variants: [] },
      { id: 'd', kind: 'video', type: 'dash', title: 'Subscription player', status: 'NOT_READY', drm: true, notReadyReason: 'drm_protected', variants: [] },
      { id: 'e', kind: 'audio', type: 'progressive', title: 'podcast_episode_42', duration: 1860, status: 'READY', variants: [{ id: 'v5', label: 'MP3', sizeMax: 2.9e7, container: 'mp3', eligible: true }] },
    ],
  };
}

if (demo) { demoData(); render(); }
else {
  await send('ui:hello');
  render();
  chrome.runtime.onMessage.addListener((m) => { if (m.t === 'state:changed') send('ui:state').then(onState); });
  chrome.storage.onChanged.addListener((c, a) => {
    if (a === 'session' && (c.jobs || Object.keys(c).some((k) => k.startsWith('recstate:')))) send('ui:state').then(onState);
  });
}
