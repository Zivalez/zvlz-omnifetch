/* Pembuatan & komunikasi offscreen document (satu per profil, alasan resmi). */

let creating = null;

export async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['BLOBS', 'DOM_PARSER', 'WORKERS'],
      justification: 'Parse manifest, fetch segmen berurutan, dekripsi AES-128, perakitan, dan pembuatan Blob untuk chrome.downloads.',
    }).finally(() => { creating = null; });
  }
  await creating;
}

export function offscreen(msg, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('offscreen_timeout')), timeoutMs);
    chrome.runtime.sendMessage({ ...msg, to: 'offscreen' }, (res) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (res && res.error) reject(new Error(res.error));
      else resolve(res);
    });
  });
}

export async function closeOffscreenIfIdle() {
  const jobs = await chrome.storage.session.get('jobs');
  const running = Object.values(jobs.jobs || {}).some((j) => j.status === 'running' || j.status === 'saving');
  if (running) return;
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length) {
    try { await offscreen({ t: 'close' }, 3000); } catch { /* noop */ }
  }
}
