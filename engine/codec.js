/* Codec families, human-readable labels, and output container matrix (Chapters 6 and 8). */

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
  flac: 'FLAC', vorbis: 'Vorbis', unknown: 'Unknown codec', subtitle: 'subtitle',
};

export function codecLabel(videoCodec, audioCodec) {
  const parts = [];
  const v = codecFamily(videoCodec);
  const a = codecFamily(audioCodec);
  if (videoCodec && v !== 'unknown') parts.push(CODEC_LABEL[v]);
  if (audioCodec && a !== 'unknown') parts.push(CODEC_LABEL[a]);
  if (!parts.length) return videoCodec || audioCodec || 'Unknown codec';
  return parts.join(' + ');
}

export function isVideoCodec(codecStr) {
  return ['avc', 'hevc', 'vp9', 'vp8', 'av1'].includes(codecFamily(codecStr));
}
export function isAudioCodec(codecStr) {
  return ['aac', 'opus', 'mp3', 'ac3', 'eac3', 'flac', 'vorbis'].includes(codecFamily(codecStr));
}

/**
 * Output container for the copy path (-c copy semantics).
 * Follows the Chapter 8 matrix: MP4 for H.264/HEVC + AAC; WebM for VP9/AV1 + Opus.
 * Returns null when no container can hold the tracks without transcoding.
 */
export function outputContainerFor(videoCodec, audioCodec) {
  const v = videoCodec ? codecFamily(videoCodec) : null;
  const a = audioCodec ? codecFamily(audioCodec) : null;
  if (v && ['vp9', 'vp8', 'av1'].includes(v)) {
    if (!a || ['opus', 'vorbis'].includes(a)) return 'webm';
    if (a === 'aac') return 'mp4'; // AV1/VP9 + AAC is valid in MP4 in modern players
    return null;
  }
  if (v && ['avc', 'hevc'].includes(v)) {
    if (!a || ['aac', 'mp3', 'ac3', 'eac3', 'flac'].includes(a)) return 'mp4';
    if (a === 'opus') return 'mkv'; // AAC-family + Opus is not standard in MP4/WebM
    return null;
  }
  if (!v && a) return audioContainerFor(audioCodec);
  return null;
}

export function audioContainerFor(audioCodec) {
  const a = audioCodec ? codecFamily(audioCodec) : null;
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

/** An efficient codec only wins at the same resolution when the output container supports it. */
export function efficiencyRank(family) {
  return { av1: 3, vp9: 2, hevc: 2.5, avc: 1, vp8: 0.5, unknown: 0 }[family] ?? 0;
}
