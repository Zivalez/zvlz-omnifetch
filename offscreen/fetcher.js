/*
 * Pengambil byte: manifest, segmen (konkurensi terbatas + retry + backoff), probe progresif.
 * Fetch konteks ekstensi bebas CORS; cookie sesi hanya ditempel bila diminta job.
 */
import { sniff, detectExt } from '../engine/sniff.js';

export class HttpError extends Error {
  constructor(status, url, extra = {}) {
    super(`HTTP ${status} untuk ${url}`);
    this.status = status;
    this.url = url;
    Object.assign(this, extra);
  }
}

export async function fetchRaw(url, { range = null, headers = {}, signal = null, timeoutMs = 20000, method = 'GET' } = {}) {
  const ctrl = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  const onOuter = signal ? () => ctrl.abort() : null;
  if (signal) signal.addEventListener('abort', onOuter);
  const h = { ...headers };
  if (range) h.Range = `bytes=${range[0]}-${range[1] != null ? range[1] : ''}`;
  try {
    const res = await fetch(url, { method, headers: h, signal: ctrl.signal, credentials: 'include', redirect: 'follow' });
    const buf = method === 'HEAD' ? null : new Uint8Array(await res.arrayBuffer());
    const cl = res.headers.get('content-length');
    const cr = res.headers.get('content-range');
    return {
      ok: res.ok,
      status: res.status,
      bytes: buf,
      contentType: res.headers.get('content-type') || '',
      contentLength: cl ? Number(cl) : null,
      contentRange: cr,
      acceptRanges: (res.headers.get('accept-ranges') || '') === 'bytes',
      fromRange: res.status === 206,
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuter);
  }
}

/** Read only the first bytes of a URL (never the whole body), even if the server ignores Range. */
export async function peek(url, { headers = {}, max = 65536, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { ...headers, Range: `bytes=0-${max - 1}` }, signal: ctrl.signal, credentials: 'include', redirect: 'follow' });
    const bytes = new Uint8Array(max);
    let n = 0;
    if (res.ok && res.body) {
      const reader = res.body.getReader();
      while (n < max) {
        const { done, value } = await reader.read();
        if (done) break;
        const take = Math.min(value.length, max - n);
        bytes.set(value.subarray(0, take), n);
        n += take;
      }
      try { await reader.cancel(); } catch { /* noop */ }
    }
    const cr = /\/(\d+)$/.exec(res.headers.get('content-range') || '');
    const cl = res.headers.get('content-length');
    return {
      ok: res.ok,
      status: res.status,
      bytes: bytes.subarray(0, n),
      contentType: res.headers.get('content-type') || '',
      total: cr ? Number(cr[1]) : res.status === 200 && cl ? Number(cl) : null,
      acceptRanges: res.status === 206 || (res.headers.get('accept-ranges') || '') === 'bytes',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** True when a complete moov box inside the peeked bytes has an audio track and no video track. */
function moovAudioOnly(u8) {
  const s = new TextDecoder('latin1').decode(u8);
  const i = s.indexOf('moov');
  if (i < 4) return null;
  const size = (u8[i - 4] << 24 | u8[i - 3] << 16 | u8[i - 2] << 8 | u8[i - 1]) >>> 0;
  if (!size || i - 4 + size > u8.length) return null;
  const moov = s.slice(i, i - 4 + size);
  const video = moov.includes('vide');
  const audio = moov.includes('soun');
  return audio && !video ? true : video ? false : null;
}

/** Probe a single file: peek the first bytes for the real format; HEAD only as a fallback. */
export async function probeProgressive(url, { headers = {} } = {}) {
  let p = null;
  try { p = await peek(url, { headers }); } catch { p = null; }
  let head = null;
  if (!p || !p.ok) {
    try { head = await fetchRaw(url, { method: 'HEAD', headers, timeoutMs: 12000 }); } catch { head = null; }
  }
  const ok = !!(p?.ok || head?.ok);
  const status = p && !p.ok ? p.status : head?.status;
  const bytes = p?.ok ? p.bytes : null;
  const contentType = p?.contentType || head?.contentType || '';
  const sn = bytes && bytes.length >= 4 ? sniff(bytes) : null;
  const ext = bytes ? detectExt({ bytes, contentType, urlExt: '' }) : detectExt({ bytes: null, contentType, urlExt: '' });
  const audioOnly = (ext && ['m4a', 'mp3', 'aac', 'ogg', 'flac', 'wav', 'opus'].includes(ext)) || (bytes && ext === 'mp4' ? moovAudioOnly(bytes) === true : false);
  return {
    ok,
    reason: ok ? null : status === 403 || status === 401 ? 'auth_expired' : 'segment_unavailable',
    contentLength: p?.total ?? head?.contentLength ?? null,
    acceptRanges: p?.acceptRanges || head?.acceptRanges || false,
    contentType,
    sniff: sn,
    ext: audioOnly && ext === 'mp4' ? 'm4a' : ext,
    audioOnly: !!audioOnly,
    duration: null,
  };
}

function parseTotal(cr) {
  const m = /\/(\d+)$/.exec(cr || '');
  return m ? Number(m[1]) : null;
}

const BACKOFF = [1000, 3000, 9000];

/**
 * Ambil segmen: fetch boleh paralel terbatas, penulisan WAJIB berurutan.
 * onSegment(index, bytes) dipanggil urut 0..n-1.
 */
export async function fetchSegments(inventory, {
  concurrency = 5,
  retries = 3,
  headers = {},
  signal = null,
  onProgress = () => {},
  onPhase = () => {},
  refresh = null, // () => Promise<inventory|null> untuk URL segar sebelum retry terakhir
  shouldPause = () => false,
  resumeFrom = 0,
  writeSegment = async () => {},
}) {
  const segments = inventory.segments || [];
  const total = segments.length;
  const buffer = new Map();
  const failed = new Map();
  let nextFetch = resumeFrom;
  let nextWrite = resumeFrom;
  let bytesReceived = 0;
  let inFlight = 0;
  let current = inventory;
  let paused = false;
  let aborted = false;
  let lastProgress = 0;

  const report = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgress < 250) return; // maks ~4 update/detik
    lastProgress = now;
    onProgress({ segIndex: nextWrite, segCount: total, bytes: bytesReceived });
  };

  const grab = async (index) => {
    let seg = current.segments[index];
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (aborted) throw new Error('canceled');
      try {
        const res = await fetchRaw(seg.url, { range: seg.range, headers, timeoutMs: 30000, signal });
        if (!res.ok) {
          if ((res.status === 403 || res.status === 401 || res.status === 410) && refresh && attempt < retries) {
            const fresh = await refresh();
            if (fresh && fresh.segments[index]) {
              current = fresh;
              seg = current.segments[index];
              continue; // coba lagi dengan URL segar
            }
          }
          throw new HttpError(res.status, seg.url);
        }
        const expected = seg.range ? seg.range[1] - seg.range[0] + 1 : res.contentLength;
        if (expected != null && res.bytes.length !== expected && res.status === 200 && !seg.range) {
          // panjang tidak cocok dengan Content-Length: coba sekali lagi
          if (attempt < retries) { lastErr = new Error('length_mismatch'); continue; }
        }
        const sn = sniff(res.bytes);
        if (['html', 'json'].includes(sn.kind)) throw new Error('not_media');
        return res.bytes;
      } catch (e) {
        lastErr = e;
        if (aborted || (signal && signal.aborted)) throw new Error('canceled');
        if (attempt < retries) {
          if (attempt === retries - 1 && refresh) {
            const fresh = await refresh();
            if (fresh) current = fresh;
          }
          await sleep(BACKOFF[Math.min(attempt, BACKOFF.length - 1)]);
        }
      }
    }
    throw lastErr || new Error('segment_unavailable');
  };

  const writer = (async () => {
    while (nextWrite < total) {
      if (aborted) throw new Error('canceled');
      while (shouldPause()) { paused = true; await sleep(300); if (aborted) throw new Error('canceled'); }
      paused = false;
      if (!buffer.has(nextWrite)) { await sleep(40); continue; }
      const bytes = buffer.get(nextWrite);
      buffer.delete(nextWrite);
      await onSegmentWrite(nextWrite, bytes);
      bytesReceived += bytes.length;
      nextWrite++;
      report();
    }
  })();

  const onSegmentWrite = async (index, bytes) => writeSegment(index, bytes);

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, async () => {
    while (true) {
      if (aborted) return;
      while (shouldPause()) { await sleep(300); if (aborted) return; }
      const index = nextFetch++;
      if (index >= total) return;
      inFlight++;
      try {
        const bytes = await grab(index);
        buffer.set(index, bytes);
      } catch (e) {
        failed.set(index, e);
        aborted = true;
        throw e;
      } finally {
        inFlight--;
        report();
      }
    }
  });

  onPhase('downloading');
  report(true);
  const result = await Promise.allSettled([...workers, writer]);
  const rej = result.find((r) => r.status === 'rejected');
  report(true);
  if (rej) {
    const e = rej.reason;
    if (String(e?.message) === 'canceled') throw Object.assign(new Error('canceled'), { reason: 'canceled' });
    if (e instanceof HttpError && (e.status === 403 || e.status === 401 || e.status === 410)) throw Object.assign(e, { reason: 'auth_expired' });
    if (String(e?.message) === 'not_media') throw Object.assign(e, { reason: 'segment_unavailable' });
    throw Object.assign(e, { reason: failed.size ? 'segment_unavailable' : 'canceled' });
  }
  return { bytesReceived, count: nextWrite };
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
