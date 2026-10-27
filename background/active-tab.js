/* Cakupan deteksi: hanya tab aktif (Bab 5). */
import { hostOf } from '../engine/url.js';

export const active = { tabId: null, meta: null };

export function faviconFromUrl(url) {
  try { return `${new URL(url).origin}/favicon.ico`; } catch { return null; }
}

export async function refreshActiveTab() {
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch { tab = null; }
  if (!tab) { active.tabId = null; active.meta = null; return null; }
  active.tabId = tab.id;
  active.meta = {
    id: tab.id,
    url: tab.url || null,
    title: tab.title || null,
    host: hostOf(tab.url) || null,
    favicon: tab.favIconUrl || faviconFromUrl(tab.url),
    canInject: !(tab.url || '').startsWith('chrome://') && !(tab.url || '').startsWith('chrome-extension://') && !(tab.url || '').startsWith('https://chromewebstore.google.com'),
  };
  return active.meta;
}

export function isActiveTab(tabId) {
  return tabId != null && tabId === active.tabId;
}
