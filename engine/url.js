/* Util URL: resolve, kanonisasi, redaksi. Dipakai engine, offscreen, UI, dan test Node. */

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'dclid', 'msclkid', 'igshid', 'ref', 'referrer',
]);

export function parseUrl(u) {
  try { return new URL(u); } catch { return null; }
}

export function resolveUrl(base, ref) {
  if (!ref) return null;
  try { return new URL(ref, base).href; } catch { return null; }
}

export function hostOf(u) {
  const p = parseUrl(u);
  return p ? p.hostname : '';
}

export function originOf(u) {
  const p = parseUrl(u);
  return p ? p.origin : '';
}

/** URL tanpa query/fragment: untuk log & error (token tidak pernah bocor). */
export function redactUrl(u) {
  const p = parseUrl(u);
  if (!p) return String(u).slice(0, 120);
  return `${p.origin}${p.pathname}`;
}

/**
 * Kanonisasi untuk pengelompokan (dedup). Hanya membuang parameter pelacak
 * yang sudah pasti aman. Parameter auth/token TIDAK pernah dibuang.
 */
export function canonKey(u) {
  const p = parseUrl(u);
  if (!p) return String(u);
  const keep = [...p.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const q = keep.length ? `?${keep.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
  return `${p.origin}${p.pathname}${q}`;
}

const MEDIA_EXT = /\.(m3u8|mpd|m4s|ts|mp4|m4v|m4a|mov|webm|mkv|mp3|aac|ogg|oga|opus|flac|wav|jpg|jpeg|png|gif|webp|avif|bmp|svg)(?=$|[?#])/i;

export function isMediaUrl(u) {
  const p = parseUrl(u);
  if (!p) return false;
  if (MEDIA_EXT.test(p.pathname)) return true;
  return false;
}

export function extFromUrl(u) {
  const p = parseUrl(u);
  if (!p) return '';
  const m = /\.([a-z0-9]{2,5})$/i.exec(p.pathname);
  return m ? m[1].toLowerCase() : '';
}

export function manifestKind(u, contentType = '') {
  const ct = String(contentType).toLowerCase();
  if (ct.includes('mpegurl') || ct.includes('x-mpegurl')) return 'hls';
  if (ct.includes('dash+xml')) return 'dash';
  const ext = extFromUrl(u);
  if (ext === 'm3u8') return 'hls';
  if (ext === 'mpd') return 'dash';
  return null;
}

/** Query string manifest hanya diteruskan bila segmen relatif tidak punya query sendiri. */
export function propagateQuery(manifestUrl, segUrl) {
  const m = parseUrl(manifestUrl), s = parseUrl(segUrl);
  if (!m || !s || s.search) return segUrl;
  if (!m.search) return segUrl;
  const keep = [...m.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()));
  if (!keep.length) return segUrl;
  for (const [k, v] of keep) s.searchParams.set(k, v);
  return s.href;
}
