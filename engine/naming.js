/* Smart file-name template, sanitizing, and tidy titles. */

export const DEFAULT_TEMPLATE = '{title} · {quality} [{lang}]';

const ILLEGAL = /[\\/:*?"<>|\x00-\x1f]/g;
const FILE_EXT = /\.(mp4|m4v|webm|mov|mkv|m3u8|mpd|mp3|m4a|aac|ogg|opus|flac|wav|jpe?g|png|gif|webp|avif|bmp|svg|ts)$/i;

export function sanitizeFilename(name) {
  let s = String(name ?? '')
    .replace(/\.\.\//g, '')
    .replace(ILLEGAL, '')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^[.\s]+/, '');
  if (!s) s = 'media';
  return s;
}

function titleCase(s) {
  return s.replace(/\b([a-z])([a-z']*)/gi, (_, a, b) => a.toUpperCase() + b.toLowerCase());
}

/**
 * Turn raw page titles / file names into something readable:
 * decode %20, drop extensions, "_" and "-" separators, hash-like tokens, " - SiteName" suffixes.
 */
export function tidyTitle(raw, host = '', fallback = 'Untitled') {
  let s = String(raw ?? '');
  try { s = decodeURIComponent(s); } catch { /* keep */ }
  s = s.replace(FILE_EXT, '');
  if (!/\s/.test(s)) s = s.replace(/[_.+]+/g, ' ').replace(/-+/g, ' ');
  else s = s.replace(/_+/g, ' ');
  // strip hash / id like tokens
  s = s.replace(/\b[0-9a-f]{12,}\b/gi, ' ').replace(/\b\d{9,}\b/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  // drop "Title - SiteName" suffix
  const stem = String(host || '').replace(/^www\./, '').split('.')[0].toLowerCase();
  if (stem.length > 2) {
    const parts = s.split(/\s+[-–—|·»]\s+/);
    if (parts.length > 1 && parts[parts.length - 1].length <= 24 && parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '').includes(stem)) {
      parts.pop();
      s = parts.join(' - ');
    }
  }
  s = s.replace(/^[\s\-–—|·:,.]+|[\s\-–—|·:,]+$/g, '');
  if (s.length > 3 && (s === s.toLowerCase() || s === s.toUpperCase())) s = titleCase(s);
  if (s.length > 110) s = s.slice(0, 107).trimEnd() + '…';
  return s || fallback;
}

export function applyTemplate(template, ctx) {
  const date = new Date(ctx.date || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const tokens = {
    title: sanitizeFilename(tidyTitle(ctx.title || 'media', ctx.host, 'Media')),
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    resolution: ctx.resolution || '',
    host: ctx.host || '',
    index: ctx.index != null ? String(ctx.index).padStart(2, '0') : '',
    quality: ctx.quality || '',
    lang: ctx.lang || '',
  };
  let out = String(template || DEFAULT_TEMPLATE).replace(/\{(\w+)\}/g, (m, k) => (k in tokens ? tokens[k] : m));
  out = out.replace(/\s*\[\s*\]\s*/g, ' ').replace(/\s*·\s*·\s*/g, ' · ').replace(/\s+·\s*$/g, '').replace(/^\s*·\s*/g, '');
  return sanitizeFilename(out.trim());
}

export function previewName(template, ctx, ext) {
  const base = applyTemplate(template, ctx).slice(0, 180);
  return `${base}.${ext}`;
}
