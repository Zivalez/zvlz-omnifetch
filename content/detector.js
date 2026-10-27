/*
 * Lapis 2 (sensor DOM) + jembatan lapis 3 (hook MAIN world).
 * ISOLATED world. Berhenti memindai saat tab tidak terlihat; penjaga kedua ada di worker.
 */
(() => {
  if (window.__mdDetector) return;
  window.__mdDetector = true;

  const isTop = window.top === window;
  let visible = document.visibilityState === 'visible';
  let pending = null;
  let flushTimer = null;
  const sentUrls = new Set();

  const runtime = () => (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id ? chrome.runtime : null);

  function pageMeta() {
    if (!isTop) return null;
    const iconLink = document.querySelector('link[rel~="icon"], link[rel~="shortcut"][rel~="icon"], link[rel="apple-touch-icon"]');
    const og = (name) => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content || null;
    return {
      title: document.title || null,
      url: location.href,
      favicon: iconLink ? new URL(iconLink.getAttribute('href'), location.href).href : `${location.origin}/favicon.ico`,
      ogImage: og('og:image'),
      ogVideo: og('og:video') || og('og:video:url') || og('twitter:player:stream'),
    };
  }

  function parseSrcset(value, baseUrl) {
    const out = [];
    if (!value) return out;
    for (const part of String(value).split(',')) {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) continue;
      let url;
      try { url = new URL(bits[0], baseUrl).href; } catch { continue; }
      const desc = bits[1] || '';
      const w = /w$/.test(desc) ? Number(desc.slice(0, -1)) : null;
      const x = /x$/.test(desc) ? Number(desc.slice(0, -1)) : null;
      out.push({ url, w, x: x || 1 });
    }
    return out;
  }

  function push(list, item) {
    if (!item?.url) return;
    const key = `${item.kind}:${item.url}`;
    if (sentUrls.has(key)) return;
    sentUrls.add(key);
    list.push(item);
  }

  function scan() {
    const items = [];
    // video & audio: currentSrc adalah sumber yang benar-benar dipilih browser
    const hint = (el) => {
      const scope = el.closest('figure, article, section, li, div');
      const t = scope && scope.querySelector('h1, h2, h3, h4, figcaption, [itemprop="name"]');
      return t && t.textContent ? t.textContent.trim().slice(0, 120) : null;
    };
    for (const el of document.querySelectorAll('video, audio')) {
      const url = el.currentSrc || el.src || el.querySelector('source')?.src || null;
      const sources = [...el.querySelectorAll('source')].map((s) => s.src).filter(Boolean);
      push(items, {
        url,
        kind: el.tagName === 'AUDIO' ? 'audio' : 'video',
        meta: {
          sources,
          poster: el.poster || null,
          duration: Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null,
          width: el.videoWidth || null,
          height: el.videoHeight || null,
          blob: !!url && url.startsWith('blob:'),
          titleHint: hint(el),
        },
      });
    }
    // gambar: satu entri per elemen, rendisi srcset dikelompokkan
    const imgs = document.querySelectorAll('img, picture source');
    for (const el of imgs) {
      const src = el.currentSrc || el.src || el.dataset.src || el.getAttribute('data-src') || null;
      const ss = parseSrcset(el.srcset || el.dataset.srcset || '', location.href);
      if (!src && !ss.length) continue;
      push(items, {
        url: src || ss[0]?.url,
        kind: 'image',
        meta: {
          renditions: ss.length ? ss : (src ? [{ url: src, w: null, x: 1 }] : []),
          width: el.naturalWidth || null,
          height: el.naturalHeight || null,
          alt: el.alt || el.getAttribute('title') || hint(el),
        },
      });
    }
    // lazy-load attributes
    for (const el of document.querySelectorAll('[data-src], [data-srcset]')) {
      if (el.tagName === 'IMG' || el.tagName === 'SOURCE') continue;
      const src = el.getAttribute('data-src');
      if (src) push(items, { url: new URL(src, location.href).href, kind: 'image', meta: { renditions: parseSrcset(el.getAttribute('data-srcset'), location.href), width: null, height: null } });
    }
    // CSS background-image di sekitar viewport (terbatas & di-cache per elemen)
    let checked = 0;
    for (const el of document.querySelectorAll('figure, div, section, header, article, a, span')) {
      if (checked++ > 250) break;
      const r = el.getBoundingClientRect();
      if (r.bottom < -200 || r.top > innerHeight + 200) continue;
      const bg = getComputedStyle(el).backgroundImage;
      const m = /url\(["']?(.*?)["']?\)/.exec(bg || '');
      if (m && m[1] && !m[1].startsWith('data:')) push(items, { url: new URL(m[1], location.href).href, kind: 'image', meta: { renditions: [], width: null, height: null, css: true } });
    }
    return items;
  }

  function send() {
    flushTimer = null;
    const r = runtime();
    if (!r || !visible) { pending = null; return; }
    const items = pending || [];
    pending = null;
    if (!items.length && !isTop) return;
    r.sendMessage({ t: 'detect:dom', items, page: pageMeta() }, () => { void chrome.runtime.lastError; });
  }

  function queueScan() {
    if (!visible) return;
    const found = scan();
    if (!found.length) return;
    pending = [...(pending || []), ...found];
    if (!flushTimer) flushTimer = setTimeout(send, 300);
  }

  // jeda saat tab tidak terlihat (aturan cakupan)
  document.addEventListener('visibilitychange', () => {
    visible = document.visibilityState === 'visible';
    if (visible) queueScan();
  });

  let moTimer = null;
  const mo = new MutationObserver(() => {
    if (!visible) return;
    if (moTimer) return;
    moTimer = setTimeout(() => { moTimer = null; queueScan(); }, 250); // throttle >= 250ms
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'data-src', 'data-srcset', 'poster'] });

  // jembatan MAIN world -> worker (hanya metadata, tidak pernah body respons)
  let hookBuf = [];
  let hookTimer = null;
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__md !== 1) return;
    if (!visible) return;
    const d = e.data;
    if (d.source === 'nav') { sentUrls.clear(); queueScan(); return; }
    if (d.source === 'youtube') {
      const r = runtime();
      if (r && d.formats?.length) r.sendMessage({ t: 'detect:youtube', formats: d.formats }, () => { void chrome.runtime.lastError; });
      return;
    }
    if (d.source === 'net' && d.url) {
      hookBuf.push({
        url: d.url,
        kind: /mpegurl|dash/.test(d.contentType || '') ? 'manifest' : 'url',
        meta: { contentType: d.contentType || null, status: d.status || null, contentLength: d.contentLength || null },
      });
    }
    if (!hookTimer) {
      hookTimer = setTimeout(() => {
        hookTimer = null;
        const r = runtime();
        const items = hookBuf; hookBuf = [];
        if (r && items.length) r.sendMessage({ t: 'detect:hook', items }, () => { void chrome.runtime.lastError; });
      }, 300);
    }
  });

  chrome.runtime.onMessage.addListener((msg, _s, respond) => {
    if (msg.t === 'rescan') { sentUrls.clear(); queueScan(); respond({ ok: true }); }
    return false;
  });

  window.addEventListener('load', () => queueScan());
  queueScan();
})();
