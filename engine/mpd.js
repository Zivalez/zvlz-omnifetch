/*
 * Parser MPEG-DASH (ISO/IEC 23009-1) murni: tanpa DOMParser eksternal supaya
 * bisa diuji di Node dan tetap jalan di offscreen document.
 * Menangani SegmentList, SegmentTemplate (+ SegmentTimeline), SegmentBase (sidx),
 * pewarisan BaseURL di semua level, dan deteksi ContentProtection.
 */
import { resolveUrl } from './url.js';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENT[g] ?? m;
  });
}

/** Parser XML kecil dan toleran, cukup untuk MPD. */
export function parseXml(text) {
  const s = String(text);
  const root = { name: '#doc', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<\?[^>]*\?>|<\/([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1] !== undefined) { stack[stack.length - 1].text += m[1]; continue; }
    if (m[2]) { // tutup
      const name = m[2];
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === name || stack[i].name.endsWith(':' + name)) { stack.length = i; break; }
      }
      continue;
    }
    if (m[3]) { // buka
      const name = m[3];
      const attrs = {};
      const are = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = are.exec(m[4] || ''))) attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? '');
      const node = { name, attrs, children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      if (!m[5]) stack.push(node);
      continue;
    }
    if (m[6] !== undefined) { stack[stack.length - 1].text += decodeEntities(m[6]); }
  }
  return root;
}

export function q(node, name) {
  if (!node) return null;
  return node.children.find((c) => c.name === name || c.name.endsWith(':' + name)) || null;
}
export function qa(node, name) {
  if (!node) return [];
  return node.children.filter((c) => c.name === name || c.name.endsWith(':' + name));
}

export function parseIsoDuration(d) {
  if (!d) return null;
  const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(d).trim());
  if (!m) return null;
  const [_, Y, M, W, D, H, MI, S] = m.map((x) => (x === undefined ? 0 : Number(x)));
  return Y * 31557600 + M * 2629800 + W * 604800 + D * 86400 + H * 3600 + MI * 60 + S;
}

const DRM_UUIDS = [
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', // Widevine
  '9a04f079-9840-4286-ab92-e65be0885f95', // PlayReady
  '94ce86fb-07ff-4f43-adb8-93d2fa968ca2', // FairPlay
  'e2719d58-a985-b3c9-781a-b030af78d30e', // ClearKey (dianggap aman)
];

function expandTemplate(tpl, ctx, num, time) {
  return tpl
    .replace(/\$\$/g, '\u0000')
    .replace(/\$RepresentationID\$/g, ctx.representationId ?? '')
    .replace(/\$Bandwidth\$/g, String(ctx.bandwidth ?? 0))
    .replace(/\$Number(?:%0(\d+)d)?\$/g, (mm, pad) => (pad ? String(num).padStart(Number(pad), '0') : String(num)))
    .replace(/\$Time\$/g, String(time ?? 0))
    .replace(/\u0000/g, '$');
}

/** Perluas daftar segmen satu Representation menjadi array {uri, range, duration, number, time}. */
export function expandSegments(rep, periodDuration) {
  const info = rep.segmentInfo;
  if (!info) return { kind: 'none', segments: [] };
  const ctx = { representationId: rep.id, bandwidth: rep.bandwidth };
  const out = [];

  if (info.kind === 'list') {
    (info.entries || []).forEach((e, i) => {
      out.push({
        uri: resolveUrl(info.baseUrl, expandTemplate(e.media || '', ctx, info.startNumber + i, null)),
        range: e.range || null,
        duration: (e.duration ?? info.duration ?? 0) / (info.timescale || 1),
        number: info.startNumber + i,
        time: null,
      });
    });
    return { kind: 'list', segments: out, init: info.init ? resolveUrl(info.baseUrl, expandTemplate(info.init, ctx, info.startNumber, null)) : null };
  }

  if (info.kind === 'template') {
    const init = info.init ? resolveUrl(info.baseUrl, expandTemplate(info.init, ctx, info.startNumber, null)) : null;
    if (info.timeline && info.timeline.length) {
      let t = info.timeline[0].t ?? 0;
      let num = info.startNumber;
      for (const s of info.timeline) {
        const st = s.t ?? t;
        const repeat = s.r || 0;
        for (let k = 0; k <= repeat; k++) {
          const time = st + k * s.d;
          out.push({
            uri: resolveUrl(info.baseUrl, expandTemplate(info.media || '', ctx, num, time)),
            range: null,
            duration: s.d / (info.timescale || 1),
            number: num,
            time,
          });
          num++;
        }
        t = st + (repeat + 1) * s.d;
      }
      return { kind: 'template', segments: out, init };
    }
    if (info.duration && info.timescale) {
      const segDur = info.duration / info.timescale;
      const total = periodDuration || rep.durationHint || 0;
      const count = total > 0 ? Math.ceil(total / segDur) : 0;
      for (let i = 0; i < count; i++) {
        out.push({
          uri: resolveUrl(info.baseUrl, expandTemplate(info.media || '', ctx, info.startNumber + i, null)),
          range: null,
          duration: segDur,
          number: info.startNumber + i,
          time: i * info.duration,
        });
      }
      return { kind: 'template', segments: out, init };
    }
    return { kind: 'template', segments: out, init, incomplete: true };
  }

  if (info.kind === 'base') {
    return { kind: 'base', segments: [], init: resolveUrl(info.baseUrl, rep.id ? '' : ''), indexRange: info.indexRange, wholeFile: resolveUrl(info.baseUrl, '') };
  }
  return { kind: 'none', segments: [] };
}

export function parseMpd(text, baseUrl) {
  const doc = parseXml(text);
  const mpd = q(doc, 'MPD');
  if (!mpd) return { ok: false, error: 'manifest_parse_error' };

  const type = mpd.attrs.type === 'dynamic' ? 'dynamic' : 'static';
  const mpdBaseUrl = resolveUrl(baseUrl, q(mpd, 'BaseURL')?.text.trim() || baseUrl);
  const mediaDuration = parseIsoDuration(mpd.attrs.mediaPresentationDuration);

  const periods = qa(mpd, 'Period').map((pNode) => {
    const periodBase = resolveUrl(mpdBaseUrl, q(pNode, 'BaseURL')?.text.trim() || mpdBaseUrl);
    const period = {
      id: pNode.attrs.id || null,
      start: parseIsoDuration(pNode.attrs.start) || 0,
      duration: parseIsoDuration(pNode.attrs.duration) || null,
      adaptationSets: [],
    };
    for (const asNode of qa(pNode, 'AdaptationSet')) {
      const asBase = resolveUrl(periodBase, q(asNode, 'BaseURL')?.text.trim() || periodBase);
      const mimeType = asNode.attrs.mimeType || '';
      const contentType = asNode.attrs.contentType
        || (mimeType.startsWith('video') ? 'video' : mimeType.startsWith('audio') ? 'audio' : mimeType.startsWith('text') || mimeType.includes('vtt') ? 'text' : null);
      const as = {
        id: asNode.attrs.id || null,
        contentType: contentType || (asNode.attrs.codecs ? (asNode.attrs.codecs.startsWith('mp4a') || asNode.attrs.codecs.startsWith('opus') ? 'audio' : 'video') : null),
        mimeType,
        lang: asNode.attrs.lang || null,
        label: q(asNode, 'Label')?.text.trim() || null,
        codecs: asNode.attrs.codecs || null,
        width: asNode.attrs.width ? Number(asNode.attrs.width) : null,
        height: asNode.attrs.height ? Number(asNode.attrs.height) : null,
        frameRate: asNode.attrs.frameRate || null,
        roles: qa(asNode, 'Role').map((r) => r.attrs.value),
        contentProtection: qa(asNode, 'ContentProtection').map((cp) => ({
          schemeIdUri: (cp.attrs.schemeIdUri || '').toLowerCase(),
          value: cp.attrs.value || null,
          drm: DRM_UUIDS.includes((/urn:uuid:([0-9a-f-]+)/i.exec(cp.attrs.schemeIdUri || '') || [])[1]?.toLowerCase() || '')
            && !(/urn:uuid:([0-9a-f-]+)/i.exec(cp.attrs.schemeIdUri || '') || [])[1]?.toLowerCase().startsWith('e2719d58'),
        })),
        representations: [],
      };

      const asTemplate = q(asNode, 'SegmentTemplate');
      const asList = q(asNode, 'SegmentList');
      const asBaseSeg = q(asNode, 'SegmentBase');

      for (const repNode of qa(asNode, 'Representation')) {
        const repBase = resolveUrl(asBase, q(repNode, 'BaseURL')?.text.trim() || asBase);
        const rep = {
          id: repNode.attrs.id,
          bandwidth: Number(repNode.attrs.bandwidth || 0),
          width: repNode.attrs.width ? Number(repNode.attrs.width) : as.width,
          height: repNode.attrs.height ? Number(repNode.attrs.height) : as.height,
          codecs: repNode.attrs.codecs || as.codecs,
          frameRate: repNode.attrs.frameRate || as.frameRate,
          sampleRate: repNode.attrs.audioSamplingRate ? Number(repNode.attrs.audioSamplingRate) : null,
          channels: q(repNode, 'AudioChannelConfiguration')?.attrs.value || q(asNode, 'AudioChannelConfiguration')?.attrs.value || null,
          mimeType: repNode.attrs.mimeType || mimeType,
          segmentInfo: null,
          durationHint: period.duration || mediaDuration,
        };

        const tpl = q(repNode, 'SegmentTemplate') || asTemplate;
        const list = q(repNode, 'SegmentList') || asList;
        const baseSeg = q(repNode, 'SegmentBase') || asBaseSeg;

        if (tpl) {
          const timelineNode = q(tpl, 'SegmentTimeline');
          const timeline = timelineNode ? qa(timelineNode, 'S').map((s) => ({
            t: s.attrs.t !== undefined ? Number(s.attrs.t) : null,
            d: Number(s.attrs.d || 0),
            r: s.attrs.r !== undefined ? Number(s.attrs.r) : 0,
          })) : null;
          rep.segmentInfo = {
            kind: 'template',
            baseUrl: repBase,
            media: tpl.attrs.media,
            init: tpl.attrs.initialization,
            timescale: Number(tpl.attrs.timescale || 1),
            duration: tpl.attrs.duration !== undefined ? Number(tpl.attrs.duration) : null,
            startNumber: Number(tpl.attrs.startNumber || 1),
            timeline,
          };
        } else if (list) {
          rep.segmentInfo = {
            kind: 'list',
            baseUrl: repBase,
            init: q(list, 'Initialization')?.attrs.sourceURL || null,
            timescale: Number(list.attrs.timescale || 1),
            duration: list.attrs.duration !== undefined ? Number(list.attrs.duration) : null,
            startNumber: Number(list.attrs.startNumber || 0),
            entries: qa(list, 'SegmentURL').map((su) => ({
              media: su.attrs.media,
              range: su.attrs.mediaRange ? su.attrs.mediaRange.split('-').map(Number) : null,
            })),
          };
        } else if (baseSeg) {
          rep.segmentInfo = {
            kind: 'base',
            baseUrl: repBase,
            indexRange: baseSeg.attrs.indexRange ? baseSeg.attrs.indexRange.split('-').map(Number) : null,
            initRange: q(baseSeg, 'Initialization')?.attrs.range || null,
            timescale: Number(baseSeg.attrs.timescale || 1),
          };
        }
        as.representations.push(rep);
      }
      period.adaptationSets.push(as);
    }
    return period;
  });

  for (const p of periods) for (const a of p.adaptationSets) for (const c of a.contentProtection) c.drm=true;
  const hasDrm = periods.some((p) => p.adaptationSets.some((a) => a.contentProtection.length));
  return { ok: true, type, mediaDuration, periods, drm: hasDrm, baseUrl: mpdBaseUrl };
}
