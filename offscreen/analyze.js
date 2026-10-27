/*
 * Analisis kandidat -> item + inventaris (URL teks saja, tanpa byte media).
 * Berjalan di offscreen document: fetch manifest, parse, gate, pasang, peringkat.
 */
import { canonKey, manifestKind, extFromUrl, resolveUrl } from '../engine/url.js';
import { parseM3u8 } from '../engine/m3u8.js';
import { parseMpd, expandSegments } from '../engine/mpd.js';
import { gateHls, gateDash, gateProgressive, hashId } from '../engine/gate.js';
import { codecFamily, isVideoCodec, isAudioCodec, outputContainerFor, audioContainerFor } from '../engine/codec.js';
import { parseSidx } from '../engine/mp4box.js';
import { fetchRaw, probeProgressive, peek } from './fetcher.js';
import { sniff, detectExt } from '../engine/sniff.js';

const SEG_EXT = /\.(ts|m4s)(?=$|[?#])/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg)(?=$|[?#])/i;

const cap = (arr, n) => arr.slice(0, n);
const pmap = (items, limit, fn) => {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx).catch((e) => ({ __err: e }));
    }
  });
  return Promise.all(workers).then(() => out);
};

async function getText(url, timeoutMs = 10000) {
  const res = await fetchRaw(url, { timeoutMs });
  if (!res.ok) {
    const e = new Error(`manifest_${res.status}`);
    e.status = res.status;
    throw e;
  }
  return new TextDecoder().decode(res.bytes);
}

export async function analyze({ candidates, page, prefs }) {
  const net = [...(candidates.net || []), ...(candidates.hook || []).filter((c) => c.kind !== 'youtube')];
  const dom = candidates.dom || [];
  const yt = (candidates.hook || []).find((c) => c.kind === 'youtube');

  const manifests = [];
  const mediaUrls = [];
  const images = [];
  const seen = new Set();

  const addManifest = (url, ct) => {
    const k = canonKey(url);
    if (seen.has('m' + k)) return;
    seen.add('m' + k);
    manifests.push({ url, contentType: ct || null });
  };
  const addMedia = (url, meta = {}) => {
    if (!url || url.startsWith('blob:')) return;
    const k = canonKey(url);
    if (seen.has('v' + k)) return;
    seen.add('v' + k);
    mediaUrls.push({ url, ...meta });
  };
  const addImage = (url, meta = {}) => {
    if (!url) return;
    const k = url.startsWith('data:') ? url.slice(0, 64) : canonKey(url);
    if (seen.has('i' + k)) return;
    seen.add('i' + k);
    images.push({ url, ...meta });
  };

  for (const c of net) {
    const kind = manifestKind(c.url, c.contentType || c.meta?.contentType);
    if (kind || c.kind === 'manifest') addManifest(c.url, c.contentType || c.meta?.contentType);
    else if (SEG_EXT.test(c.url)) { /* segmen digulung ke manifest induk; tidak pernah jadi entri sendiri */ }
    else if (IMAGE_EXT.test(c.url) || /^image\//.test(c.contentType || c.meta?.contentType || '')) addImage(c.url, { contentLength: c.contentLength || c.meta?.contentLength });
    else if (/\.(mp4|m4v|webm|mkv|mov|mp3|aac|opus|ogg|flac|wav|m4a)(?=$|[?#])/i.test(c.url) || /^(video|audio)\//.test(c.contentType || c.meta?.contentType || '')) addMedia(c.url, { contentLength: c.contentLength || c.meta?.contentLength });
  }
  for (const c of dom) {
    if (c.kind === 'image') addImage(c.url, c.meta || {});
    else if (c.kind === 'canvas' || c.kind === 'data') addImage(c.url, c.meta || {});
    else if (c.kind === 'video' || c.kind === 'audio') {
      if (c.meta?.blob) continue; // blob: adalah sinyal mencari manifest, bukan target unduhan
      addMedia(c.url, c.meta || {});
    }
  }
  if (page?.ogVideo) addMedia(page.ogVideo, {});

  const items = [];
  const inventories = {};
  let index = 0;

  /* ---------- HLS ---------- */
  const hlsManifests = cap(manifests.filter((m) => manifestKind(m.url, m.contentType) === 'hls'), 5);
  for (const man of hlsManifests) {
    try {
      const text = await getText(man.url);
      const parsed = parseM3u8(text, man.url);
      if (!parsed.ok) { items.push(streamItem(man.url, 'hls', page, [], { status: 'NOT_READY', notReadyReason: 'manifest_parse_error' }, index++)); continue; }
      const playlists = new Map();
      const audioGroups = new Map();
      if (parsed.isMaster) {
        const variants = cap(parsed.master.variants, 8);
        const texts = await pmap(variants, 6, async (v) => ({ v, text: await getText(v.uri) }));
        for (const r of texts) {
          if (r?.__err || !r?.text) continue;
          const p = parseM3u8(r.text, r.v.uri);
          playlists.set(canonKey(r.v.uri), p);
        }
        const rends = cap(parsed.master.media.filter((m) => m.type === 'AUDIO' && m.uri), 6);
        const rtexts = await pmap(rends, 4, async (r) => ({ r, text: await getText(r.uri) }));
        for (const q of rtexts) {
          if (q?.__err || !q?.text) continue;
          audioGroups.set(canonKey(q.r.uri), parseM3u8(q.text, q.r.uri));
        }
      } else {
        playlists.set(canonKey(man.url), parsed);
      }
      // kunci AES-128: bukti bisa diambil sebelum menawarkan READY
      const keyResults = new Map();
      const keyUrls = [];
      for (const p of [...playlists.values(), ...audioGroups.values()]) {
        if (!p?.ok || p.isMaster) continue;
        for (const k of p.media.keys || []) if (k.uri && k.method === 'AES-128') keyUrls.push(k.uri);
      }


      const gate = gateHls({ master: parsed.isMaster ? parsed.master : null, playlists, audioGroups, mediaPlaylistUrl: parsed.isMaster ? null : man.url, pageMeta: page, prefs, keyResults });
      const domVideo = dom.find((d) => (d.kind === 'video') && d.meta?.blob);
      const item = streamItem(man.url, 'hls', page, gate.variants, {}, index++, {
        poster: domVideo?.meta?.poster || page?.ogImage || null,
        duration: gate.variants.find((v) => v.duration)?.duration || null,
        titleHint: domVideo?.meta?.titleHint || null,
        segmentCount: gate.variants.find((v) => v.segmentCount)?.segmentCount || null,
        audioLang: gate.variants.find((v) => v.audioLang)?.audioLang || null,
      });
      for (const v of gate.variants) if (v.eligible) inventories[v.id] = hlsInventory(v, playlists, audioGroups, parsed, keyResults);
      items.push(item);
    } catch (e) {
      const reason = e?.status === 403 || e?.status === 401 ? 'auth_expired' : 'manifest_parse_error';
      items.push(streamItem(man.url, 'hls', page, [], { status: 'NOT_READY', notReadyReason: reason }, index++));
    }
  }

  /* ---------- DASH ---------- */
  const dashManifests = cap(manifests.filter((m) => manifestKind(m.url, m.contentType) === 'dash'), 4);
  for (const man of dashManifests) {
    try {
      const text = await getText(man.url);
      const mpd = parseMpd(text, man.url);
      if (!mpd.ok) { items.push(streamItem(man.url, 'dash', page, [], { status: 'NOT_READY', notReadyReason: 'manifest_parse_error' }, index++)); continue; }
      mpd.manifestUrl = man.url;
      const sidxMap = new Map();
      // ekspansi segmen per representation (cap), termasuk sidx untuk SegmentBase
      const jobs = [];
      for (const period of mpd.periods) {
        for (const as of period.adaptationSets) {
          const reps = as.contentType === 'video' ? cap([...as.representations].sort((a, b) => b.bandwidth - a.bandwidth), 6) : as.representations;
          for (const rep of reps) {
            const key = `${period.id || 0}:${as.id || 0}:${rep.id}`;
            rep._key = key;
            if (rep.segmentInfo?.kind === 'base' && rep.segmentInfo.indexRange) {
              // SegmentBase needs index bytes; rejected until an explicit download-safe index path exists.

            } else {
              const exp = expandSegments(rep, period.duration || mpd.mediaDuration);
              rep._expanded = { init: exp.init || null, segments: exp.segments };
            }
          }
        }
      }
      await pmap(cap(jobs, 12), 4, (fn) => fn());
      const gate = gateDash({ mpd, sidx: sidxMap, pageMeta: page, prefs });
      const domVideo = dom.find((d) => d.kind === 'video' && d.meta?.blob);
      const item = streamItem(man.url, 'dash', page, gate.variants, {}, index++, {
        poster: domVideo?.meta?.poster || page?.ogImage || null,
        duration: mpd.mediaDuration,
        titleHint: domVideo?.meta?.titleHint || null,
      });
      for (const v of gate.variants) if (v.eligible) inventories[v.id] = dashInventory(v, mpd);
      items.push(item);
    } catch (e) {
      const reason = e?.status === 403 || e?.status === 401 ? 'auth_expired' : 'manifest_parse_error';
      items.push(streamItem(man.url, 'dash', page, [], { status: 'NOT_READY', notReadyReason: reason }, index++));
    }
  }

  /* ---------- YouTube (fitur inti di dalam ekstensi) ---------- */
  if (yt?.formats?.length) {
    const { item, invs } = youtubeItem(yt.formats, page, prefs, index++);
    if (item) { items.push(item); Object.assign(inventories, invs); }
  }

  /* ---------- progresif ---------- */
  const probes = cap(mediaUrls, 8);
  const probeResults = await pmap(probes, 4, async (m) => ({ m, probe: await cachedProbe(m.url) }));
  for (const r of probeResults) {
    if (!r || r.__err || !r.probe) continue;
    const { m, probe } = r;
    if (probe.sniff && (IMAGE_EXT.test(m.url) || IMAGE_EXTS.has(probe.ext))) { addImage(m.url, { contentLength: probe.contentLength }); continue; }
    const gate = gateProgressive({ url: m.url, probe, pageMeta: page, prefs });
    const v = gate.variants[0];
    const domMatch = dom.find((d) => (d.kind === 'video' || d.kind === 'audio') && d.url === m.url);
    const audioOnly = (domMatch?.kind === 'audio') || !!probe.audioOnly || AUDIO_EXTS.has(probe.ext) || /^audio\//.test(probe.contentType || '');
    const fmt = (probe.ext && probe.ext !== 'bin' ? probe.ext : extFromUrl(m.url)) || (audioOnly ? 'm4a' : 'mp4');
    const outExt = audioOnly && fmt === 'mp4' ? 'm4a' : fmt === 'jpeg' ? 'jpg' : fmt;
    v.audioOnly = audioOnly;
    v.container = outExt;
    v.ext = outExt;
    v.label = audioOnly ? `Audio · ${outExt.toUpperCase()}` : v.label;
    const item = {
      id: `item:${hashId(canonKey(m.url))}`,
      kind: audioOnly ? 'audio' : 'video',
      type: 'progressive',
      title: domMatch?.meta?.titleHint || page?.title || hostLabel(m.url),
      posterUrl: domMatch?.meta?.poster || null,
      faviconUrl: page?.favicon || null,
      duration: probe.duration || domMatch?.meta?.duration || null,
      width: probe.width || domMatch?.meta?.width || null,
      height: probe.height || domMatch?.meta?.height || null,
      variants: gate.variants,
      defaultVariantId: gate.defaultVariantId,
      status: v.eligible ? 'READY' : 'NOT_READY',
      notReadyReason: v.eligible ? null : v.reasons[0],
      subtitles: [],
      live: false,
      drm: false,
      index: index++,
      manifestUrl: m.url,
    };
    if (v.eligible) inventories[v.id] = { kind: 'progressive', url: m.url, container: v.container, ext: v.ext, duration: v.duration, assembly: 'passthrough', totalBytes: v.sizeMax };
    items.push(item);
  }

  /* ---------- gambar ---------- */
  const imageList = cap(images, 80);
  const imgEntries = [];
  for (const img of imageList) {
    if (img.url.startsWith('data:')) {
      const size = dataUrlSize(img.url);
      const di=imageItem(img, page, index++, {size,kind:sniffData(img.url)}); items.push(di); inventories[di.variants[0].id]={kind:'image',url:img.url,urls:[img.url],assembly:'passthrough'};
      continue;
    }
    const rends = (img.renditions || []).length ? img.renditions : [{ url: img.url, w: img.width, x: 1 }];
    const best = rends.sort((a, b) => (b.w || 0) - (a.w || 0))[0];
    const size = img.contentLength || null;
    const tooSmall = !prefs.showAllImages && img.width && img.height && (img.width < (prefs.hideBelowPx || 100) || img.height < (prefs.hideBelowPx || 100));
    if (tooSmall) continue;
    const item = imageItem({ ...img, url: best.url, renditions: rends }, page, index++, { size });
    const v = item.variants[0];
    inventories[v.id] = { kind: 'image', urls: rends.map((r) => r.url), url: best.url, container: null, ext: extFromUrl(best.url) || 'img', assembly: 'passthrough', totalBytes: size };
    items.push(item);
    imgEntries.push({ item, v, inv: inventories[v.id], url: best.url });
  }

  await pmap(imgEntries, 6, async (e) => {
    const info = await cachedImageInfo(e.url);
    if (!info) return;
    if (info.bad) { e.drop = true; return; }
    if (info.ext) { e.v.ext = info.ext; e.inv.ext = info.ext; }
    if (info.size && !e.v.sizeMax) { e.v.sizeMin = e.v.sizeMax = info.size; e.inv.totalBytes = info.size; }
  });
  for (const e of imgEntries) {
    if (!e.drop) continue;
    const k = items.indexOf(e.item);
    if (k >= 0) items.splice(k, 1);
    delete inventories[e.v.id];
  }

  items.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return { items, inventories };
}

/* ---------- pembantu ---------- */
function hostLabel(url) {
  try { return new URL(url).hostname; } catch { return 'media'; }
}
function extOf(container, url) {
  if (container && container !== 'unknown') return container === 'm4a' ? 'm4a' : container;
  return extFromUrl(url) || 'bin';
}
function dataUrlSize(u) {
  const i = u.indexOf(',');
  if (i < 0) return 0;
  const body = u.slice(i + 1);
  return /;base64/i.test(u.slice(0, i)) ? Math.floor(body.length * 0.75) : decodeURIComponent(body).length;
}
function sniffData(u) {
  if (u.startsWith('data:image/')) return u.slice(5, u.indexOf(';')) || 'image';
  return 'data';
}

function statusOf(variants) {
  const eligible = variants.filter((v) => v.eligible);
  if (eligible.length) return { status: 'READY', notReadyReason: null };
  const first = variants[0];
  if (!first) return { status: 'NOT_READY', notReadyReason: 'segment_list_incomplete' };
  if (first.reasons.includes('drm_protected')) return { status: 'NOT_READY', notReadyReason: 'drm_protected' };
  if (first.reasons.includes('live_stream')) return { status: 'NOT_READY', notReadyReason: 'live_stream' };
  return { status: 'NOT_READY', notReadyReason: first.reasons[0] || 'manifest_parse_error' };
}

function streamItem(url, type, page, variants, override, index, extra = {}) {
  const st = override.status ? override : statusOf(variants);
  const best = variants.find((v) => v.eligible) || variants[0];
  return {
    id: `item:${hashId(canonKey(url))}`,
    kind: best?.audioOnly ? 'audio' : 'video',
    type,
    title: extra.titleHint || page?.title || hostLabel(url),
    posterUrl: extra.poster || null,
    faviconUrl: page?.favicon || null,
    duration: extra.duration ?? best?.duration ?? null,
    width: best?.width || null,
    height: best?.resolution || null,
    segmentCount: extra.segmentCount ?? best?.segmentCount ?? null,
    audioLang: extra.audioLang ?? best?.audioLang ?? null,
    variants,
    defaultVariantId: variants.find((v) => v.eligible)?.id || null,
    status: st.status,
    notReadyReason: st.notReadyReason,
    subtitles: best?.subtitles || [],
    live: variants.some((v) => v.reasons.includes('live_stream')) || (!variants.length && false),
    drm: variants.some((v) => v.reasons.includes('drm_protected')),
    index,
    manifestUrl: url,
  };
}

function imageItem(img, page, index, { size = null, kind = null } = {}) {
  const ext = extFromUrl(img.url) || (kind && kind !== 'data' ? kind.replace('image/', '') : 'img');
  const v = {
    id: `img:${hashId(img.url.slice(0, 96))}`,
    kind: 'image',
    label: img.width ? `${img.width}×${img.height}` : 'image',
    resolution: img.height || null,
    width: img.width || null,
    eligible: true,
    reasons: [],
    sizeMin: size,
    sizeMax: size,
    container: null,
    ext: ext === 'jpeg' ? 'jpg' : ext,
    renditions: img.renditions || [],
  };
  return {
    id: `item:${v.id}`,
    kind: 'image',
    type: 'image',
    title: img.alt || page?.title || hostLabel(img.url),
    posterUrl: img.url.startsWith('data:') ? null : img.url,
    faviconUrl: page?.favicon || null,
    duration: null,
    width: img.width || null,
    height: img.height || null,
    variants: [v],
    defaultVariantId: v.id,
    status: 'READY',
    notReadyReason: null,
    subtitles: [],
    live: false,
    drm: false,
    index,
    manifestUrl: img.url,
  };
}

/* ---------- inventaris (daftar URL segmen sebagai teks) ---------- */
function hlsInventory(v, playlists, audioGroups, masterParsed, keyResults) {
  const p = playlists.get(v.playlistKey);
  const segs = (p?.media?.segments || []).map((s) => ({
    url: s.uri,
    range: s.byterange ? [s.byterange.offset, s.byterange.offset + s.byterange.length - 1] : null,
    duration: s.duration,
    keyUrl: s.key && s.key.method === 'AES-128' ? s.key.uri : null,
    iv: s.key?.iv || null,
    seq: s.sequence,
  }));
  const init = p?.media?.segments?.find((s) => s.init)?.init || null;
  const isTs = /\.ts(?=$|[?#])/i.test(segs[0]?.url || '') && !init;
  let audio = null;
  if (v.audio?.playlistKey) {
    const ap = audioGroups.get(v.audio.playlistKey);
    audio = {
      manifestUrl: v.audio.url,
      init: ap?.media?.segments?.find((s) => s.init)?.init?.uri || null,
      segments: (ap?.media?.segments || []).map((s) => ({
        url: s.uri,
        range: s.byterange ? [s.byterange.offset, s.byterange.offset + s.byterange.length - 1] : null,
        duration: s.duration,
        keyUrl: s.key && s.key.method === 'AES-128' ? s.key.uri : null,
        iv: s.key?.iv || null,
        seq: s.sequence,
      })),
    };
  }
  const keys = {};
  for (const [k, r] of keyResults) if (r?.bytes) keys[k] = r.bytes;
  return {
    kind: 'hls',
    manifestUrl: v.manifestUrl,
    container: v.container || (isTs ? 'mp4' : 'mp4'),
    ext: v.container || 'mp4',
    assembly: isTs ? 'ts' : (audio ? 'mux' : 'concat'),
    muxed: !audio,
    duration: v.duration,
    toleranceSec: Math.max(6, (p?.media?.targetDuration || 6) * 1.5),
    video: { init: init?.uri || null, initRange: init?.byterange ? [init.byterange.offset, init.byterange.offset + init.byterange.length - 1] : null, segments: segs },
    audio,
    keyBytes: keys,
    totalBytes: v.sizeMax,
  };
}

function dashInventory(v, mpd) {
  const findRep = (repId) => {
    for (const p of mpd.periods) for (const as of p.adaptationSets) for (const r of as.representations) if (r.id === repId) return r;
    return null;
  };
  const vRep = findRep(v.representationId);
  const vExp = vRep?._expanded || { segments: [], init: null };
  const audio = v.audio ? (() => {
    const aRep = findRep(v.audio.representationId);
    const aExp = aRep?._expanded || { segments: [], init: null };
    return { init: aExp.init, segments: aExp.segments.map((s) => ({ url: s.uri, range: s.range, duration: s.duration })) };
  })() : null;
  const container = v.container || 'mp4';
  return {
    kind: 'dash',
    manifestUrl: v.manifestUrl || mpd.manifestUrl,
    representationId: v.representationId,
    audioRepresentationId: v.audio?.representationId || null,
    container,
    ext: container,
    assembly: audio ? 'mux' : (v.audioOnly ? 'copy' : 'concat'),
    muxed: false,
    duration: v.duration,
    toleranceSec: Math.max(6, (v.segDuration || 4) * 2),
    video: v.audioOnly ? null : { init: vExp.init, segments: vExp.segments.map((s) => ({ url: s.uri, range: s.range, duration: s.duration })) },
    audio: v.audioOnly ? { init: vExp.init, segments: vExp.segments.map((s) => ({ url: s.uri, range: s.range, duration: s.duration })) } : audio,
    totalBytes: v.sizeMax,
  };
}

/* ---------- YouTube ---------- */
function youtubeItem(formats, page, prefs, index) {
  const invs = {};
  const withUrl = formats.filter((f) => f.url);
  const progressive = withUrl.filter((f) => f.hasAudio && f.hasVideo);
  const videos = withUrl.filter((f) => f.hasVideo && !f.hasAudio);
  const audios = withUrl.filter((f) => f.hasAudio && !f.hasVideo);
  const cipherOnly = formats.some((f) => !f.url && f.signatureCipher);
  const variants = [];

  const codecsOf = (mime) => {
    const m = /codecs="([^"]+)"/.exec(mime || '');
    return m ? m[1].split(',').map((s) => s.trim()) : [];
  };

  for (const f of progressive) {
    const codecs = codecsOf(f.mimeType);
    const container = outputContainerFor(codecs.find(isVideoCodec), codecs.find(isAudioCodec)) || 'mp4';
    variants.push({
      id: `yt:${f.itag}`, kind: 'progressive', manifestUrl: f.url, label: f.qualityLabel || `${f.height}p`,
      resolution: f.height, width: f.width, bandwidth: f.bitrate, audioLang: null,
      segmentCount: 1, duration: (f.durationMs || 0) / 1000 || null,
      sizeMin: f.bitrate && f.durationMs ? Math.round((f.bitrate / 8) * (f.durationMs / 1000) * 0.92) : null,
      sizeMax: f.bitrate && f.durationMs ? Math.round((f.bitrate / 8) * (f.durationMs / 1000) * 1.08) : null,
      eligible: true, reasons: [], container, ext: container, audioOnly: false,
      videoCodec: codecs.find(isVideoCodec) || null, audioCodec: codecs.find(isAudioCodec) || null, subtitles: [],
    });
    invs[`yt:${f.itag}`] = { kind: 'progressive', url: f.url, container, ext: container, assembly: 'passthrough', duration: (f.durationMs || 0) / 1000 || null, totalBytes: null, ranges: f.indexRange ? [Number(f.indexRange.start), Number(f.indexRange.end)] : null };
  }

  const bestAudio = audios.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
  for (const v of videos) {
    const vCodecs = codecsOf(v.mimeType);
    const aCodecs = bestAudio ? codecsOf(bestAudio.mimeType) : [];
    const container = outputContainerFor(vCodecs[0], aCodecs[0]) || 'mp4';
    const dur = (v.durationMs || 0) / 1000 || null;
    const id = `yt:${v.itag}+${bestAudio ? bestAudio.itag : 'none'}`;
    variants.push({
      id, kind: 'youtube', manifestUrl: v.url, label: `${v.qualityLabel || `${v.height}p`} · ${vCodecs[0] || ''}`.trim(),
      resolution: v.height, width: v.width, bandwidth: (v.bitrate || 0) + (bestAudio?.bitrate || 0), audioLang: null,
      segmentCount: 1, duration: dur,
      sizeMin: dur && v.bitrate ? Math.round(((v.bitrate + (bestAudio?.bitrate || 0)) / 8) * dur * 0.92) : null,
      sizeMax: dur && v.bitrate ? Math.round(((v.bitrate + (bestAudio?.bitrate || 0)) / 8) * dur * 1.08) : null,
      eligible: !!bestAudio, reasons: bestAudio?[]:['audio_incomplete'], container, ext: container, audioOnly: false,
      videoCodec: vCodecs[0] || null, audioCodec: aCodecs[0] || null, subtitles: [],
    });
    invs[id] = { kind: 'youtube', assembly: bestAudio ? 'mux' : 'copy', container, ext: container, duration: dur, muxed: false, video: { init: null, segments: [{ url: v.url, range: null }] }, audio: bestAudio ? { init: null, segments: [{ url: bestAudio.url, range: null }] } : null, totalBytes: null };
  }

  if (bestAudio) {
    const aCodecs = codecsOf(bestAudio.mimeType);
    const container = audioContainerFor(aCodecs[0]) || 'm4a';
    const dur = (bestAudio.durationMs || 0) / 1000 || null;
    const id = `yt:audio:${bestAudio.itag}`;
    variants.push({
      id, kind: 'youtube', manifestUrl: bestAudio.url, label: 'Audio only',
      resolution: null, bandwidth: bestAudio.bitrate, audioLang: null, segmentCount: 1, duration: dur,
      sizeMin: dur && bestAudio.bitrate ? Math.round((bestAudio.bitrate / 8) * dur * 0.92) : null,
      sizeMax: dur && bestAudio.bitrate ? Math.round((bestAudio.bitrate / 8) * dur * 1.08) : null,
      eligible: true, reasons: [], container, ext: container, audioOnly: true, videoCodec: null, audioCodec: aCodecs[0] || null, subtitles: [],
    });
    invs[id] = { kind: 'youtube', assembly: 'copy', container, ext: container, duration: dur, video: null, audio: { init: null, segments: [{ url: bestAudio.url, range: null }] }, totalBytes: null };
  }

  if (!variants.length && cipherOnly) {
    return {
      item: {
        id: `item:yt:${hashId(page?.url || 'yt')}`, kind: 'video', type: 'youtube',
        title: page?.title || 'YouTube', posterUrl: page?.ogImage || null, faviconUrl: page?.favicon || null,
        duration: (formats[0]?.durationMs || 0) / 1000 || null, variants: [], defaultVariantId: null,
        status: 'NOT_READY', notReadyReason: 'signature_required', subtitles: [], live: false, drm: false, index, manifestUrl: page?.url || null,
      },
      invs,
    };
  }
  if (!variants.length) return { item: null, invs };

  variants.sort((a, b) => (b.resolution || 0) - (a.resolution || 0));
  return {
    item: {
      id: `item:yt:${hashId(page?.url || 'yt')}`, kind: 'video', type: 'youtube',
      title: page?.title || 'YouTube', posterUrl: page?.ogImage || null, faviconUrl: page?.favicon || null,
      duration: variants[0]?.duration || null, width: variants[0]?.width || null, height: variants[0]?.resolution || null,
      segmentCount: null, audioLang: null, variants, defaultVariantId: variants.find((v) => v.eligible && !v.audioOnly)?.id || variants[0].id,
      status: 'READY', notReadyReason: null, subtitles: [], live: false, drm: false, index, manifestUrl: page?.url || null,
    },
    invs,
  };
}

/* ---------- real format detection helpers (cached across re-analysis) ---------- */
const AUDIO_EXTS = new Set(['m4a', 'mp3', 'aac', 'ogg', 'flac', 'wav', 'opus']);
const IMAGE_EXTS = new Set(['jpg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'heic', 'heif']);
const probeCache = new Map();
const imageInfoCache = new Map();

async function cachedProbe(url) {
  const hit = probeCache.get(url);
  if (hit && Date.now() - hit.t < 5 * 60_000) return hit.v;
  const v = await probeProgressive(url, {});
  if (v.ok) probeCache.set(url, { t: Date.now(), v });
  return v;
}

/** First bytes of an image: real extension + total size, or {bad:true} for HTML/JSON error pages. */
async function cachedImageInfo(url) {
  if (imageInfoCache.has(url)) return imageInfoCache.get(url);
  let out = null;
  try {
    const p = await peek(url, { max: 4096, timeoutMs: 10000 });
    if (p.ok) {
      const sn = p.bytes.length >= 4 ? sniff(p.bytes) : null;
      if (sn && ['html', 'json'].includes(sn.kind)) out = { bad: true };
      else out = { ext: detectExt({ bytes: p.bytes, contentType: p.contentType, urlExt: extFromUrl(url) }), size: p.total };
    }
  } catch { /* leave null: keep the URL-based guess */ }
  if (out) imageInfoCache.set(url, out);
  return out;
}
