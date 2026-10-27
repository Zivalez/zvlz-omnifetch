/*
 * Lazy download job lifecycle (Chapter 8): only born from an explicit click.
 * The service worker only orchestrates: job record, per-job DNR headers, chrome.downloads, frugal notifications.
 */
import { getJobs, setJob, removeJob, getPrefs, pushHistory, updateHistory } from './store.js';
import { ensureOffscreen, offscreen } from './offscreen-client.js';
import { hashId } from '../engine/gate.js';

const KEEPALIVE = 'keepalive';

export async function ensureKeepalive(on) {
  const has = await chrome.alarms.get(KEEPALIVE);
  if (on && !has) await chrome.alarms.create(KEEPALIVE, { periodInMinutes: 0.5 });
  if (!on && has) await chrome.alarms.clear(KEEPALIVE);
}

/** All hosts the job/analysis will touch (manifest, segments, init, keys). */
export function collectHosts(obj) {
  const hosts = new Set();
  const urls = JSON.stringify(obj || {}).match(/https?:\/\/[^"\\\s]+/g) || [];
  for (const u of urls) { try { hosts.add(new URL(u).hostname); } catch { /* noop */ } }
  return [...hosts].slice(0, 100);
}

/**
 * A fetch from the extension context carries no Referer and sends a chrome-extension:// Origin,
 * so a CDN replies 403 Forbidden. This session DNR rule sets the origin page's Referer/Origin
 * for extension-initiated requests to those media hosts.
 */
export async function applyHeaderRule(key, pageUrl, source) {
  try {
    if (!pageUrl || !/^https?:/i.test(pageUrl)) return null;
    const hosts = collectHosts(source);
    if (!hosts.length) return null;
    const origin = new URL(pageUrl).origin;
    const id = 1000 + (parseInt(hashId(String(key)), 16) % 8000);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [{
        id,
        priority: 2,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: pageUrl },
            { header: 'Origin', operation: 'set', value: origin },
          ],
        },
        condition: {
          requestDomains: hosts,
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: ['xmlhttprequest', 'media', 'other'],
        },
      }],
    });
    return id;
  } catch (e) {
    console.warn('applyHeaderRule failed', e);
    return null;
  }
}

export async function releaseHeaderRule(ruleId) { return detachHeaderRule(ruleId); }

async function detachHeaderRule(ruleId) {
  if (ruleId == null) return;
  try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }); } catch { /* noop */ }
}

export async function startJob({ tabId, itemId, variantId, mode = 'video', fileName, inv, itemTitle, page }) {
  const prefs = await getPrefs();
  const jobId = `job:${Date.now().toString(36)}:${hashId(variantId + mode)}`;
  const job = {
    id: jobId,
    tabId,
    itemId,
    variantId,
    mode,
    phase: 'manifest',
    segIndex: 0,
    segCount: inv?.video?.segments?.length || inv?.segments?.length || 1,
    bytes: 0,
    totalBytes: null,
    status: 'running',
    fileName,
    itemTitle,
    host: page?.host || null,
    startedAt: Date.now(),
    ruleId: null,
  };
  job.ruleId = await applyHeaderRule(jobId, page?.url, inv);
  const cookieHeader = null;
  await setJob(job);
  await ensureOffscreen();
  await ensureKeepalive(true);
  offscreen({ t: 'job:start', jobId, inv, prefs, fileName, page, cookieHeader }).catch((e) => failJob(jobId, 'segment_unavailable', String(e?.message || e)));
  return jobId;
}

export async function controlJob(jobId, action) {
  await ensureOffscreen();
  return offscreen({ t: 'job:control', jobId, action });
}

export async function progressFromOffscreen(msg) {
  const patch = { phase: msg.phase, segIndex: msg.segIndex, segCount: msg.segCount, bytes: msg.bytes, totalBytes: msg.totalBytes };
  await setJob({ id: msg.jobId, ...patch });
  return patch;
}

export async function failJob(jobId, reason, detail) {
  const jobs = await getJobs();
  const job = jobs[jobId];
  if (!job) return;
  await detachHeaderRule(job.ruleId);
  await setJob({ id: jobId, status: 'failed', reason, detail: String(detail || '').slice(0, 200), finishedAt: Date.now() });
  await updateHistory(jobId, { status: 'failed', reason, finishedAt: Date.now() });
  await notify(job, false, reason);
  await pruneKeepalive();
}

const EXT_GROUPS = [['mp4', 'm4a', 'm4v', 'mov', 'm4b'], ['jpg', 'jpeg'], ['heic', 'heif']];

/** Use the real format found in the downloaded bytes, unless it is the same family as the planned one. */
export function reconcileExt(fileName, realExt) {
  if (!realExt) return fileName;
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(fileName);
  const cur = m ? m[1].toLowerCase() : '';
  if (cur === realExt) return fileName;
  const same = EXT_GROUPS.some((g) => g.includes(cur) && g.includes(realExt));
  if (same) return fileName;
  return (m ? fileName.slice(0, -m[0].length) : fileName) + '.' + realExt;
}

export async function completeJob(jobId, { blobUrl, size, ext }) {
  const jobs = await getJobs();
  const job = jobs[jobId];
  if (!job) return;
  const prefs = await getPrefs();
  const fileName = reconcileExt(job.fileName, ext);
  await setJob({ id: jobId, phase: 'saving', status: 'saving', fileName });
  job.fileName = fileName;
  let downloadId = null;
  try {
    downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: fileName,
      saveAs: false,
      conflictAction: prefs.conflictAction === 'overwrite' ? 'overwrite' : 'uniquify',
    });
  } catch (e) {
    await failJob(jobId, 'segment_unavailable', String(e?.message || e));
    return;
  }
  await setJob({ id: jobId, downloadId, status: 'running' });
  // Revoke the object URL and release the staging files only after the
  // download has actually finished or failed. Releasing earlier can delete
  // the OPFS file backing a large blob while Chrome is still reading it.
  const listener = (delta) => {
    if (delta.id !== downloadId) return;
    if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
      offscreen({ t: 'revoke', blobUrl }).catch(() => {});
      offscreen({ t: 'job:release', jobId }).catch(() => {});
      chrome.downloads.onChanged.removeListener(listener);
    }
    if (delta.state?.current === 'complete') {
      finishSaved(jobId, size);
    }
    if (delta.state?.current === 'interrupted') {
      failJob(jobId, 'failed_midway', delta.error?.current || 'interrupted');
    }
  };
  chrome.downloads.onChanged.addListener(listener);
}

/**
 * Download a single file directly from its original URL, with no blob and
 * no staging in between. Chrome streams the server response straight to
 * disk, exactly like a normal browser download. Used for large passthrough
 * files that would otherwise spill to OPFS and be read back as a blob.
 */
export async function directDownload(jobId, { url, size, ext }) {
  const jobs = await getJobs();
  const job = jobs[jobId];
  if (!job) return;
  const prefs = await getPrefs();
  const fileName = reconcileExt(job.fileName, ext);
  await setJob({ id: jobId, phase: 'saving', status: 'saving', fileName });
  job.fileName = fileName;
  let downloadId = null;
  try {
    downloadId = await chrome.downloads.download({
      url,
      filename: fileName,
      saveAs: false,
      conflictAction: prefs.conflictAction === 'overwrite' ? 'overwrite' : 'uniquify',
    });
  } catch (e) {
    await failJob(jobId, 'segment_unavailable', String(e?.message || e));
    return;
  }
  await setJob({ id: jobId, downloadId, status: 'running' });
  const listener = (delta) => {
    if (delta.id !== downloadId) return;
    if (delta.state?.current === 'complete') {
      chrome.downloads.onChanged.removeListener(listener);
      finishSaved(jobId, size);
    }
    if (delta.state?.current === 'interrupted') {
      chrome.downloads.onChanged.removeListener(listener);
      failJob(jobId, 'failed_midway', delta.error?.current || 'interrupted');
    }
  };
  chrome.downloads.onChanged.addListener(listener);
}

async function finishSaved(jobId, size) {
  const jobs = await getJobs();
  const job = jobs[jobId];
  if (!job) return;
  await detachHeaderRule(job.ruleId);
  await setJob({ id: jobId, status: 'saved', phase: 'done', finishedAt: Date.now(), size });
  await pushHistory({
    jobId,
    fileName: job.fileName,
    host: job.host,
    size: size || null,
    duration: job.duration || null,
    status: 'saved',
    mode: job.mode,
    date: Date.now(),
    downloadId: job.downloadId ?? null,
    pageUrl: job.pageUrl || null,
  });
  await notify(job, true);
  await removeJob(jobId);
  await pruneKeepalive();
}

async function pruneKeepalive() {
  const jobs = await getJobs();
  const running = Object.values(jobs).some((j) => j.status === 'running' || j.status === 'saving');
  if (!running) await ensureKeepalive(false);
}

async function notify(job, ok, reason) {
  const prefs = await getPrefs();
  if (!prefs.notify) return;
  const long = Date.now() - job.startedAt > 60_000;
  if (ok && !long) return; // frugal: only long jobs and failures
  try {
    chrome.notifications.create(`md:${job.id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: ok ? 'Download complete' : 'Download failed',
      message: ok ? `${job.fileName} was saved.` : `${job.fileName}: ${reason || 'failed'}. No partial file was saved.`,
      priority: 0,
    });
  } catch { /* noop */ }
}

/** After a browser/extension restart: jobs are not silently resumed. */
export async function reconcileAfterRestart() {
  const jobs = await getJobs();
  for (const job of Object.values(jobs)) {
    if (job.status === 'running' || job.status === 'saving') {
      await detachHeaderRule(job.ruleId);
      await setJob({ id: job.id, status: 'failed', reason: 'session_restart', finishedAt: Date.now() });
      await updateHistory(job.id, { status: 'failed', reason: 'session_restart' });
    }
  }
  await ensureKeepalive(false);
}
