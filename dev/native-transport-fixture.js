// Deterministic bytes replace the network, not the transport/resolver/downloader.
// No logged-in Bilibili account or paid quality is needed for these lifecycle tests.
(() => {
  const originalFetch = window.fetch.bind(window);
  const f = window.__transportFixture = { requests: [], responses: [], badHosts: new Set(), live: 0, peak: 0, delay: 20, fault: "", actions: [], segments: [] };
  window.addEventListener("error", event => { document.title = `ERROR: ${event.message}`; });
  window.addEventListener("unhandledrejection", event => { document.title = `REJECTION: ${event.reason}`; });
  f.url = id => `https://upos-sz-mirrorali.bilivideo.com/upgcxcode/test/${id}.m4s?deadline=1`;
  f.reps = [80, 116, 120, 64, 32, 16, 30280].map(id => ({ id, baseUrl: f.url(id), mimeType: "video/mp4", codecs: "avc1.640028" }));
  f.playinfo = { data: { dash: { video: f.reps.slice(0, -1), audio: [{ ...f.reps.at(-1), mimeType: "audio/mp4" }] } } };
  history.replaceState(null, "", "/video/BV1quality001");
  window.__INITIAL_STATE__ = { videoData: { bvid: "BV1quality001", cid: 101 } };
  window.__playinfo__ = f.playinfo;
  f.quality = { nowQ: 80, newQ: 80 };
  window.player = { getQuality: () => ({ ...f.quality }) };
  const video = document.querySelector("video");
  video.load = () => f.actions.push("load");
  video.pause = () => f.actions.push("pause");
  video.play = () => { f.actions.push("play"); return Promise.resolve(); };
  new MutationObserver(records => { for (const record of records) if (record.attributeName === "src") f.actions.push("src"); }).observe(video, { attributes: true });
  window.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = { createNativePlayer() { throw new Error("custom MSE engine must not be used"); } };
  const factory = window.__BILI_IDM_DOWNLOADER_FACTORY__;
  window.__BILI_IDM_DOWNLOADER_FACTORY__ = { createDownloader(options) {
    const real = factory.createDownloader(options);
    return { async downloadRange(range, resolver, request) {
      if (f.fault === "silent") {
        return new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
      }
      if (f.fault) {
        if (f.fault === "partial") await request.onOrderedChunk(Uint8Array.from({ length: 2 }, (_, i) => (range.start + i) % 251), { start: range.start, length: 2 }, 8388608);
        throw new Error("injected download failure");
      }
      return real.downloadRange(range, resolver, request);
    } };
  } };
  // A native (non-intercepted) XHR still exercises the browser's real lifecycle.
  // Route this one fixture request to a local resource instead of an external CDN.
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    return open.call(this, method, f.localNativeXHR && String(url).includes("bilivideo.com") ? "/manifest.json" : url, ...args);
  };
  window.fetch = async (input, init = {}) => {
    const req = input instanceof Request ? input : null;
    const url = req?.url || String(input);
    if (!url.includes("bilivideo.com")) return originalFetch(input, init);
    const headers = new Headers(init.headers || req?.headers);
    const range = window.__BILI_RANGE_CORE__.parseRangeHeader(headers.get("range")) || { start: 0, end: 7, length: 8 };
    const signal = init.signal || req?.signal;
    const item = { url, range, credentials: init.credentials || req?.credentials, at: performance.now() };
    f.requests.push(item);
    if (signal?.aborted) throw signal.reason;
    f.live++; f.peak = Math.max(f.peak, f.live);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(done, typeof f.delay === "function" ? f.delay(range, item) : f.delay);
        function done() { signal?.removeEventListener("abort", cancel); resolve(); }
        function cancel() { clearTimeout(timer); signal?.removeEventListener("abort", cancel); item.aborted = true; reject(signal.reason); }
        signal?.addEventListener("abort", cancel, { once: true });
      });
      if (f.badHosts.has(new URL(url).hostname)) return new Response(null, { status: 403 });
      if (f.nativeResponse) {
        const response = f.nativeResponse(item, signal);
        f.responses.push(response);
        return response;
      }
      const bytes = Uint8Array.from({ length: range.length }, (_, i) => (i + range.start) % 251);
      const response = new Response(bytes, { status: 206, statusText: "Partial Content", headers: { "content-range": `bytes ${range.start}-${range.end}/8388608`, "content-length": String(range.length) } });
      Object.defineProperty(response, "url", { value: url });
      f.responses.push(response);
      return response;
    } finally { f.live--; }
  };
})();
