"use strict";

const BADGE_COLOR = "#fb7299";

function setThreadBadge(tabId, enabled, activeThreads) {
  if (!Number.isInteger(tabId)) return Promise.resolve();
  const count = Math.max(0, Math.min(512, Math.trunc(Number(activeThreads) || 0)));
  const text = enabled ? String(count) : "";
  return Promise.all([
    chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }),
    chrome.action.setBadgeText({ tabId, text })
  ]).catch((error) => console.error("无法更新线程徽标", error));
}

// 0.9.1.2 moves existing users once to mainland CDN, 8 threads and hidden error notices.
// Other settings are kept. A fresh install already starts with these defaults.
const SETTINGS_REVISION = 2;
async function migrateSettings() {
  const stored = await chrome.storage.sync.get(null);
  if (stored.settingsRevision === SETTINGS_REVISION) return;
  const existing = Object.keys(stored).some((key) => key !== "settingsRevision");
  await chrome.storage.sync.set({
    settingsRevision: SETTINGS_REVISION,
    ...(existing ? { mode: "mainland", concurrency: 8, errorNotices: false } : {})
  });
}

function prepareExtension() {
  migrateSettings().catch((error) => console.error("无法更新默认设置", error));
}

chrome.runtime.onInstalled.addListener(prepareExtension);
chrome.runtime.onStartup.addListener(prepareExtension);

// The settings open inside the bilibili page, the same panel as in the userscript. Other
// pages have no content script to answer, and nothing happens there.
chrome.action.onClicked.addListener((tab) => {
  if (!Number.isInteger(tab?.id)) return;
  chrome.tabs.sendMessage(tab.id, { type: "openSettings" }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "setThreadBadge") setThreadBadge(sender.tab?.id, message.enabled === true, message.activeThreads);
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") setThreadBadge(tabId, false, 0);
});
