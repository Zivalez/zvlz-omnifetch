/*
 * Parser HLS (RFC 8216) murni, tanpa dependensi.
 * Multivariant (master) dan media playlist dipisahkan tegas; keduanya tidak boleh tertukar.
 */
import { resolveUrl, canonKey } from './url.js';

export function parseAttrs(raw) {
  const out = {};
  const s = String(raw);
  let i = 0;
  while (i < s.length) {
    const eq = s.indexOf('=', i);
    if (eq === -1) break;
    const key = s.slice(i, eq).trim();
    let j = eq + 1;
    let value;
    if (s[j] === '"') {
      j++;
      let buf = '';
      while (j < s.length && s[j] !== '"') { buf += s[j]; j++; }
      value = buf;
      j++;
    } else {
      let buf = '';
      while (j < s.length && s[j] !== ',') { buf += s[j]; j++; }
      value = buf;
    }
    if (key) out[key] = value;
    i = j + 1;
  }
  return out;
}

const DRM_KEYFORMATS = [
  'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', // Widevine
  'com.apple.streamingkeydelivery',                 // FairPlay
  'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95', // PlayReady
  'com.microsoft.playready',
];

function splitLines(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n');
}

export function parseM3u8(text, baseUrl) {
  const lines = splitLines(text);
  if (!lines.length || lines[0].trim() !== '#EXTM3U') return { ok: false, error: 'manifest_parse_error' };

  const master = { variants: [], media: [] };
  const media = {
    endlist: false,
    playlistType: null,
    targetDuration: null,
    mediaSequence: 0,
    version: null,
    hasParts: false,
    discontinuities: 0,
    segments: [],
    keys: [],
    initUris: [],
    durationSum: 0,
  };
  let isMaster = false;

  let pending = null; // atribut untuk URI berikutnya
  let curKey = null;
  let curInit = null;
  let curByterange = null;
  let byterangeOffset = 0;
  let seq = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (!line.startsWith('#')) {
      const uri = resolveUrl(baseUrl, line);
      if (!uri) continue;
      if (isMaster && pending && pending.tag === 'STREAM-INF') {
        master.variants.push({
          uri,
          bandwidth: Number(pending.a.BANDWIDTH || 0),
          resolution: pending.a.RESOLUTION ? pending.a.RESOLUTION.split('x').map(Number) : null,
          codecs: pending.a.CODECS || null,
          audioGroup: pending.a.AUDIO || null,
          subtitleGroup: pending.a.SUBTITLES || null,
          frameRate: pending.a['FRAME-RATE'] ? Number(pending.a['FRAME-RATE']) : null,
          videoRange: pending.a['VIDEO-RANGE'] || null,
        });
        pending = null;
      } else if (isMaster && pending && pending.tag === 'MEDIA') {
        const a = pending.a;
        master.media.push({
          type: a.TYPE, uri, groupId: a['GROUP-ID'], name: a.NAME,
          lang: a.LANGUAGE || null,
          isDefault: a.DEFAULT === 'YES',
          autoSelect: a.AUTOSELECT === 'YES',
          channels: a.CHANNELS || null,
        });
        pending = null;
      } else if (!isMaster) {
        if (curInit && !media.initUris.includes(canonKey(curInit.uri))) media.initUris.push(canonKey(curInit.uri));
        let range = curByterange || null;
        if (range && range.length != null && range.offset == null) {
          range = { length: range.length, offset: byterangeOffset };
          curByterange = range;
        }
        if (range && range.offset != null) byterangeOffset = range.offset + range.length;
        media.segments.push({
          uri,
          duration: pending && pending.tag === 'INF' ? pending.dur : 0,
          sequence: media.mediaSequence + seq,
          byterange: range,
          key: curKey,
          init: curInit,
          discontinuityBefore: pending && pending.tag === 'DISC',
        });
        seq++;
        media.durationSum += (pending && pending.tag === 'INF' ? pending.dur : 0);
        pending = null;
        curByterange = null;
      }
      continue;
    }

    const tagMatch = /^#(EXT[^:]*):?(.*)$/.exec(line);
    if (!tagMatch) continue;
    const tag = tagMatch[1];
    const rest = tagMatch[2] || '';

    switch (tag) {
      case 'EXT-X-STREAM-INF': {
        isMaster = true;
        pending = { tag: 'STREAM-INF', a: parseAttrs(rest) };
        break;
      }
      case 'EXT-X-MEDIA': {
        isMaster = true;
        const a = parseAttrs(rest);
        master.media.push({type:a.TYPE,uri:a.URI?resolveUrl(baseUrl,a.URI):null,groupId:a['GROUP-ID'],name:a.NAME,lang:a.LANGUAGE||null,isDefault:a.DEFAULT==='YES',autoSelect:a.AUTOSELECT==='YES'});
        pending = null;
        break;
      }
      case 'EXTINF': {
        pending = { tag: 'INF', dur: Number(rest.split(',')[0]) || 0 };
        break;
      }
      case 'EXT-X-BYTERANGE': {
        const [len, off] = rest.split('@').map(Number);
        curByterange = { length: len, offset: off === undefined || Number.isNaN(off) ? null : off };
        pending = pending || { tag: 'INF', dur: 0 };
        break;
      }
      case 'EXT-X-TARGETDURATION': media.targetDuration = Number(rest); break;
      case 'EXT-X-MEDIA-SEQUENCE': media.mediaSequence = Number(rest) || 0; seq = 0; break;
      case 'EXT-X-PLAYLIST-TYPE': media.playlistType = rest.toUpperCase(); break;
      case 'EXT-X-VERSION': media.version = Number(rest); break;
      case 'EXT-X-ENDLIST': media.endlist = true; break;
      case 'EXT-X-DISCONTINUITY': media.discontinuities++; pending = { tag: 'DISC' }; break;
      case 'EXT-X-PART':
      case 'EXT-X-PART-INF':
      case 'EXT-X-SERVER-CONTROL':
      case 'EXT-X-SKIP':
        media.hasParts = true; break;
      case 'EXT-X-KEY': {
        const a = parseAttrs(rest);
        const method = (a.METHOD || 'NONE').toUpperCase();
        const keyFormat = (a.KEYFORMAT || 'identity').toLowerCase();
        if (method === 'NONE') { curKey = null; break; }
        const rec = {
          method,
          uri: a.URI ? resolveUrl(baseUrl, a.URI) : null,
          iv: a.IV || null,
          keyFormat,
          drm: method.startsWith('SAMPLE-AES') || DRM_KEYFORMATS.includes(keyFormat),
        };
        media.keys.push(rec);
        curKey = rec;
        break;
      }
      case 'EXT-X-MAP': {
        const a = parseAttrs(rest);
        let range = null;
        if (a.BYTERANGE) {
          const [len, off] = a.BYTERANGE.split('@').map(Number);
          range = { length: len, offset: Number.isNaN(off) ? null : off };
        }
        curInit = { uri: resolveUrl(baseUrl, a.URI), byterange: range };
        break;
      }
      default: break;
    }
  }

  return {
    ok: true,
    isMaster,
    master,
    media,
    drm: {
      sampleAes: media.keys.some((k) => k.method.startsWith('SAMPLE-AES')),
      cencKeyFormat: media.keys.some((k) => k.keyFormat !== 'identity' && DRM_KEYFORMATS.includes(k.keyFormat)),
      aes128: media.keys.some((k) => k.method === 'AES-128'),
    },
    live: isMaster ? false : !media.endlist,
  };
}

/** Playlist media dianggap VOD hanya bila ada ENDLIST (bukti), bukan sekadar PLAYLIST-TYPE. */
export function isVod(parsedMediaPlaylist) {
  return parsedMediaPlaylist.ok && !parsedMediaPlaylist.isMaster && parsedMediaPlaylist.media.endlist === true;
}
