// Runs wherever the userscript manager puts the script. The accelerator itself has to run in
// the bilibili page, so pageCode is started there. The manager's menu only sends a page
// event that opens the settings panel.
const LOADED = "data-btr-userscript";
const pageWindow = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;

function injected() {
  return document.documentElement?.hasAttribute(LOADED) === true;
}

function inject() {
  const source = `(${pageCode})();`;
  // Prefer the manager's own injection, which also works on pages with a strict CSP.
  if (typeof GM_addElement === "function") {
    try { GM_addElement(document.documentElement, "script", { textContent: source })?.remove?.(); }
    catch (_error) {}
  }
  if (injected()) return;
  const script = document.createElement("script");
  script.textContent = source;
  document.documentElement.append(script);
  script.remove();
  if (!injected()) console.error("BTR: 无法在页面里启动线程撕裂者");
}

if (pageWindow === window) pageCode();
else if (document.documentElement) inject();
else {
  const observer = new MutationObserver(() => {
    if (!document.documentElement) return;
    observer.disconnect();
    inject();
  });
  observer.observe(document, { childList: true });
}

if (typeof GM_registerMenuCommand === "function") {
  GM_registerMenuCommand("线程撕裂者设置", () => document.dispatchEvent(new CustomEvent("btr-userscript-open-settings")));
}
