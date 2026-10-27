/* Penyimpanan: cache per tab (session, URL+metadata saja), prefs & riwayat (local). */
import { DEFAULT_TEMPLATE } from '../engine/naming.js';

export const PREF_DEFAULTS = {
  concurrency: 5,
  retries: 3,
  maxAssembleBytes: 1_500_000_000,
  audioLang: '',
  showAllImages: false,
  hideBelowPx: 100,
  template: DEFAULT_TEMPLATE,
  useCookies: true,
  notify: true,
  dataSaver: false,
  maxResolution: null,
  conflictAction: 'uniquify',
};

const tabKey = (tabId) => `tab:${tabId}`;
const invKey = (tabId, variantId) => `inv:${tabId}:${variantId}`;

export async function getTabCache(tabId) {
  const r = await chrome.storage.session.get(tabKey(tabId));
  return r[tabKey(tabId)] || null;
}

export async function setTabCache(tabId, cache) {
  await chrome.storage.session.set({ [tabKey(tabId)]: cache });
}

export async function patchTabCache(tabId, patch) {
  const cur = (await getTabCache(tabId)) || emptyCache(tabId);
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  await setTabCache(tabId, next);
  return next;
}

export function emptyCache(tabId) {
  return {
    tabId,
    page: { url: null, title: null, host: null, favicon: null },
    candidates: { net: [], dom: [], hook: [] },
    items: [],
    analyzing: false,
    updatedAt: Date.now(),
  };
}

export async function clearTabCache(tabId) {
  const keys = [tabKey(tabId)];
  const all = await chrome.storage.session.get(null);
  for (const k of Object.keys(all)) {
    if (k.startsWith(`inv:${tabId}:`) || k.startsWith(`job:${tabId}:`)) keys.push(k);
  }
  await chrome.storage.session.remove(keys);
}

export async function setInventory(tabId, variantId, inv) {
  await chrome.storage.session.set({ [invKey(tabId, variantId)]: inv });
}

export async function getInventory(tabId, variantId) {
  const r = await chrome.storage.session.get(invKey(tabId, variantId));
  return r[invKey(tabId, variantId)] || null;
}

export async function getPrefs() {
  const r = await chrome.storage.local.get('prefs');
  return { ...PREF_DEFAULTS, ...(r.prefs || {}) };
}

export async function setPrefs(patch) {
  const cur = await getPrefs();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ prefs: next });
  return next;
}

export async function getHistory() {
  const r = await chrome.storage.local.get('history');
  return r.history || [];
}

export async function pushHistory(rec) {
  const list = await getHistory();
  list.unshift(rec);
  await chrome.storage.local.set({ history: list.slice(0, 200) });
}

export async function updateHistory(jobId, patch) {
  const list = await getHistory();
  const i = list.findIndex((h) => h.jobId === jobId);
  if (i >= 0) {
    list[i] = { ...list[i], ...patch };
    await chrome.storage.local.set({ history: list });
  }
}

export async function clearHistory() {
  await chrome.storage.local.set({ history: [] });
}

/* ---- state job berjalan (session; token URL diperlakukan rahasia) ---- */
export async function getJobs() {
  const r = await chrome.storage.session.get('jobs');
  return r.jobs || {};
}

export async function setJob(job) {
  const jobs = await getJobs();
  jobs[job.id] = { ...jobs[job.id], ...job };
  await chrome.storage.session.set({ jobs });
  return jobs[job.id];
}

export async function removeJob(id) {
  const jobs = await getJobs();
  delete jobs[id];
  await chrome.storage.session.set({ jobs });
}
