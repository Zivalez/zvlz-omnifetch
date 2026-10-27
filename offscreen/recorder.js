/*
 * Record mode for non-DRM live streams / players without a manifest (Chapter 8).
 * tabCapture stream -> MediaRecorder in the offscreen document, always labeled as a partial capture.
 */
let rec = null;

function pickMime() {
  const cands = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const c of cands) {
    if (globalThis.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return null;
}

export async function startRecording({ streamId, onProgress }) {
  if (rec) throw new Error('recording_already_running');
  const mime = pickMime();
  if (!mime) throw new Error('recorder_unsupported');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60 } },
  });
  const context=new AudioContext();
  context.createMediaStreamSource(stream).connect(context.destination);
  const chunks = [];
  const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  const startedAt = Date.now();
  mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); onProgress({ bytes: chunks.reduce((a, c) => a + c.size, 0), seconds: Math.round((Date.now() - startedAt) / 1000), startedAt }); };
  rec = { mr, stream, chunks, mime, startedAt, context };
  mr.start(1000);
  return { mime, startedAt };
}

export async function stopRecording() {
  if (!rec) return null;
  const { mr, stream, chunks, mime, startedAt, context } = rec;
  rec = null;
  await new Promise((resolve) => {
    mr.onstop = resolve;
    if (mr.state !== 'inactive') mr.stop();
    else resolve();
  });
  await context.close();
  stream.getTracks().forEach((t) => t.stop());
  const blob = new Blob(chunks, { type: mime });
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  return { blob, ext, seconds: Math.round((Date.now() - startedAt) / 1000) };
}

export function recordingState() {
  return rec ? { running: true, startedAt: rec.startedAt } : { running: false };
}
