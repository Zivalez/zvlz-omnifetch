/* Minimal ISO-BMFF box reader: verify file header, duration, fragmentation, and sidx. */

export function iterBoxes(u8, start = 0, end = u8.length) {
  const out = [];
  let off = start;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  while (off + 8 <= end) {
    let size = dv.getUint32(off);
    let header = 8;
    let large = false;
    if (size === 1) {
      if (off + 16 > end) break;
      size = Number(dv.getBigUint64(off + 8));
      header = 16;
      large = true;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header || off + size > end + 8) break;
    const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
    out.push({ type, offset: off, size, headerSize: header, dataOffset: off + header, large });
    off += size;
  }
  return out;
}

export function findBox(u8, path) {
  let boxes = iterBoxes(u8);
  let found = null;
  for (const name of path) {
    found = boxes.find((b) => b.type === name);
    if (!found) return null;
    if (name !== path[path.length - 1]) boxes = iterBoxes(u8, found.dataOffset, found.offset + found.size);
  }
  return found;
}

function readMvhdDuration(u8, box) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = box.dataOffset;
  const version = u8[p];
  p += 4;
  let timescale, duration;
  if (version === 1) {
    p += 16;
    timescale = dv.getUint32(p); p += 4;
    duration = Number(dv.getBigUint64(p)); p += 8;
  } else {
    p += 8;
    timescale = dv.getUint32(p); p += 4;
    duration = dv.getUint32(p); p += 4;
  }
  return { timescale, duration: timescale ? duration / timescale : 0 };
}

/** MP4/WebM header info for post-assembly verification (Chapter 7). */
export function mp4Info(u8) {
  const info = { ok: false, container: null, fragmented: false, duration: null, hasMoov: false, hasMdat: false, boxes: [] };
  if (u8.length >= 12 && u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) {
    info.container = 'mp4';
  } else if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) {
    info.container = 'webm';
    info.ok = true;
    info.hasMoov = true; // EBML header equivalent exists
    return info;
  } else {
    return info;
  }
  const top = iterBoxes(u8);
  info.boxes = top.map((b) => b.type);
  const moov = top.find((b) => b.type === 'moov');
  info.hasMoov = !!moov;
  info.hasMdat = top.some((b) => b.type === 'mdat');
  info.fragmented = top.some((b) => b.type === 'moof') || (moov ? iterBoxes(u8, moov.dataOffset, moov.offset + moov.size).some((b) => b.type === 'mvex') : false);
  if (moov) {
    const mvhd = iterBoxes(u8, moov.dataOffset, moov.offset + moov.size).find((b) => b.type === 'mvhd');
    if (mvhd) info.duration = readMvhdDuration(u8, mvhd).duration;
  }
  info.ok = info.hasMoov && (info.hasMdat || info.fragmented);
  return info;
}

/** Parse sidx (SegmentBase) -> list of segments as byte ranges + durations. */
export function parseSidx(u8) {
  const box = findBox(u8, ['sidx']) || (() => {
    const top = iterBoxes(u8);
    return top.find((b) => b.type === 'sidx') || null;
  })();
  if (!box) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = box.dataOffset;
  const version = u8[p];
  p += 4; // version+flags
  p += 4; // reference_ID
  const timescale = dv.getUint32(p); p += 4;
  let earliest, offset;
  if (version === 1) {
    earliest = Number(dv.getBigUint64(p)); p += 8;
    offset = Number(dv.getBigUint64(p)); p += 8;
  } else {
    earliest = dv.getUint32(p); p += 4;
    offset = dv.getUint32(p); p += 4;
  }
  p += 2; // reserved
  const count = dv.getUint16(p); p += 2;
  const segs = [];
  let cursor = offset;
  let time = earliest;
  for (let i = 0; i < count && p + 12 <= u8.length; i++) {
    const ref = dv.getUint32(p); p += 4;
    const size = ref & 0x7fffffff;
    const isRef = (ref >>> 31) === 1;
    const dur = dv.getUint32(p); p += 4;
    p += 4; // SAP
    if (!isRef) {
      segs.push({ range: [cursor, cursor + size - 1], duration: dur / (timescale || 1) });
    }
    cursor += size;
    time += dur;
  }
  return { timescale, segments: segs, earliestPresentationTime: earliest };
}
