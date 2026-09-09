"use strict";

const THREAD_OPTIONS = [4, 8, 16, 32, 64, 128];
const enabled = document.getElementById("enabled");
const debugNotices = document.getElementById("debug-notices");
const errorNotices = document.getElementById("error-notices");
const debugFilters = document.getElementById("debug-filters");
const debugCategoryInputs = [...document.querySelectorAll("[data-debug-category]")];
const concurrency = document.getElementById("concurrency");
const threadValue = document.getElementById("thread-value");
const sliderFill = document.getElementById("slider-fill");
const activeCount = document.getElementById("active-count");
let timer = null;

async function refresh() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("没有活动标签页");
    const response = await chrome.tabs.sendMessage(tab.id, { type: "getStatus" });
    activeCount.textContent = String(Math.max(0, Number(response?.stats?.activeThreads) || 0));
  } catch (_error) {
    activeCount.textContent = "0";
  }
}

function setSlider(threads) {
  const index = THREAD_OPTIONS.indexOf(Number(threads));
  const safe = index < 0 ? 3 : index;
  concurrency.value = String(safe);
  threadValue.value = String(THREAD_OPTIONS[safe]);
  concurrency.setAttribute("aria-valuetext", String(THREAD_OPTIONS[safe]));
  sliderFill.style.width = `${safe / (THREAD_OPTIONS.length - 1) * 100}%`;
}

async function init() {
  const stored = await chrome.storage.sync.get({ enabled: true, concurrency: 32, mode: "mainland", compatibilityMode: "off", debugNotices: false, errorNotices: true, debugCategories: {} });
  enabled.checked = stored.enabled !== false;
  debugNotices.checked = stored.debugNotices === true;
  debugFilters.hidden = !debugNotices.checked;
  debugNotices.addEventListener("change", () => {
    debugFilters.hidden = !debugNotices.checked;
    chrome.storage.sync.set({ debugNotices: debugNotices.checked });
  });
  for (const input of debugCategoryInputs) input.checked = stored.debugCategories?.[input.dataset.debugCategory] !== false;
  const saveDebugCategories = () => chrome.storage.sync.set({ debugCategories: Object.fromEntries(debugCategoryInputs.map(input => [input.dataset.debugCategory, input.checked])) });
  for (const input of debugCategoryInputs) input.addEventListener("change", saveDebugCategories);
  document.getElementById("debug-select-all").addEventListener("click", () => { for (const input of debugCategoryInputs) input.checked = true; saveDebugCategories(); });
  document.getElementById("debug-select-none").addEventListener("click", () => { for (const input of debugCategoryInputs) input.checked = false; saveDebugCategories(); });
  errorNotices.checked = stored.errorNotices !== false;
  errorNotices.addEventListener("change", () => chrome.storage.sync.set({ errorNotices: errorNotices.checked }));
  setSlider(stored.concurrency);
  const chosen = document.querySelector(`input[name="mode"][value="${stored.mode === "overseas" ? "overseas" : "mainland"}"]`);
  const compatibilityValue = ["off", "a", "b"].includes(stored.compatibilityMode) ? stored.compatibilityMode : "off";
  const compatibilityChosen = document.querySelector(`input[name="compatibility-mode"][value="${compatibilityValue}"]`);
  chosen.checked = true;
  compatibilityChosen.checked = true;
  await chrome.storage.sync.set({ enabled: enabled.checked, concurrency: THREAD_OPTIONS[Number(concurrency.value)], mode: chosen.value, compatibilityMode: compatibilityChosen.value });
  enabled.addEventListener("change", () => chrome.storage.sync.set({ enabled: enabled.checked }));
  concurrency.addEventListener("input", () => {
    const threads = THREAD_OPTIONS[Number(concurrency.value)];
    setSlider(threads);
    chrome.storage.sync.set({ concurrency: threads });
  });
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener("change", () => { if (radio.checked) chrome.storage.sync.set({ mode: radio.value }); });
  }
  for (const radio of document.querySelectorAll('input[name="compatibility-mode"]')) {
    radio.addEventListener("change", () => { if (radio.checked) chrome.storage.sync.set({ compatibilityMode: radio.value }); });
  }
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    if (changes.debugNotices) {
      debugNotices.checked = changes.debugNotices.newValue === true;
      debugFilters.hidden = !debugNotices.checked;
    }
    if (changes.debugCategories) for (const input of debugCategoryInputs) input.checked = changes.debugCategories.newValue?.[input.dataset.debugCategory] !== false;
    if (changes.errorNotices) errorNotices.checked = changes.errorNotices.newValue !== false;
    if (changes.enabled) enabled.checked = changes.enabled.newValue !== false;
    if (changes.compatibilityMode) {
      const next = ["off", "a", "b"].includes(changes.compatibilityMode.newValue) ? changes.compatibilityMode.newValue : "off";
      const radio = document.querySelector(`input[name="compatibility-mode"][value="${next}"]`);
      if (radio) radio.checked = true;
    }
  });
  await refresh();
  timer = setInterval(refresh, 400);
}

init();
window.addEventListener("unload", () => clearInterval(timer));
