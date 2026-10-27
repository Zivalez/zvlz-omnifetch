/*
 * Lapis 1: penyadapan request jaringan (observasi saja, MV3).
 * Handler hanya menguji pola lalu mendorong ke antrean; agregasi di-debounce.
 * Event dari tab non-aktif dan tabId -1 langsung dibuang.
 */
import { isActiveTab } from './active-tab.js';

const EXT_PATTERN = /\.(m3u8|mpd|m4s|mp4|m4v|m4a|mov|webm|mkv|mp3|aac|opus|oga|ogg|flac|wav|jpe?g|png|gif|webp|avif|bmp)(?=$|[?#])/i;
const MANIFEST_CT = /(mpegurl|x-mpegurl|dash\+xml)/i;
const MEDIA_CT = /^(video|audio)\//i;
const IMAGE_CT = /^image\//i;

export function installWebRequest(onCandidates) {
  const queue = new Map(); // tabId -> Map url -> candidate
  let timer = null;

  const push = (tabId, url, kind, extra = {}) => {
    if (tabId == null || tabId === -1) return;
    if (!isActiveTab(tabId)) return; // aturan cakupan: hanya tab aktif
    if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('chrome')) return;
    if (!queue.has(tabId)) queue.set(tabId, new Map());
    const m = queue.get(tabId);
    if (!m.has(url)) m.set(url, { url, kind, ts: Date.now(), ...extra });
    if (!timer) {
      timer = setTimeout(flush, 400);
    }
  };

  const flush = () => {
    timer = null;
    for (const [tabId, m] of queue) {
      if (!isActiveTab(tabId) || m.size === 0) continue;
      const list = [...m.values()];
      m.clear();
      onCandidates(tabId, list);
    }
  };

  chrome.webRequest.onBeforeRequest.addListener(
    (d) => {
      if (EXT_PATTERN.test(d.url)) push(d.tabId, d.url, 'url');
    },
    { urls: ['<all_urls>'] },
  );

  chrome.webRequest.onHeadersReceived.addListener(
    (d) => {
      const ct = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type')?.value || '';
      const len = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-length')?.value;
      if (MANIFEST_CT.test(ct)) push(d.tabId, d.url, 'manifest', { contentType: ct, contentLength: len ? Number(len) : null });
      else if (MEDIA_CT.test(ct) || IMAGE_CT.test(ct)) push(d.tabId, d.url, 'url', { contentType: ct, contentLength: len ? Number(len) : null });
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders'],
  );
}
