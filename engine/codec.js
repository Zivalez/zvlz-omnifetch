/* Keluarga codec, label manusiawi, dan matriks kontainer keluaran (Bab 6 & 8). */

export function codecFamily(codecStr) {
  const c = String(codecStr || '').toLowerCase();
  if (c.startsWith('avc1') || c.startsWith('avc3')) return 'avc';
  if (c.startsWith('hev1') || c.startsWith('hvc1')) return 'hevc';
  if (c.startsWith('vp09') || c.startsWith('vp9')) return 'vp9';
  if (c.startsWith('vp08') || c.startsWith('vp8')) return 'vp8';
  if (c.startsWith('av01') || c.startsWith('av1')) return 'av1';
  if (c.startsWith('mp4a.40.2') || c.startsWith('mp4a.40.5') || c.startsWith('mp4a.6')) return 'aac';
  if (c.startsWith('mp4a')) return 'aac';
  if (c.startsWith('opus')) return 'opus';
  if (c.startsWith('mp4a.40.29') || c.startsWith('mp3') || c.startsWith('.mp3')) return 'mp3';
  if (c.startsWith('ac-3') || c.startsWith('ac3')) return 'ac3';
  if (c.startsWith('ec-3') || c.startsWith('ec3')) return 'eac3';
  if (c.startsWith('fLaC') || c.startsWith('flac')) return 'flac';
  if (c.startsWith('vorbis')) return 'vorbis';
  if (c.startsWith('stpp') || c.startsWith('wvtt')) return 'subtitle';
  return 'unknown';
}

export const CODEC_LABEL = {
  avc: 'H.264', hevc: 'HEVC', vp9: 'VP9', vp8: 'VP8', av1: 'AV1',
  aac: 'AAC', opus: 'Opus', mp3: 'MP3', ac3: 'AC-3', eac3: 'E-AC-3',
  flac: 'FLAC', vorbis: 'Vorbis', unknown: 'codec tak dikenal', subtitle: 'subtitle',
};

export function codecLabel(videoCodec, audioCodec) {
  const parts = [];
  const v = codecFamily(videoCodec);
  const a = codecFamily(audioCodec);
  if (videoCodec && v !== 'unknown') parts.push(CODEC_LABEL[v]);
  if (audioCodec && a !== 'unknown') parts.push(CODEC_LABEL[a]);
  if (!parts.length) return videoCodec || audioCodec || 'codec tak dikenal';
  return parts.join(' + ');
}

export function isVideoCodec(codecStr) {
  return ['avc', 'hevc', 'vp9', 'vp8', 'av1'].includes(codecFamily(codecStr));
}
export function isAudioCodec(codecStr) {
  return ['aac', 'opus', 'mp3', 'ac3', 'eac3', 'flac', 'vorbis'].includes(codecFamily(codecStr));
}

/**
 * Kontainer keluaran untuk jalur copy (semantik -c copy).
 * Mengikuti matriks Bab 8: MP4 untuk H.264/HEVC + AAC; WebM untuk VP9/AV1 + Opus.
 * Mengembalikan null bila tidak ada kontainer yang bisa menampung tanpa transcode.
 */
export function outputContainerFor(videoCodec, audioCodec) {
  const v = videoCodec ? codecFamily(videoCodec) : null;
  const a = audioCodec ? codecFamily(audioCodec) : null;
  if (v && ['vp9', 'vp8', 'av1'].includes(v)) {
    if (!a || ['opus', 'vorbis'].includes(a)) return 'webm';
    if (a === 'aac') return 'mp4'; // AV1/VP9 + AAC sah di MP4 pada player modern
    return null;
  }
  if (v && ['avc', 'hevc'].includes(v)) {
    if (!a || ['aac', 'mp3', 'ac3', 'eac3', 'flac'].includes(a)) return 'mp4';
    if (a === 'opus') return 'mkv'; // AAC-family + Opus tidak standar di MP4/WebM
    return null;
  }
  if (!v && a) return audioContainerFor(audioCodec);
  return null;
}

export function audioContainerFor(audioCodec) {
  const a = codecFamily(audioCodec);
  if (a === 'aac') return 'm4a';
  if (a === 'opus') return 'opus';
  if (a === 'mp3') return 'mp3';
  if (a === 'flac') return 'flac';
  if (a === 'vorbis') return 'ogg';
  if (a === 'ac3' || a === 'eac3') return 'ac3';
  return null;
}

export const CONTAINER_EXT = {
  mp4: 'mp4', webm: 'webm', mkv: 'mkv', m4a: 'm4a', opus: 'opus',
  mp3: 'mp3', flac: 'flac', ogg: 'ogg', ac3: 'ac3', ts: 'ts',
};

/** Codec efisien hanya menang pada resolusi sama bila kontainer keluaran mendukungnya. */
export function efficiencyRank(family) {
  return { av1: 3, vp9: 2, hevc: 2.5, avc: 1, vp8: 0.5, unknown: 0 }[family] ?? 0;
}
