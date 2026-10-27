/*
 * Lapis 3: hook MAIN world di document_start.
 * Membungkus fetch & XHR, hanya meneruskan METADATA (URL, status, content-type)
 * lewat postMessage. Pembungkus selalu memanggil fungsi asli dan tidak menunda respons.
 */
(() => {
  if (window.__mdHook) return;
  window.__mdHook = true;

  const MEDIA = /\.(m3u8|mpd|m4s|mp4|m4v|m4a|mov|webm|mkv|mp3|aac|opus|oga|ogg|flac|wav)(?=$|[?#])/i;
  const post = (payload) => {
    try { window.postMessage({ __md: 1, ...payload }, '*'); } catch { /* noop */ }
  };
  const interesting = (url, ct) => MEDIA.test(url) || /mpegurl|dash\+xml|^video\/|^audio\//i.test(ct || '');

  // --- fetch ---
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      let url = null;
      try {
        url = typeof input === 'string' ? input : (input && input.url) || (input instanceof Request ? input.url : null);
        if (url) url = new URL(url, location.href).href;
      } catch { url = null; }
      const p = origFetch.apply(this, arguments);
      if (url) {
        p.then((res) => {
          try {
            const ct = res.headers ? res.headers.get('content-type') : null;
            const cl = res.headers ? res.headers.get('content-length') : null;
            if (interesting(url, ct)) post({ source: 'net', url, contentType: ct, status: res.status, contentLength: cl ? Number(cl) : null });
          } catch { /* metadata saja; jangan ganggu playback */ }
        }, () => {});
      }
      return p;
    };
  }

  // --- XHR ---
  const OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    const origOpen = OrigXHR.prototype.open;
    OrigXHR.prototype.open = function (method, url, ...rest) {
      try { this.__mdUrl = new URL(url, location.href).href; } catch { this.__mdUrl = null; }
      return origOpen.call(this, method, url, ...rest);
    };
    const origSend = OrigXHR.prototype.send;
    OrigXHR.prototype.send = function (...args) {
      if (this.__mdUrl) {
        this.addEventListener('load', () => {
          try {
            const ct = this.getResponseHeader('content-type');
            const cl = this.getResponseHeader('content-length');
            if (interesting(this.__mdUrl, ct)) post({ source: 'net', url: this.__mdUrl, contentType: ct, status: this.status, contentLength: cl ? Number(cl) : null });
          } catch { /* noop */ }
        });
      }
      return origSend.apply(this, args);
    };
  }

  // --- navigasi SPA ---
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    if (typeof orig === 'function') {
      history[fn] = function (...a) {
        const r = orig.apply(this, a);
        post({ source: 'nav' });
        return r;
      };
    }
  }
  window.addEventListener('popstate', () => post({ source: 'nav' }));

  // --- YouTube: baca respons player sebagai metadata format (fitur inti, Bab 13) ---
  const extract = (resp) => {
    try {
      const sd = resp && resp.streamingData;
      if (!sd) return null;
      const fmts = [...(sd.formats || []), ...(sd.adaptiveFormats || [])].map((f) => ({
        itag: f.itag,
        url: f.url || null,
        signatureCipher: f.signatureCipher || f.cipher || null,
        mimeType: f.mimeType || null,
        bitrate: f.bitrate || f.averageBitrate || null,
        width: f.width || null,
        height: f.height || null,
        durationMs: f.approxDurationMs ? Number(f.approxDurationMs) : (resp.videoDetails && resp.videoDetails.lengthSeconds ? Number(resp.videoDetails.lengthSeconds) * 1000 : null),
        audioQuality: f.audioQuality || null,
        qualityLabel: f.qualityLabel || null,
        hasAudio: !!f.audioQuality || /codecs="mp4a|codecs="opus/.test(f.mimeType || ''),
        hasVideo: !!f.width,
        initRange: f.initRange || null,
        indexRange: f.indexRange || null,
      }));
      return fmts.length ? fmts : null;
    } catch { return null; }
  };

  let lastSig = null;
  const reportYouTube = () => {
    const resp = window.ytInitialPlayerResponse || window.ytplayer?.config?.args?.raw_player_response || null;
    const formats = extract(resp);
    if (!formats) return;
    const sig = formats.map((f) => `${f.itag}:${f.url ? 'u' : 'c'}`).join(',');
    if (sig === lastSig) return;
    lastSig = sig;
    post({ source: 'youtube', formats });
  };

  try {
    let internal = null;
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get() { return internal; },
      set(v) {
        internal = v;
        setTimeout(reportYouTube, 0);
      },
    });
  } catch { /* halaman mungkin sudah mengunci properti ini */ }
  let tries = 0;
  const poll = setInterval(() => {
    reportYouTube();
    if (++tries > 40) clearInterval(poll);
  }, 750);
})();
