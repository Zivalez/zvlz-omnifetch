/*
 * Assembly decision tree (Chapter 8), all inside the browser:
 * Q1 progressive -> copy as-is
 * Q2 fMP4       -> concatenate init + segments (lossless, no ffmpeg)
 * Q3 HLS TS     -> transmux to MP4 (codecs intact) via MediaBunny
 * Q4 split tracks -> mux without re-encoding via two composable Conversions
 * Q5 transcode  -> MediaBunny/WebCodecs first; ffmpeg.wasm is a separate tier that is
 *                  not bundled in this build -> honest codec_unsupported reason
 */
import { mp4Info } from '../engine/mp4box.js';

const MB = () => globalThis.Mediabunny;

export function assemblySupported() {
  return !!MB();
}

function formatFor(container) {
  const M = MB();
  switch (container) {
    case 'webm': return new M.WebMOutputFormat();
    case 'mkv': return new M.MkvOutputFormat();
    case 'opus': return new M.OggOutputFormat();
    case 'ogg': return new M.OggOutputFormat();
    case 'mp3': return new M.Mp3OutputFormat();
    case 'flac': return new M.FlacOutputFormat();
    case 'm4a':
    case 'mp4':
    default: return new M.Mp4OutputFormat();
  }
}

async function runConversion(input, output, opts = {}) {
  const M = MB();
  const conv = await M.Conversion.init({ input, output, ...opts });
  await conv.execute();
  return conv;
}

/** Q3: MPEG-TS -> MP4 (transmux, codecs intact). */
export async function transmuxTs(tsBlob) {
  const M = MB();
  const input = new M.Input({ source: new M.BlobSource(tsBlob), formats: [M.MPEG_TS] });
  const output = new M.Output({ format: formatFor('mp4'), target: new M.BufferTarget() });
  await runConversion(input, output);
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}

/** Q4: two separate tracks (video + audio) -> one container, without re-encoding. */
export async function muxTracks(videoBlob, audioBlob, container) {
  const M = MB();
  const vin = new M.Input({ source: new M.BlobSource(videoBlob), formats: M.ALL_FORMATS });
  const ain = new M.Input({ source: new M.BlobSource(audioBlob), formats: M.ALL_FORMATS });
  const output = new M.Output({ format: formatFor(container), target: new M.BufferTarget() });
  const c1 = await M.Conversion.init({ input: vin, output, audio: { discard: true }, composable: true });
  const c2 = await M.Conversion.init({ input: ain, output, video: { discard: true }, composable: true });
  await output.start();
  await Promise.all([c1.execute(), c2.execute()]);
  await output.finalize();
  const buf = output.target.buffer;
  const type = container === 'webm' ? 'video/webm' : container === 'mkv' ? 'video/x-matroska' : 'video/mp4';
  return new Blob([buf], { type });
}

/** Copy a single track (audio-only / video-only) to the target container. */
export async function copyTrack(blob, container, { keep = 'audio' } = {}) {
  const M = MB();
  const input = new M.Input({ source: new M.BlobSource(blob), formats: M.ALL_FORMATS });
  const output = new M.Output({ format: formatFor(container), target: new M.BufferTarget() });
  const opts = keep === 'audio' ? { video: { discard: true } } : { audio: { discard: true } };
  await runConversion(input, output, opts);
  const type = container === 'webm' ? 'audio/webm' : container === 'opus' ? 'audio/opus' : container === 'mp3' ? 'audio/mpeg' : 'audio/mp4';
  return new Blob([output.target.buffer], { type });
}

/** Post-assembly verification (Chapter 7): file header + duration within one segment of tolerance. */
export async function verifyBlob(blob, { duration = null, toleranceSec = 8, container = 'mp4' } = {}) {
  try {
    const M=MB();
    const input=new M.Input({source:new M.BlobSource(blob),formats:M.ALL_FORMATS});
    const tracks=await input.getTracks();
    const actual=await input.computeDuration();
    if(!tracks.length || !Number.isFinite(actual) || actual <= 0) return {ok:false,reason:'assembly_unverified'};
    if(duration && Math.abs(actual-duration)>toleranceSec) return {ok:false,reason:'assembly_unverified',detail:'Output duration does not match the manifest.'};
    return {ok:true,duration:actual};
  } catch {return {ok:false,reason:'assembly_unverified'};}
}

/** Memory/size guard: honest extension-only limit (Chapter 13). */
export function checkLimits(totalBytes, maxBytes) {
  const deviceMemoryGb = globalThis.navigator?.deviceMemory || null;
  if (maxBytes && totalBytes > maxBytes) return { ok: false, reason: 'too_large' };
  if (deviceMemoryGb && totalBytes > deviceMemoryGb * 0.9 * 1024 * 1024 * 1024) return { ok: false, reason: 'too_large' };
  return { ok: true };
}
