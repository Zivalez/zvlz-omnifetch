/*
 * Completeness gate (Bab 7): state machine + kelayakan + pemasangan + pemeringkatan.
 * Murni dan deterministik; byte media tidak pernah disentuh di sini.
 *
 * ALUR STATUS:
 * DETECTED -> PARSING -> INVENTORIED -> VERIFIED -> READY -> DOWNLOADING -> ASSEMBLING -> SAVED
 * NOT_READY (dari mana pun) | FAILED (saat unduhan berjalan)
 */
import { canonKey } from './url.js';
import { codecFamily, isAudioCodec, isVideoCodec, outputContainerFor, audioContainerFor, efficiencyRank, codecLabel } from './codec.js';

export const STATUS = {
  DETECTED: 'DETECTED',
  PARSING: 'PARSING',
  INVENTORIED: 'INVENTORIED',
  VERIFIED: 'VERIFIED',
  READY: 'READY',
  NOT_READY: 'NOT_READY',
  DOWNLOADING: 'DOWNLOADING',
  ASSEMBLING: 'ASSEMBLING',
  SAVED: 'SAVED',
  FAILED: 'FAILED',
};

export function hashId(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function sizeFromBandwidth(bandwidth, duration) {
  if (!bandwidth || !duration) return { min: null, max: null };
  const bytes = (bandwidth / 8) * duration;
  return { min: Math.round(bytes * 0.92), max: Math.round(bytes * 1.08) };
}

function resolutionLabel(w, h) {
  if (!h) return null;
  const common = [[2160, '2160p'], [1440, '1440p'], [1080, '1080p'], [720, '720p'], [480, '480p'], [360, '360p'], [240, '240p']];
  for (const [hh, label] of common) if (h >= hh - 40) return label;
  return `${h}p`;
}

/**
 * Gate HLS.
 * @param master parsed master (boleh null bila halaman langsung memberi media playlist)
 * @param playlists Map canonUri -> parsed media playlist
 * @param audioGroups Map canonUri -> parsed media playlist (rendisi audio)
 * @param opts {prefs, keyResults: Map<canonKey,{ok,reason}>}
 */
export function gateHls({ master, playlists, audioGroups, mediaPlaylistUrl, pageMeta, prefs = {}, keyResults = new Map() }) {
  const variants = [];
  const entries = [];

  if (master && master.variants.length) {
    for (const v of master.variants) entries.push({ variant: v, playlistKey: canonKey(v.uri) });
  } else if (mediaPlaylistUrl && playlists.has(canonKey(mediaPlaylistUrl))) {
    entries.push({ variant: { uri: mediaPlaylistUrl, bandwidth: null, resolution: null, codecs: null, audioGroup: null }, playlistKey: canonKey(mediaPlaylistUrl) });
  }

  for (const { variant, playlistKey } of entries) {
    const parsed = playlists.get(playlistKey);
    const reasons = [];
    const meta = {
      id: null,
      manifestUrl: variant.uri,
      playlistKey,
      kind: 'hls',
      label: null,
      resolution: variant.resolution ? variant.resolution[1] : null,
      width: variant.resolution ? variant.resolution[0] : null,
      codecs: variant.codecs,
      bandwidth: variant.bandwidth,
      audioLang: null,
      audioGroup: variant.audioGroup,
      muxedAudio: false,
      segmentCount: 0,
      duration: null,
      sizeMin: null,
      sizeMax: null,
      eligible: false,
      reasons: [],
      container: null,
      audioOnly: false,
      videoCodec: null,
      audioCodec: null,
    };

    if (!parsed || !parsed.ok) { meta.reasons.push('manifest_parse_error'); variants.push(meta); continue; }
    if (parsed.isMaster) { meta.reasons.push('manifest_parse_error'); variants.push(meta); continue; }

    const m = parsed.media;
    meta.segmentCount = m.segments.length;
    meta.duration = m.durationSum || null;

    // sinyal DRM
    if (parsed.drm.sampleAes || parsed.drm.cencKeyFormat) { meta.reasons.push('drm_protected'); }
    // live
    if (!m.endlist) meta.reasons.push('live_stream');
    // inventaris penuh
    if(m.discontinuities)meta.reasons.push('codec_unsupported');
    if(!variant.codecs || !variant.bandwidth)meta.reasons.push('segment_list_incomplete');
    if (m.segments.length === 0) meta.reasons.push('segment_list_incomplete');
    if (m.hasParts && m.segments.length === 0) meta.reasons.push('segment_list_incomplete');

    // init untuk fMP4
    const looksFmp4 = m.segments.some((s) => s.init) || /\.m4s(\?|$)/i.test(m.segments[0]?.uri || '') || (variant.codecs || '').includes('avc1') && /\.mp4(\?|$)/i.test(m.segments[0]?.uri || '');
    if (looksFmp4 && m.initUris.length === 0 && m.segments.length > 0) meta.reasons.push('init_missing');

    // codec & kontainer
    const codecList = String(variant.codecs || '').split(',').map((s) => s.trim()).filter(Boolean);
    const vCodec = codecList.find(isVideoCodec) || null;
    const aCodec = codecList.find(isAudioCodec) || null;
    meta.videoCodec = vCodec;
    meta.audioCodec = aCodec;
    meta.muxedAudio = !!aCodec && !variant.audioGroup;

    // pasang audio dari grup AUDIO
    let audioMeta = null;
    if (variant.audioGroup && master) {
      const rend = master.media.find((mm) => mm.type === 'AUDIO' && mm.groupId === variant.audioGroup && (prefs.audioLang ? (mm.lang || '').toLowerCase().startsWith(prefs.audioLang.toLowerCase()) : mm.isDefault || mm.autoSelect))
        || master.media.find((mm) => mm.type === 'AUDIO' && mm.groupId === variant.audioGroup && (mm.isDefault || mm.autoSelect))
        || master.media.find((mm) => mm.type === 'AUDIO' && mm.groupId === variant.audioGroup);
      if (rend) {
        meta.audioLang = rend.lang || rend.name || null;
        const rp = rend.uri ? audioGroups.get(canonKey(rend.uri)) : null;
        if (rp && rp.ok && !rp.isMaster) {
          audioMeta = { url: rend.uri, segments: rp.media.segments.length, duration: rp.media.durationSum, initUris: rp.media.initUris, playlistKey: canonKey(rend.uri) };
          if (!rp.media.endlist) meta.reasons.push('live_stream');
          if (rp.media.segments.length === 0) meta.reasons.push('audio_incomplete');
          if (meta.duration && rp.media.durationSum && Math.abs(rp.media.durationSum - meta.duration) > (rp.media.targetDuration || 6)) meta.reasons.push('audio_incomplete');
          if (!meta.audioCodec) meta.audioCodec = 'mp4a.40.2';
        } else if (rend.uri) {
          meta.reasons.push('audio_incomplete');
        }
      } else {
        meta.reasons.push('audio_incomplete');
      }
    }

    // kunci AES-128
    const keys = [...new Set(m.segments.map((s) => s.key && s.key.uri).filter(Boolean))];
    for (const k of keys) {
      const res = keyResults.get(canonKey(k));
      if (res && !res.ok) meta.reasons.push(res.reason || 'key_unavailable');
    }

    const container = outputContainerFor(vCodec, aCodec || (audioMeta ? 'mp4a.40.2' : null));
    if (!container && (vCodec || aCodec)) meta.reasons.push('codec_unsupported');
    meta.container = container;

    const est = sizeFromBandwidth(variant.bandwidth, meta.duration);
    meta.sizeMin = est.min; meta.sizeMax = est.max;
    if (meta.sizeMax && prefs.maxAssembleBytes && meta.sizeMax > prefs.maxAssembleBytes) meta.reasons.push('too_large');

    meta.reasons = [...new Set(reasons.concat(meta.reasons))];
    meta.eligible = meta.reasons.length === 0;
    meta.id = `hls:${hashId(playlistKey)}`;
    meta.label = variant.resolution
      ? `${resolutionLabel(variant.resolution[0], variant.resolution[1])} · ${codecLabel(vCodec, aCodec)}`
      : `${codecLabel(vCodec, aCodec)} · ${Math.round((variant.bandwidth || 0) / 1000)} kbps`;
    if (audioMeta) meta.audio = audioMeta;
    variants.push(meta);
  }

  return finalize(variants, prefs, pageMeta);
}

/**
 * Gate DASH.
 * @param mpd parsed MPD
 * @param sidx Map repKey -> {segments:[{range,duration}], initRange}
 */
export function gateDash({ mpd, sidx = new Map(), pageMeta, prefs = {} }) {
  const variants = [];
  for (const period of mpd.periods) {
    const videoSets = period.adaptationSets.filter((a) => a.contentType === 'video');
    const audioSets = period.adaptationSets.filter((a) => a.contentType === 'audio');
    const textSets = period.adaptationSets.filter((a) => a.contentType === 'text');
    const pickAudio = (vRep) => {
      const cands = audioSets
        .map((as) => ({ as, rep: bestRep(as, prefs) }))
        .filter((c) => c.rep)
        .sort((a, b) => {
          const la = (a.as.lang || '').toLowerCase().startsWith((prefs.audioLang || '').toLowerCase()) ? 0 : 1;
          const lb = (b.as.lang || '').toLowerCase().startsWith((prefs.audioLang || '').toLowerCase()) ? 0 : 1;
          if (la !== lb) return la - lb;
          const ra = a.as.roles.includes('main') ? 0 : 1;
          const rb = b.as.roles.includes('main') ? 0 : 1;
          if (ra !== rb) return ra - rb;
          return b.rep.bandwidth - a.rep.bandwidth;
        });
      return cands[0] || null;
    };

    for (const vSet of videoSets) {
      for (const rep of vSet.representations) {
        const meta = dashRepMeta(rep, vSet, period, mpd, sidx, 'video');
        const aPick = pickAudio(rep);
        if (aPick) {
          const aMeta = dashRepMeta(aPick.rep, aPick.as, period, mpd, sidx, 'audio');
          meta.audioLang = aPick.as.lang || aPick.as.label || null;
          meta.audio = { ...aMeta, playlistKey: aMeta.key };
          if (aMeta.reasons.length) meta.reasons.push('audio_incomplete');
          if (meta.duration && aMeta.duration && Math.abs(meta.duration - aMeta.duration) > (aMeta.segDuration || 4)) meta.reasons.push('audio_incomplete');
          meta.audioCodec = aPick.rep.codecs || aPick.as.codecs || meta.audioCodec;
        } else if (audioSets.length) {
          meta.reasons.push('audio_incomplete');
        }
        // subtitle sidecar
        meta.subtitles = textSets.map((t) => {
          const r = t.representations[0];
          const segs = expandRepSegments(r, period, sidx);
          return { lang: t.lang || t.label || 'text', label: t.label || t.lang || 'subtitle', urls: segs.segments.map((s) => s.uri).filter(Boolean), format: (t.mimeType || '').includes('ttml') ? 'ttml' : 'vtt' };
        }).filter((s) => s.urls.length);

        finalizeVariant(meta, prefs);
        variants.push(meta);
      }
      // video-only explicit (wajib berlabel, tidak pernah ditawarkan diam-diam)
    }
    // audio-only berdiri sendiri per Period
    for (const aSet of audioSets) {
      const rep = bestRep(aSet, prefs);
      if (!rep) continue;
      const meta = dashRepMeta(rep, aSet, period, mpd, sidx, 'audio');
      meta.audioOnly = true;
      meta.audioLang = aSet.lang || aSet.label || null;
      meta.container = audioContainerFor(rep.codecs || aSet.codecs);
      if (!meta.container) meta.reasons.push('codec_unsupported');
      finalizeVariant(meta, prefs);
      variants.push(meta);
    }
  }
  return finalize(variants, prefs, pageMeta);
}

function bestRep(as, prefs) {
  const reps = [...as.representations].sort((a, b) => b.bandwidth - a.bandwidth);
  if (prefs.maxResolution) {
    const fit = reps.filter((r) => !r.height || r.height <= prefs.maxResolution);
    if (fit.length) return fit[0];
  }
  return reps[0] || null;
}

function expandRepSegments(rep, period, sidx) {
  // lazy import loop-free: implementasi ada di mpd.js; di sini terima hasil yang sudah diekspansi
  return rep._expanded || { segments: [], init: null };
}

function dashRepMeta(rep, as, period, mpd, sidxMap, role) {
  const reasons = [];
  const expanded = rep._expanded || { segments: [], init: null };
  const key = rep._key;
  const meta = {
    id: `dash:${hashId(key || rep.id)}`,
    key,
    kind: 'dash',
    manifestUrl: mpd.manifestUrl || null,
    periodId: period.id,
    adaptationSetId: as.id,
    representationId: rep.id,
    role,
    label: null,
    resolution: rep.height || null,
    width: rep.width || null,
    codecs: rep.codecs || as.codecs,
    bandwidth: rep.bandwidth,
    audioLang: as.lang || null,
    segmentCount: expanded.segments.length,
    segDuration: expanded.segments[0]?.duration || null,
    duration: expanded.segments.reduce((a, s) => a + (s.duration || 0), 0) || mpd.mediaDuration || period.duration || null,
    sizeMin: null,
    sizeMax: null,
    eligible: false,
    reasons,
    container: null,
    audioOnly: role === 'audio',
    videoCodec: role === 'video' ? (rep.codecs || as.codecs) : null,
    audioCodec: role === 'audio' ? (rep.codecs || as.codecs) : null,
    subtitles: [],
  };
  if(mpd.periods.length>1)reasons.push('segment_list_incomplete');
  if (mpd.type === 'dynamic') reasons.push('live_stream');
  if (as.contentProtection.some((c) => c.drm)) reasons.push('drm_protected');
  if (expanded.segments.length === 0) {
    if (rep.segmentInfo && rep.segmentInfo.kind === 'base' && !sidxMap.get(key)) reasons.push('segment_list_incomplete');
    else reasons.push('segment_list_incomplete');
  }
  const needsInit = (rep.segmentInfo?.kind !== 'base');
  if (needsInit && !expanded.init) reasons.push('init_missing');
  return meta;
}

function finalizeVariant(meta, prefs) {
  const container = meta.audioOnly
    ? (meta.container || audioContainerFor(meta.audioCodec))
    : outputContainerFor(meta.videoCodec, meta.audioCodec);
  if (!container) meta.reasons.push('codec_unsupported');
  meta.container = container || meta.container;
  const totalBandwidth = meta.bandwidth + (meta.audio?.bandwidth || 0);
  const est = sizeFromBandwidth(totalBandwidth || meta.bandwidth, meta.duration);
  meta.sizeMin = meta.sizeMin ?? est.min;
  meta.sizeMax = meta.sizeMax ?? est.max;
  if (meta.sizeMax && prefs.maxAssembleBytes && meta.sizeMax > prefs.maxAssembleBytes) meta.reasons.push('too_large');
  meta.reasons = [...new Set(meta.reasons)];
  meta.eligible = meta.reasons.length === 0;
  meta.label = meta.audioOnly
    ? `Audio only · ${codecLabel(null, meta.audioCodec)}`
    : `${resolutionLabel(meta.width, meta.resolution) || meta.resolution || '?'} · ${codecLabel(meta.videoCodec, meta.audioCodec)}`;
}

function finalize(variants, prefs, pageMeta) {
  // peringkat: preferensi pengguna -> resolusi -> bitrate gabungan; codec efisien hanya seri pada resolusi sama
  const eligible = variants.filter((v) => v.eligible);
  eligible.sort((a, b) => {
    if (prefs.maxResolution) {
      const fa = (a.resolution || 0) <= prefs.maxResolution ? 0 : 1;
      const fb = (b.resolution || 0) <= prefs.maxResolution ? 0 : 1;
      if (fa !== fb) return fa - fb;
    }
    if (prefs.dataSaver && (a.bandwidth || 0) !== (b.bandwidth || 0)) return (a.bandwidth || 0) - (b.bandwidth || 0);
    if ((a.resolution || 0) !== (b.resolution || 0)) return (b.resolution || 0) - (a.resolution || 0);
    const ea = efficiencyRank(codecFamily(a.videoCodec));
    const eb = efficiencyRank(codecFamily(b.videoCodec));
    if (ea !== eb && a.container === b.container) return eb - ea;
    return (b.bandwidth || 0) - (a.bandwidth || 0);
  });
  const ranked = [...eligible, ...variants.filter((v) => !v.eligible)];
  return { variants: ranked, defaultVariantId: eligible[0]?.id || null, eligibleCount: eligible.length };
}

/** Gate file progresif: satu file, verifikasi Content-Length + sniff. */
export function gateProgressive({ url, probe, pageMeta, prefs = {} }) {
  const reasons = [];
  const meta = {
    id: `prog:${hashId(canonKey(url))}`,
    kind: 'progressive',
    manifestUrl: url,
    label: probe.sniff ? `${probe.sniff.kind.toUpperCase()}` : null,
    resolution: probe.height || null,
    width: probe.width || null,
    duration: probe.duration || null,
    segmentCount: 1,
    sizeMin: probe.contentLength || null,
    sizeMax: probe.contentLength || null,
    eligible: false,
    reasons,
    container: probe.sniff?.kind === 'webm' ? 'webm' : probe.sniff?.kind === 'mp4' ? 'mp4' : probe.sniff?.kind || null,
    videoCodec: probe.videoCodec || null,
    audioCodec: probe.audioCodec || null,
    acceptRanges: probe.acceptRanges || false,
    audioOnly: probe.audioOnly || false,
  };
  if (!probe.ok) reasons.push(probe.reason || 'segment_unavailable');
  if (probe.contentLength != null && prefs.maxAssembleBytes && probe.contentLength > prefs.maxAssembleBytes) reasons.push('too_large');
  if (probe.sniff && ['html', 'json'].includes(probe.sniff.kind)) reasons.push('codec_unsupported');
  meta.reasons = reasons;
  meta.eligible = reasons.length === 0;
  meta.label = meta.audioOnly ? 'Audio' : (probe.height ? `${resolutionLabel(probe.width, probe.height)}` : 'Media file');
  return { variants: [meta], defaultVariantId: meta.eligible ? meta.id : null, eligibleCount: meta.eligible ? 1 : 0 };
}

export { resolutionLabel };
