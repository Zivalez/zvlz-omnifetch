/*
 * Service worker: ORCHESTRATOR only (Chapter 4).
 * No DOM, no createObjectURL; heavy work lives in the offscreen document.
 */
import { isActiveTab, refreshActiveTab, active } from './active-tab.js';
import {
  getTabCache, patchTabCache, emptyCache, clearTabCache, setInventory, getInventory,
  getPrefs, setPrefs, getHistory, clearHistory, getJobs, removeJob, pushHistory,
} from './store.js';
import { installWebRequest } from './webrequest.js';
import { ensureOffscreen, offscreen, closeOffscreenIfIdle } from './offscreen-client.js';
import { startJob, controlJob, progressFromOffscreen, failJob, completeJob, directDownload, reconcileAfterRestart, ensureKeepalive, applyHeaderRule, releaseHeaderRule } from './jobs.js';
import { canonKey, hostOf, originOf } from '../engine/url.js';
import { applyTemplate } from '../engine/naming.js';
import { hashId } from '../engine/gate.js';

/* ---------- boot ---------- */
chrome.runtime.onInstalled.addListener(async () => {
  await reconcileAfterRestart();
  buildContextMenus();
});
chrome.runtime.onStartup.addListener(async () => {
  await refreshActiveTab();
  await reconcileAfterRestart();
  buildContextMenus();
});
refreshActiveTab();

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepalive') {
    const jobs = await getJobs();
    const running = Object.values(jobs).some((j) => j.status === 'running' || j.status === 'saving');
    if (!running) { await ensureKeepalive(false); return; }
    try { await ensureOffscreen(); await offscreen({ t: 'ping' }, 3000); } catch { /* the worker will wake again on the next event */ }
  }
});

/* ---------- active tab scope ---------- */
chrome.tabs.onActivated.addListener(async () => { await refreshActiveTab(); broadcast(); });
chrome.windows.onFocusChanged.addListener(async (wid) => {
  if (wid === chrome.windows.WINDOW_ID_NONE) return;
  await refreshActiveTab(); broadcast();
});
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (!isActiveTab(tabId)) return;
  if (change.url) {
    // Same-document navigation (SPA) must not wipe what is already listed.
    const cur = await getTabCache(tabId);
    const page = { ...(cur?.page || {}), ...pageMetaFromTab(change.url, change.title ?? cur?.page?.title), favicon: cur?.page?.favicon || null };
    await patchTabCache(tabId, { page });
    requestDomRescan(tabId);
    broadcast();
  } else if (change.title || change.favIconUrl) {
    const cur = await getTabCache(tabId);
    const page = { ...(cur?.page || {}), title: change.title ?? cur?.page?.title, favicon: change.favIconUrl ?? cur?.page?.favicon };
    const patch = { page };
    if (change.title && cur?.navAt && cur.page?.title !== change.title) {
      patch.items = (cur.items || []).map((i) => (i.firstSeen >= cur.navAt && i.title === cur.page?.title ? { ...i, title: change.title } : i));
    }
    await patchTabCache(tabId, patch);
    broadcast();
  }
});
chrome.tabs.onRemoved.addListener(async (tabId) => { await clearTabCache(tabId); });
chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  if (!isActiveTab(d.tabId)) return;
  await clearTabCache(d.tabId);
  await patchTabCache(d.tabId, { ...emptyCache(d.tabId), page: pageMetaFromTab(d.url) });
  broadcast();
});
chrome.webNavigation.onHistoryStateUpdated.addListener(async (d) => {
  if (d.frameId !== 0 || !isActiveTab(d.tabId)) return;
  const cur = await getTabCache(d.tabId);
  await patchTabCache(d.tabId, { ...(cur || emptyCache(d.tabId)), page: { ...(cur?.page || {}), ...pageMetaFromTab(d.url, cur?.page?.title) }, navAt: Date.now() });
  requestDomRescan(d.tabId);
  broadcast();
});

function pageMetaFromTab(url, title) {
  return {
    url: url || null,
    title: title || null,
    host: hostOf(url) || null,
    favicon: null,
  };
}

/* ---------- network sensor (layer 1) ---------- */
installWebRequest((tabId, list) => { addCandidates(tabId, list, 'net'); });

/* ---------- messages from content scripts (layers 2 and 3) ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.to === 'offscreen' || msg.t === 'state:changed') return false;
  handle(msg, sender).then(sendResponse).catch((e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

async function handle(msg, sender) {
  const tabId = sender.tab?.id;

  if (msg.to === 'offscreen') return undefined; // not for the worker

  switch (msg.t) {
    case 'detect:dom': {
      if (tabId == null || !isActiveTab(tabId)) return { ok: false }; // second guard
      if (sender.tab?.status === 'unloaded') return { ok: false };
      await addCandidates(tabId, msg.items || [], 'dom', msg.page || null);
      return { ok: true };
    }
    case 'detect:hook': {
      if (tabId == null || !isActiveTab(tabId)) return { ok: false };
      await addCandidates(tabId, msg.items || [], 'hook');
      return { ok: true };
    }
    case 'detect:youtube': {
      if (tabId == null || !isActiveTab(tabId)) return { ok: false };
      const cur = (await getTabCache(tabId)) || emptyCache(tabId);
      const hook = cur.candidates.hook.filter((c) => c.kind !== 'youtube');
      hook.push({ kind: 'youtube', formats: msg.formats, ts: Date.now() });
      await patchTabCache(tabId, { candidates: { ...cur.candidates, hook } });
      clearTimeout(analyzeTimers.get(tabId));
      analyzeTimers.set(tabId, setTimeout(() => runAnalysis(tabId), 400));
      return { ok: true };
    }
    case 'ui:hello': {
      await refreshActiveTab();
      if (active.tabId != null) requestDomRescan(active.tabId);
      return { ok: true, state: await buildState() };
    }
    case 'ui:state':
      return { ok: true, state: await buildState() };
    case 'ui:rescan': {
      await refreshActiveTab();
      if (active.tabId != null) {
        requestDomRescan(active.tabId);
        await runAnalysis(active.tabId, { force: true });
      }
      return { ok: true, state: await buildState() };
    }
    case 'job:start': {
      const tab = active.tabId;
      const inv = await getInventory(tab, msg.variantId);
      if (!inv) return { ok: false, error: 'inventory_missing' };
      const cache = await getTabCache(tab);
      const item = cache?.items?.find((i) => i.id === msg.itemId);
      const variant = item?.variants?.find((v) => v.id === msg.variantId);
      if (!variant || !variant.eligible) return { ok: false, error: 'not_eligible' };
      const fileName = buildFileName(item, variant, msg.mode, cache);
      const jobId = await startJob({
        tabId: tab, itemId: msg.itemId, variantId: msg.variantId, mode: msg.mode,
        fileName, inv, itemTitle: item?.title, page: cache?.page,
      });
      return { ok: true, jobId, state: await buildState() };
    }
    case 'job:control': {
      const jobs = await getJobs();
      const job = jobs[msg.jobId];
      const alive = !!job && ['running', 'saving'].includes(job.status);
      let res = null;
      if (alive) {
        try { res = await controlJob(msg.jobId, msg.action); } catch { res = null; }
      } else if (msg.action === 'pause' || msg.action === 'resume') {
        return { ok: false, error: 'This download is no longer running.', state: await buildState() };
      }
      if ((msg.action === 'cancel' || msg.action === 'dismiss') && job) {
        await releaseHeaderRule(job.ruleId);
        await removeJob(msg.jobId);
      }
      return { ok: true, res, state: await buildState() };
    }
    case 'images:download': {
      const tab = active.tabId;
      const cache = await getTabCache(tab);
      const entries = [];
      for (const id of msg.itemIds || []) {
        const item = cache?.items?.find((i) => i.id === id);
        const inv = item?.variants?.[0] ? await getInventory(tab, item.variants[0].id) : null;
        if (inv?.urls?.length) entries.push({ title: item.title, urls: inv.urls });
      }
      if (!entries.length) return { ok: false, error: 'empty' };
      await ensureOffscreen();
      const fileName = `${applyTemplate('{title} · {date}', { title: cache?.page?.title || 'image', date: Date.now() })}.zip`;
      const res = await offscreen({ t: 'images:zip', entries, zipMode: msg.zipMode || 'zip', fileName });
      if (msg.zipMode === 'zip' && res?.blobUrl) {
        await saveBlobAsJob(res.blobUrl, fileName, res.size, tab, 'zip');
      } else if (Array.isArray(res?.files)) {
        for (const f of res.files) await saveBlobAsJob(f.blobUrl, f.name, f.size, tab, 'image');
      }
      return { ok: true, state: await buildState() };
    }
    case 'sub:download': {
      await ensureOffscreen();
      const res = await offscreen({ t: 'sub:fetch', urls: msg.urls, fileName: msg.fileName });
      if (res?.blobUrl) await saveBlobAsJob(res.blobUrl, msg.fileName, res.size, active.tabId, 'subtitle');
      return { ok: true, state: await buildState() };
    }
    case 'rec:start': {
      const tab = active.tabId;
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab });
      const jobId = `rec:${Date.now().toString(36)}`;
      await chrome.storage.session.set({ [`rec:${jobId}`]: { tabId: tab, fileName: msg.fileName, startedAt: Date.now() } });
      await ensureOffscreen();
      await offscreen({ t: 'rec:start', jobId, streamId, fileName: msg.fileName });
      return { ok: true, jobId, state: await buildState() };
    }
    case 'rec:stop': {
      await ensureOffscreen();
      const res = await offscreen({ t: 'rec:stop', jobId: msg.jobId });
      const rec = (await chrome.storage.session.get(`rec:${msg.jobId}`))[`rec:${msg.jobId}`];
      if (res?.blobUrl && rec) {
        await saveBlobAsJob(res.blobUrl, rec.fileName, res.size, rec.tabId, 'record');
      }
      await chrome.storage.session.remove(`rec:${msg.jobId}`);
      return { ok: true, state: await buildState() };
    }
    case 'staging:clear': {
      if (Object.values(await getJobs()).some(j => ['running','saving'].includes(j.status))) return { ok:false, error:'There are still active jobs. Cancel or wait until finished.' };
      await ensureOffscreen();
      return await offscreen({t:'staging:clear'});
    }
    case 'prefs:set': {
      await setPrefs(msg.patch || {});
      return { ok: true, state: await buildState() };
    }
    case 'history:clear':
      await clearHistory();
      return { ok: true, state: await buildState() };
    case 'panel:open': {
      try { await chrome.sidePanel.open({ windowId: (await chrome.windows.getCurrent()).id }); } catch { /* noop */ }
      return { ok: true };
    }
    case 'job:progress':
      await progressFromOffscreen(msg);
      broadcast();
      return { ok: true };
    case 'job:done':
      await completeJob(msg.jobId, { blobUrl: msg.blobUrl, size: msg.size, ext: msg.ext });
      broadcast();
      return { ok: true };
    case 'job:direct':
      await directDownload(msg.jobId, { url: msg.url, size: msg.size, ext: msg.ext });
      broadcast();
      return { ok: true };
    case 'job:fail':
      await failJob(msg.jobId, msg.reason, msg.detail);
      broadcast();
      return { ok: true };
    case 'rec:progress':
      await chrome.storage.session.set({ [`recstate:${msg.jobId}`]: { bytes: msg.bytes, seconds: msg.seconds, startedAt: msg.startedAt } });
      broadcast();
      return { ok: true };
    case 'ctx:download': {
      const tab = msg.tabId ?? active.tabId;
      if (!msg.url) return { ok: false };
      await addCandidates(tab, [{ url: msg.url, kind: 'url' }], 'net');
      await runAnalysis(tab, { force: true });
      const cache = await getTabCache(tab);
      const item = cache?.items?.find((i) => i.variants?.[0]?.eligible);
      if (!item) return { ok: false, error: 'not_ready' };
      const v = item.variants[0];
      const inv = await getInventory(tab, v.id);
      const fileName = buildFileName(item, v, 'video', cache);
      const jobId = await startJob({ tabId: tab, itemId: item.id, variantId: v.id, mode: 'video', fileName, inv, itemTitle: item.title, page: cache?.page });
      return { ok: true, jobId };
    }
    default:
      return { ok: false, error: 'unknown_message' };
  }
}

/* ---------- candidate aggregation and analysis ---------- */
const analyzeTimers = new Map();
const rerun = new Set();

/** Keep items already shown (same position, same title); append newly found ones at the end. */
function mergeItems(prev, fresh) {
  const old = new Map((prev || []).map((i) => [i.id, i]));
  const seen = new Set();
  let next = Math.max(-1, ...(prev || []).map((i) => i.index ?? 0)) + 1;
  const out = [];
  const added = [];
  for (const i of fresh || []) {
    seen.add(i.id);
    const p = old.get(i.id);
    if (p) out.push({ ...i, title: p.title, posterUrl: p.posterUrl || i.posterUrl, index: p.index, firstSeen: p.firstSeen });
    else added.push(i);
  }
  for (const p of prev || []) if (!seen.has(p.id)) out.push(p);
  added.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  for (const i of added) out.push({ ...i, index: next++, firstSeen: Date.now() });
  return out.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}



async function addCandidates(tabId, list, source, page = null) {
  if (!Array.isArray(list) || !list.length) {
    if (page) await patchTabCache(tabId, { page: { ...(await getTabCache(tabId))?.page || {}, ...page } });
    return;
  }
  const cur = (await getTabCache(tabId)) || emptyCache(tabId);
  const bucket = { ...cur.candidates };
  const arr = [...(bucket[source] || [])];
  const seen = new Set(arr.map((c) => canonKey(c.url)));
  for (const c of list) {
    if (!c?.url) continue;
    const k = canonKey(c.url);
    if (seen.has(k)) continue;
    seen.add(k);
    arr.push({ ...c, url: c.url, kind: c.kind || 'url', ts: Date.now(), meta: c.meta || {} });
  }
  bucket[source] = arr.slice(-400);
  const patch = { candidates: bucket };
  if (page) patch.page = { ...cur.page, ...page };
  await patchTabCache(tabId, patch);

  clearTimeout(analyzeTimers.get(tabId));
  analyzeTimers.set(tabId, setTimeout(() => runAnalysis(tabId), 500));
}

async function runAnalysis(tabId, { force = false } = {}) {
  const cache = await getTabCache(tabId);
  if (!cache) return;
  const total = cache.candidates.net.length + cache.candidates.dom.length + cache.candidates.hook.length;
  if (total === 0 && !force) return;
  if (cache.analyzing && Date.now() - (cache.updatedAt || 0) < 120_000) { rerun.add(tabId); return; }
  await patchTabCache(tabId, { analyzing: true });
  broadcast();
  try {
    const prefs = await getPrefs();
    await ensureOffscreen();
    await applyHeaderRule(`analyze:${tabId}`, cache.page?.url, cache.candidates);
    const res = await offscreen({ t: 'analyze', tabId, candidates: cache.candidates, page: cache.page, prefs }, 90_000);
    const inventories = res?.inventories || {};
    for (const [variantId, inv] of Object.entries(inventories)) await setInventory(tabId, variantId, inv);
    const latest = await getTabCache(tabId);
    await patchTabCache(tabId, { items: mergeItems(latest?.items, res?.items), analyzing: false, lastAnalysisAt: Date.now() });
  } catch (e) {
    await patchTabCache(tabId, { analyzing: false, analysisError: String(e?.message || e) });
  }
  broadcast();
  if (rerun.delete(tabId)) setTimeout(() => runAnalysis(tabId), 300);
  setTimeout(() => closeOffscreenIfIdle(), 20_000);
}

function requestDomRescan(tabId) {
  try { chrome.tabs.sendMessage(tabId, { t: 'rescan' }, () => { void chrome.runtime.lastError; }); } catch { /* noop */ }
}

/* ---------- state for the UI ---------- */
async function buildState() {
  await refreshActiveTab();
  const tabId = active.tabId;
  const cache = tabId != null ? await getTabCache(tabId) : null;
  const jobs = await getJobs();
  const history = await getHistory();
  const prefs = await getPrefs();
  const recStates = {};
  if (tabId != null) {
    const all = await chrome.storage.session.get(null);
    for (const [k, v] of Object.entries(all)) if (k.startsWith('recstate:')) recStates[k.slice(9)] = v;
  }
  return {
    tab: active.meta,
    canInject: active.meta?.canInject ?? false,
    cache: cache ? { ...cache, candidates: undefined } : null,
    items: cache?.items || [],
    analyzing: !!cache?.analyzing,
    jobs: Object.values(jobs).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0)),
    recStates,
    history,
    prefs,
  };
}

function broadcast() {
  chrome.runtime.sendMessage({ t: 'state:changed' }, () => { void chrome.runtime.lastError; });
}

/* ---------- file names ---------- */
function buildFileName(item, variant, mode, cache) {
  const ext = variant.ext || variant.container || 'mp4';
  const ctx = {
    title: item?.title || cache?.page?.title || 'media',
    date: Date.now(),
    resolution: variant.resolution ? `${variant.resolution}p` : '',
    host: cache?.page?.host || '',
    index: item?.index ?? 0,
    quality: variant.resolution ? `${variant.resolution}p` : (variant.audioOnly || mode === 'audio' ? 'audio' : ''),
    lang: variant.audioLang || '',
  };
  return `${applyTemplate(getTemplateSync.value, ctx)}.${ext}`;
}
const getTemplateSync = { value: null };
getPrefs().then((p) => { getTemplateSync.value = p.template; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.prefs) getTemplateSync.value = changes.prefs.newValue?.template ?? getTemplateSync.value;
});

async function saveBlobAsJob(blobUrl, fileName, size, tabId, mode) {
  const prefs = await getPrefs();
  const id = await chrome.downloads.download({ url: blobUrl, filename: fileName, saveAs: false, conflictAction: prefs.conflictAction === 'overwrite' ? 'overwrite' : 'uniquify' });
  const listener = (delta) => {
    if (delta.id !== id) return;
    if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
      offscreen({ t: 'revoke', blobUrl }).catch(() => {});
      chrome.downloads.onChanged.removeListener(listener);
    }
  };
  chrome.downloads.onChanged.addListener(listener);
  await chrome.storage.local.get('history').then(async (r) => {

    await pushHistory({ jobId: `adhoc:${id}`, fileName, host: hostOf(fileName) || null, size: size || null, status: 'saved', mode, date: Date.now(), downloadId: id });
  });
  return id;
}

/* ---------- context menus ---------- */
function buildContextMenus() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'md-scan',
        title: 'Scan this tab for media',
        contexts: ['page', 'video', 'audio', 'image', 'link'],
      });
      chrome.contextMenus.create({
        id: 'md-download',
        title: 'Download this media',
        contexts: ['video', 'audio', 'image', 'link'],
      });
    });
  } catch { /* noop */ }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'md-scan') {
    await refreshActiveTab();
    requestDomRescan(tab?.id ?? active.tabId);
    await runAnalysis(tab?.id ?? active.tabId, { force: true });
    try { await chrome.sidePanel.open({ windowId: tab?.windowId }); } catch { /* noop */ }
  } else if (info.menuItemId === 'md-download') {
    const url = info.srcUrl || info.linkUrl;
    if (url) {
      await refreshActiveTab();
      chrome.runtime.sendMessage({ t: 'noop' }, () => {});
      const res = await handle({ t: 'ctx:download', url, tabId: active.tabId }, { tab: { id: active.tabId } });
      if (!res?.ok) {
        requestDomRescan(active.tabId);
        await runAnalysis(active.tabId, { force: true });
        try { await chrome.sidePanel.open({ windowId: tab?.windowId }); } catch { /* noop */ }
      }
    }
  }
});

/* close the offscreen document when idle, to be a good citizen */
chrome.alarms.create('idlecheck', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'idlecheck') closeOffscreenIfIdle(); });
