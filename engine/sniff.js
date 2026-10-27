/* Sniff byte ajaib. Tidak percaya ekstensi URL atau Content-Type saja. */

const eq = (b, at, arr) => arr.every((v, i) => b[at + i] === v);

export function sniff(u8) {
  if (!u8 || u8.length < 4) return { kind: 'unknown', ext: 'bin' };
  if (eq(u8, 4, [0x66,0x74,0x79,0x70,0x61,0x76,0x69,0x66])) return {kind:'avif',ext:'avif'};
  if (u8.length >= 12 && eq(u8, 4, [0x66, 0x74, 0x79, 0x70])) return { kind: 'mp4', ext: 'mp4' };
  if (eq(u8, 0, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: 'webm', ext: 'webm' };
  if (u8[0] === 0x47 && (u8.length < 188 || u8[188] === 0x47)) return { kind: 'ts', ext: 'ts' };
  if (eq(u8, 0, [0xff, 0xd8])) return { kind: 'jpeg', ext: 'jpg' };
  if (eq(u8, 0, [0x89, 0x50, 0x4e, 0x47])) return { kind: 'png', ext: 'png' };
  if (eq(u8, 0, [0x47, 0x49, 0x46, 0x38])) return { kind: 'gif', ext: 'gif' };
  if (eq(u8, 0, [0x52, 0x49, 0x46, 0x46]) && u8.length >= 12 && eq(u8, 8, [0x57, 0x45, 0x42, 0x50])) return { kind: 'webp', ext: 'webp' };
  if (eq(u8, 4, [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])) return { kind: 'avif', ext: 'avif' };
  if ((u8[0] === 0xff && (u8[1] & 0xf6) === 0xf0) || eq(u8, 0, [0x49, 0x44, 0x33])) return { kind: 'mp3', ext: 'mp3' };
  if (u8[0] === 0xff && (u8[1] & 0xf0) === 0xf0 && u8.length > 2) return { kind: 'adts', ext: 'aac' };
  if (eq(u8, 0, [0x4f, 0x67, 0x67, 0x53])) return { kind: 'ogg', ext: 'ogg' };
  if (eq(u8, 0, [0x66, 0x4c, 0x61, 0x43])) return { kind: 'flac', ext: 'flac' };
  const head = String.fromCharCode(...u8.slice(0, 64));
  if (/^\s*</.test(head) && /<html|<!doctype/i.test(head)) return { kind: 'html', ext: 'html' };
  if (/^\s*[\[{]/.test(head) && /json/i.test(head.slice(0, 40))) return { kind: 'json', ext: 'json' };
  if (/^WEBVTT/.test(head)) return { kind: 'vtt', ext: 'vtt' };
  return { kind: 'unknown', ext: 'bin' };
}

/** Kontainer yang sah untuk disimpan; menolak halaman login / error JSON yang balas 200. */
export function sniffIsPlayableOrImage(u8) {
  const k = sniff(u8).kind;
  return !['html', 'json'].includes(k);
}

/* ---------- real format detection (bytes first, then Content-Type, then URL) ---------- */
const CT_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/heic': 'heic', 'image/heif': 'heif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/ogg': 'ogv',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/aac': 'aac',
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac',
};

export function normalizeExt(e) {
  e = String(e || '').toLowerCase().replace(/^\./, '');
  if (e === 'jpeg' || e === 'jpe') return 'jpg';
  if (e === 'img' || e === 'bin' || e === 'file') return '';
  return e;
}

export function detectExt({ bytes = null, contentType = '', urlExt = '', audio = false } = {}) {
  const ct = String(contentType).split(';')[0].trim().toLowerCase();
  const sn = bytes && bytes.length >= 4 ? sniff(bytes) : null;
  if (sn && !['unknown', 'html', 'json', 'vtt'].includes(sn.kind)) {
    if (sn.kind === 'mp4' || sn.kind === 'avif') {
      const brand = bytes.length >= 12 ? String.fromCharCode(...bytes.slice(8, 12)) : '';
      if (/^(avif|avis)/.test(brand)) return 'avif';
      if (/^hei[cx]|^mif1|^heif/.test(brand)) return brand.startsWith('hei') && brand !== 'heif' ? 'heic' : 'heif';
      if (/^M4[AB] /.test(brand)) return 'm4a';
      if (brand === 'qt  ') return 'mov';
      return audio || ct.startsWith('audio/') ? 'm4a' : 'mp4';
    }
    return normalizeExt(sn.ext);
  }
  return normalizeExt(CT_EXT[ct]) || normalizeExt(urlExt);
}
