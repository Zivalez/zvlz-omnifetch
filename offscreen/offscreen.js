/*
 * Offscreen document: mesin pekerja (Bab 4 & 8).
 * Parse playlist, fetch segmen, dekripsi AES-128, transmux/mux, pembuatan Blob.
 * Progres dilaporkan langsung ke UI lewat worker; record job ada di storage.session.
 */
import { analyze } from './analyze.js';
import { fetchSegments, fetchRaw, probeProgressive, sleep } from './fetcher.js';
import { TrackStaging, clearAllStaging } from './staging.js';
import { transmuxTs, muxTracks, copyTrack, verifyBlob, checkLimits, assemblySupported } from './assemble.js';
import { startRecording, stopRecording, recordingState } from './recorder.js';
import { decryptAes128, defaultIv, parseIv } from '../engine/aes128.js';
import { canonKey } from '../engine/url.js';
import { parseM3u8 } from '../engine/m3u8.js';
import { parseMpd, expandSegments } from '../engine/mpd.js';
import { buildZip } from '../engine/zip.js';
import { sniff, detectExt } from '../engine/sniff.js';

const jobs = new Map();

const send = (msg) => chrome.runtime.sendMessage({ ...msg, from: 'offscreen' }, () => { void chrome.runtime.lastError; });

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.to !== 'offscreen') return false;
  route(msg).then((res) => respond(res || { ok: true })).catch((e) => respond({ ok: false, error: String(e?.message || e) }));
  return true;
});

async function route(msg) {
  switch (msg.t) {
    case 'ping': return { ok: true, recording: recordingState() };
    case 'close':
      // Remain available for pending Blob downloads; Chrome may close the context on shutdown.
      return {ok:true};
      return { ok: true };
    case 'analyze': {
      const res = await analyze({ candidates: msg.candidates, page: msg.page, prefs: msg.prefs || {} });
      return { ok: true, ...res };
    }
    case 'job:start': {
      runJob(msg).catch((e) => send({ t: 'job:fail', jobId: msg.jobId, reason: e?.reason || 'segment_unavailable', detail: String(e?.message || e).slice(0, 200) }));
      return { ok: true };
    }
    case 'job:control': {
      const job = jobs.get(msg.jobId);
      if (!job) return { ok: false, error: 'no_job' };
      if (msg.action === 'pause') job.paused = true;
      if (msg.action === 'resume') job.paused = false;
      if (msg.action === 'cancel') {
        job.canceled = true;
        job.abort?.abort();
        for (const s of job.stagings || []) await s.clear();
      }
      return { ok: true };
    }
    case 'revoke':
      try { URL.revokeObjectURL(msg.blobUrl); } catch { /* noop */ }
      return { ok: true };
    case 'staging:clear':
      return { ok: true, ...(await clearAllStaging()) };
    case 'images:zip': {
      const files = [];
      for (const entry of msg.entries || []) {
        for (const [i, url] of (entry.urls || []).entries()) {
          try {
            const r = await fetchRaw(url, { timeoutMs: 30000 });
            if (!r.ok) continue;
            const sn = sniff(r.bytes);
            const name = `${sanitize(entry.title || 'gambar')}-${String(i + 1).padStart(2, '0')}.${sn.ext === 'bin' ? 'img' : sn.ext}`;
            if (msg.zipMode === 'zip') files.push({ name, bytes: r.bytes });
            else files.push({ name, bytes: r.bytes, own: true });
          } catch { /* lewati yang gagal, jangan gagalkan semuanya tanpa alasan */ }
        }
      }
      if (msg.zipMode === 'zip') {
        const zip = buildZip(files.map((f) => ({ name: f.name, bytes: f.bytes })));
        const blob = new Blob([zip], { type: 'application/zip' });
        const blobUrl = URL.createObjectURL(blob);
        return { ok: true, blobUrl, size: blob.size };
      }
      const out = [];
      for (const f of files) {
        const blob = new Blob([f.bytes], { type: 'application/octet-stream' });
        out.push({ blobUrl: URL.createObjectURL(blob), name: f.name, size: blob.size });
      }
      return { ok: true, files: out };
    }
    case 'sub:fetch': {
      const parts = [];
      for (const url of msg.urls || []) {
        try {
          const r = await fetchRaw(url, { timeoutMs: 20000 });
          if (r.ok) parts.push(r.bytes);
        } catch { /* noop */ }
      }
      if (!parts.length) return { ok: false, error: 'subtitle_unavailable' };
      const blob = new Blob(parts, { type: 'text/vtt' });
      return { ok: true, blobUrl: URL.createObjectURL(blob), size: blob.size };
    }
    case 'rec:start': {
      const res = await startRecording({
        streamId: msg.streamId,
        onProgress: (p) => send({ t: 'rec:progress', jobId: msg.jobId, ...p }),
      });
      jobs.set(msg.jobId, { status: 'recording', startedAt: res.startedAt });
      return { ok: true, ...res };
    }
    case 'rec:stop': {
      const res = await stopRecording();
      jobs.delete(msg.jobId);
      if (!res) return { ok: false, error: 'no_recording' };
      const blobUrl = URL.createObjectURL(res.blob);
      return { ok: true, blobUrl, size: res.blob.size, ext: res.ext, seconds: res.seconds };
    }
    default: return { ok: false, error: 'unknown' };
  }
}

function sanitize(s) {
  return String(s || 'media').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'media';
}

/* ================= job unduhan malas ================= */
async function runJob(msg) {
  const { jobId, prefs } = msg;
  let inv = structuredClone(msg.inv);
  const job = { status: 'running', paused: false, canceled: false, abort: new AbortController(), stagings: [] };
  jobs.set(jobId, job);
  const headers = {};
  if (msg.cookieHeader) headers.Cookie = msg.cookieHeader;

  const progress = (phase, segIndex, segCount, bytes, totalBytes) => {
    if (job.canceled) return;
    send({ t: 'job:progress', jobId, phase, segIndex, segCount, bytes, totalBytes });
  };

  try {
    if (!assemblySupported()) throw Object.assign(new Error('assembly engine unavailable'), { reason: 'codec_unsupported' });

    /* 1. validasi ulang dari manifest segar */
    progress('manifest', 0, 1, 0, null);
    inv = await refreshInventory(inv, headers, job);

    /* 2. cek kelengkapan ulang + kunci sebelum segmen */
    progress('checking', 0, segTotal(inv), 0, inv.totalBytes || null);
    const keyBytes = await ensureKeys(inv, headers, job);

    /* 3. batas jujur extension-only */
    const est = estimateBytes(inv);
    const limits = checkLimits(est, prefs.maxAssembleBytes);
    if (!limits.ok) throw Object.assign(new Error('exceeds browser assembly limit'), { reason: limits.reason });

    /* 4. ambil segmen berurutan (fetch paralel terbatas, tulis urut) */
    const vStaging = inv.video ? new TrackStaging({ memoryLimit: 96e6, name: 'v' }) : null;
    const aStaging = inv.audio ? new TrackStaging({ memoryLimit: 96e6, name: 'a' }) : null;
    if (vStaging) job.stagings.push(vStaging);
    if (aStaging) job.stagings.push(aStaging);

    let bytesDone = 0;
    const total = segTotal(inv);

    const makeWriter = (staging, trackInv) => async (index, bytes) => {
      let out = bytes;
      const seg = trackInv.segments[index];
      if (seg?.keyUrl) {
        const key = keyBytes[canonKey(seg.keyUrl)];
        if (!key) throw Object.assign(new Error('key_unavailable'), { reason: 'key_unavailable' });
        const iv = seg.iv ? parseIv(seg.iv) : defaultIv(seg.seq ?? index);
        out = await decryptAes128(bytes, new Uint8Array(key), iv);
      }
      await staging.append(out);
    };

    const refreshVideo = async () => {
      const fresh = await refreshInventory(inv, headers, job, true).catch(() => null);
      return fresh && fresh.video ? { segments: fresh.video.segments } : null;
    };
    const refreshAudio = async () => {
      const fresh = await refreshInventory(inv, headers, job, true).catch(() => null);
      return fresh && fresh.audio ? { segments: fresh.audio.segments } : null;
    };

    const runners = [];
    if (inv.video && inv.video.segments.length) {
      if (inv.video.init) await vStaging.append(await fetchInit(inv.video, headers, job));
      runners.push(fetchSegments({ ...inv.video, segments: inv.video.segments }, {
        concurrency: Math.max(2, Math.ceil((prefs.concurrency || 5) / (inv.audio ? 2 : 1))),
        retries: prefs.retries ?? 3,
        headers,
        signal: job.abort.signal,
        shouldPause: () => job.paused,
        refresh: refreshVideo,
        writeSegment: makeWriter(vStaging, inv.video),
        onProgress: (p) => { bytesDone = p.bytes + (aStaging ? aStaging.size : 0); progress('downloading', p.segIndex, total, bytesDone, est); },
      }));
    }
    if (inv.audio && inv.audio.segments.length) {
      if (inv.audio.init) await aStaging.append(await fetchInit(inv.audio, headers, job));
      runners.push(fetchSegments({ segments: inv.audio.segments }, {
        concurrency: Math.max(2, Math.floor((prefs.concurrency || 5) / 2)),
        retries: prefs.retries ?? 3,
        headers,
        signal: job.abort.signal,
        shouldPause: () => job.paused,
        refresh: refreshAudio,
        writeSegment: makeWriter(aStaging, inv.audio),
        onProgress: (p) => { bytesDone = p.bytes + (vStaging ? vStaging.size : 0); progress('downloading', p.segIndex, total, bytesDone, est); },
      }));
    }
    if (!inv.video && !inv.audio && inv.url) {
      // file progresif tunggal
      const res = await fetchRaw(inv.url, { headers, signal: job.abort.signal, timeoutMs: 0 });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { reason: res.status === 403 || res.status === 410 ? 'auth_expired' : 'segment_unavailable' });
      const detected = sniff(res.bytes);
      if (['html','json'].includes(detected.kind) || (detected.kind === 'unknown' && !/^(image|audio|video)\//.test(res.contentType || '') && !/svg/.test(res.contentType || ''))) throw Object.assign(new Error('Unrecognized file format'), {reason:'codec_unsupported'});
      if(res.contentLength && res.bytes.length!==res.contentLength) throw Object.assign(new Error('File was truncated'),{reason:'segment_unavailable'});
      inv._ext = detectExt({ bytes: res.bytes.subarray(0, 4096), contentType: res.contentType, urlExt: inv.ext, audio: /^(m4a|mp3|aac|ogg|flac|wav|opus)$/.test(inv.ext || '') }) || null;
      const st = new TrackStaging({ memoryLimit: 96e6, name: 'p' });
      job.stagings.push(st);
      await st.append(res.bytes);
      inv._singleStaging = st;
      progress('downloading', 1, 1, res.bytes.length, res.bytes.length);
    }
    await Promise.all(runners);
    if (job.canceled) throw Object.assign(new Error('canceled'), { reason: 'canceled' });

    /* 5. rakit sesuai pohon keputusan */
    progress('assembling', total, total, bytesDone, est);
    const container = inv.container || 'mp4';
    let finalBlob = null;
    const vBlob = (inv._singleStaging || vStaging) ? await (inv._singleStaging || vStaging).blob(inv._ext ? mimeForExt(inv._ext) : mimeFor(container)) : null;
    const aBlob = aStaging ? await aStaging.blob(mimeFor(container, true)) : null;

    if (inv.assembly === 'passthrough') finalBlob = vBlob || aBlob;
    else if (inv.assembly === 'concat') finalBlob = vBlob;
    else if (inv.assembly === 'ts') finalBlob = await transmuxTs(vBlob);
    else if (inv.assembly === 'mux') finalBlob = await muxTracks(vBlob, aBlob, container);
    else if (inv.assembly === 'copy') finalBlob = await copyTrack(aBlob || vBlob, container, { keep: aBlob ? 'audio' : 'video' });
    else finalBlob = vBlob;

    /* 6. verifikasi pasca-perakitan: tidak ada 100% sebelum ini lolos */
    const ver = (inv.kind === 'image' || inv._singleStaging) ? { ok: finalBlob.size > 0 && !['html','json'].includes(sniff(new Uint8Array(await finalBlob.slice(0,512).arrayBuffer())).kind) } : await verifyBlob(finalBlob, { duration: inv.duration, toleranceSec: inv.toleranceSec || 8, container: finalBlob.type.includes('webm') || container === 'webm' ? 'webm' : 'mp4' });
    if (!ver.ok) throw Object.assign(new Error(ver.detail || 'assembly verification failed'), { reason: ver.reason || 'assembly_unverified' });

    const blobUrl = URL.createObjectURL(finalBlob);
    send({ t: 'job:done', jobId, blobUrl, size: finalBlob.size, ext: inv._ext || null });
  } catch (e) {
    if (job.canceled || String(e?.message) === 'canceled') {
      send({ t: 'job:fail', jobId, reason: 'canceled', detail: 'dibatalkan pengguna' });
    } else {
      send({ t: 'job:fail', jobId, reason: e?.reason || 'segment_unavailable', detail: String(e?.message || e).slice(0, 200) });
    }
  } finally {
    for (const s of job.stagings) { if (s.closed !== true) await s.clear().catch(() => {}); }
    jobs.delete(jobId);
  }
}

function segTotal(inv) {
  return (inv.video?.segments?.length || 0) + (inv.audio?.segments?.length || 0) || (inv.url ? 1 : 1);
}
function estimateBytes(inv) {
  if (inv.totalBytes) return inv.totalBytes;
  return (inv.video?.segments?.length || 0) * 800_000 + (inv.audio?.segments?.length || 0) * 120_000;
}
const EXT_MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', ogv: 'video/ogg', m4a: 'audio/mp4', mp3: 'audio/mpeg', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac', wav: 'audio/wav' };
function mimeForExt(ext) { return EXT_MIME[ext] || 'application/octet-stream'; }
function mimeFor(container, audio = false) {
  if (container === 'webm') return audio ? 'audio/webm' : 'video/webm';
  if (container === 'mkv') return 'video/x-matroska';
  if (['m4a', 'opus', 'mp3', 'flac'].includes(container)) return 'audio/mp4';
  return audio ? 'audio/mp4' : 'video/mp4';
}

async function fetchInit(track, headers, job) {
  const res = await fetchRaw(track.init, { range: track.initRange, headers, signal: job.abort.signal, timeoutMs: 30000 });
  if (!res.ok) throw Object.assign(new Error('init_missing'), { reason: 'init_missing' });
  return res.bytes;
}

async function ensureKeys(inv, headers, job) {
  const out = {};
  const urls = new Set();
  for (const seg of inv.video?.segments || []) if (seg.keyUrl) urls.add(seg.keyUrl);
  for (const seg of inv.audio?.segments || []) if (seg.keyUrl) urls.add(seg.keyUrl);
  for (const u of urls) {
    const cached = inv.keyBytes?.[canonKey(u)];
    if (cached) { out[canonKey(u)] = cached; continue; }
    const r = await fetchRaw(u, { headers, signal: job.abort.signal, timeoutMs: 10000 });
    if (!r.ok || r.bytes.length < 16) throw Object.assign(new Error('key_unavailable'), { reason: 'key_unavailable' });
    out[canonKey(u)] = Array.from(r.bytes.slice(0, 16));
  }
  return out;
}

/** Fetch ulang manifest & bangun inventaris segar; dipakai juga untuk URL rotasi. */
async function refreshInventory(inv, headers, job, light = false) {
  if (!inv.manifestUrl || inv.kind === 'progressive' || inv.kind === 'image' || inv.kind === 'youtube') {
    if (inv.url) {
      try {
        const probe = await probeProgressive(inv.url, { headers });
        if (!probe.ok) throw Object.assign(new Error('auth_expired'), { reason: probe.reason || 'auth_expired' });
        inv.totalBytes = probe.contentLength || inv.totalBytes;
      } catch (e) { if (e?.reason) throw e; }
    }
    return inv;
  }
  try {
    const res = await fetchRaw(inv.manifestUrl, { headers, signal: job.abort.signal, timeoutMs: 15000 });
    if (!res.ok) throw Object.assign(new Error(`manifest ${res.status}`), { reason: res.status === 403 || res.status === 401 || res.status === 410 ? 'auth_expired' : 'manifest_parse_error' });
    const text = new TextDecoder().decode(res.bytes);
    if (inv.kind === 'hls') {
      const p = parseM3u8(text, inv.manifestUrl);
      if (!p.ok || p.isMaster) throw Object.assign(new Error('Manifest berubah'),{reason:'manifest_parse_error'});
      if (!p.media.endlist) throw Object.assign(new Error('live_stream'), { reason: 'live_stream' });
      if (p.drm.sampleAes || p.drm.cencKeyFormat) throw Object.assign(new Error('drm_protected'), { reason: 'drm_protected' });
      const fresh = p.media.segments.map((s) => ({
        url: s.uri,
        range: s.byterange ? [s.byterange.offset, s.byterange.offset + s.byterange.length - 1] : null,
        duration: s.duration,
        keyUrl: s.key && s.key.method === 'AES-128' ? s.key.uri : null,
        iv: s.key?.iv || null,
        seq: s.sequence,
      }));
      if (!fresh.length || fresh.length !== (inv.video?.segments?.length || 0)) throw Object.assign(new Error('Inventaris berubah, deteksi ulang.'),{reason:'segment_list_incomplete'});
      if (fresh.length) {
        inv.video = { ...inv.video, segments: fresh };
        const initSeg = p.media.segments.find((s) => s.init);
        if (initSeg) inv.video.init = initSeg.init.uri;
      }
      if(inv.audio?.manifestUrl){
        const ar=await fetchRaw(inv.audio.manifestUrl,{headers,signal:job.abort.signal,timeoutMs:15000});
        const ap=ar.ok?parseM3u8(new TextDecoder().decode(ar.bytes),inv.audio.manifestUrl):null;
        if(!ap?.ok||ap.isMaster||!ap.media.endlist||ap.drm.sampleAes||ap.drm.cencKeyFormat||ap.media.segments.length!==inv.audio.segments.length)throw Object.assign(new Error('Audio berubah'),{reason:'audio_incomplete'});
        inv.audio.segments=ap.media.segments.map(s=>({url:s.uri,range:s.byterange?[s.byterange.offset,s.byterange.offset+s.byterange.length-1]:null,duration:s.duration,keyUrl:s.key?.method==='AES-128'?s.key.uri:null,iv:s.key?.iv,seq:s.sequence}));
      }
      return inv;
    }
    if (inv.kind === 'dash') {
      const mpd = parseMpd(text, inv.manifestUrl);
      if (!mpd.ok) return inv;
      if (mpd.type === 'dynamic') throw Object.assign(new Error('live_stream'), { reason: 'live_stream' });
      if (mpd.drm) throw Object.assign(new Error('drm_protected'), { reason: 'drm_protected' });
      const rep = findRepById(mpd, inv.representationId);
      if (rep) {
        const exp = expandSegments(rep, mpd.mediaDuration);
        if (exp.segments.length) {
          const freshTrack = {init:exp.init,segments:exp.segments.map(s=>({url:s.uri,range:s.range,duration:s.duration}))};
          if(inv.video)inv.video=freshTrack;else inv.audio=freshTrack;
        }
      }
      const aRep = inv.audioRepresentationId ? findRepById(mpd, inv.audioRepresentationId) : null;
      if (aRep) {
        const exp = expandSegments(aRep, mpd.mediaDuration);
        if (exp.segments.length) inv.audio = { init: exp.init, segments: exp.segments.map((s) => ({ url: s.uri, range: s.range, duration: s.duration })) };
      }
      return inv;
    }
    return inv;
  } catch (e) {
    if (light) return null;
    throw e;
  }
}

function findRepById(mpd, repId) {
  for (const p of mpd.periods) for (const as of p.adaptationSets) for (const r of as.representations) if (r.id === repId) return r;
  return null;
}
