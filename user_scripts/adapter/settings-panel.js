// The extension's sidebar page (popup/popup.html, popup.css, popup.js), shown inside the
// bilibili page. The userscript manager's menu opens it; POPUP_HTML, POPUP_CSS and
// runPopup are filled in from the popup folder when the userscript is built.
(function installSettingsPanel() {
  "use strict";

  const HOST_ID = "__bilibili_thread_ripper_userscript_settings__";
  const DIALOG_ID = "__bilibili_thread_ripper_userscript_dialog__";
  const PANEL_STYLE = `
    .btr-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .35); }
    .btr-popup { position: fixed; top: 72px; right: 24px; width: 320px; max-width: calc(100vw - 32px); max-height: calc(100vh - 96px); overflow: auto; border: 1px solid #30343d; border-radius: 12px; box-shadow: 0 12px 40px rgba(0, 0, 0, .45); }
    .btr-popup main { min-height: 0; }
    .btr-close { position: sticky; bottom: 12px; display: block; width: calc(100% - 32px); margin: 0 16px 16px; padding: 8px; border: 1px solid #444b57; border-radius: 6px; background: #292d35; color: #d9dee8; font: inherit; font-size: 13px; cursor: pointer; box-shadow: 0 -6px 12px #17191f; }
    .btr-close:hover { border-color: #fb7299; }
    .btr-close:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  `;
  let current = null;

  function open() {
    if (current) return;
    // A modal <dialog> sits in the browser's top layer and is the only interactive part of
    // the page while it is open. A plain fixed layer can end up under the page's own
    // top-layer elements, or inside a part of the page made inert, and then clicks on it
    // land on whatever is beneath (issue #8).
    const dialog = document.createElement("dialog");
    dialog.id = DIALOG_ID;
    dialog.style.cssText = "all:initial!important;display:block!important;position:fixed!important;inset:0!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:visible!important;z-index:2147483646!important;";
    const dialogStyle = document.createElement("style");
    dialogStyle.textContent = `#${DIALOG_ID}::backdrop{background:transparent}`;
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;";
    dialog.append(dialogStyle, host);
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    // The sidebar styles its whole page; here the same rules apply to the floating panel.
    style.textContent = POPUP_CSS.replace(/^:root\s*\{/m, ".btr-popup {").replace(/^body\s*\{/m, ".btr-popup {") + PANEL_STYLE;
    const backdrop = document.createElement("div");
    backdrop.className = "btr-backdrop";
    const panel = document.createElement("div");
    panel.className = "btr-popup";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "线程撕裂者设置");
    panel.tabIndex = -1;
    panel.innerHTML = POPUP_HTML;
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "btr-close";
    closeButton.textContent = "关闭";
    panel.append(closeButton);
    shadow.append(style, backdrop, panel);

    // popup.js runs unchanged: its document is this panel, its tab is this page.
    const storageListeners = [], unloadListeners = [];
    const pageChrome = {
      storage: {
        sync: chrome.storage.sync,
        onChanged: { addListener(listener) { storageListeners.push(listener); chrome.storage.onChanged.addListener(listener); } }
      },
      tabs: {
        query: () => Promise.resolve([{ id: 1 }]),
        sendMessage: (_tabId, message) => chrome.runtime.dispatch(message)
      }
    };
    const pageWindow = { addEventListener(type, listener) { if (type === "unload") unloadListeners.push(listener); } };
    const onKey = (event) => { if (event.key === "Escape") close(); };
    const close = () => {
      if (current?.host !== host) return;
      current = null;
      for (const listener of unloadListeners) listener();
      for (const listener of storageListeners) chrome.storage.onChanged.removeListener(listener);
      document.removeEventListener("keydown", onKey, true);
      dialog.remove();
    };
    current = { host, close };
    backdrop.addEventListener("click", close);
    closeButton.addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);
    // Esc on a modal dialog closes it natively; clean up the same way as the button.
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    (document.body || document.documentElement).append(dialog);
    try { dialog.showModal(); }
    catch (_error) { dialog.setAttribute("open", ""); }
    runPopup(shadow, pageChrome, pageWindow);
    panel.focus();
  }

  document.addEventListener("btr-userscript-open-settings", () => (current ? current.close() : open()));
})();
