(async () => {
  const f = window.__transportFixture, result = document.getElementById("native-transport-result");
  const steps = {};
  const check = (name, condition) => {
    steps[name] = !!condition;
    document.title = `Checking: ${name}`;
    result.textContent = JSON.stringify({ running: true, steps });
    if (!condition) throw new Error(name);
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await wait(10); } throw new Error("wait timed out"); };
  const settings = (enabled, extra = {}) => window.postMessage({ channel: "__BILI_RANGE_ACCELERATOR_V1__", type: "settings", payload: { enabled, mode: "mainland", concurrency: 8, ...extra } }, "*");
  const get = (id, signal, range = "bytes=123-524410") => fetch(f.url(id), { headers: { Range: range }, signal });
  const valid = (bytes, start = 123, length = 524288) => bytes.byteLength === length && new Uint8Array(bytes).every((byte, i) => byte === (i + start) % 251);
  const xhr = (id, range = "bytes=123-524410") => {
    const x = new XMLHttpRequest(), events = [], states = [], progress = [];
    for (const type of ["loadstart", "load", "error", "timeout", "abort", "loadend"]) x.addEventListener(type, () => events.push(type));
    x.addEventListener("readystatechange", () => states.push(x.readyState));
    x.addEventListener("progress", event => progress.push([event.loaded, event.total, performance.now()]));
    x.open("GET", f.url(id)); x.responseType = "arraybuffer"; x.setRequestHeader("Range", range);
    return { x, events, states, progress, done: new Promise(resolve => x.addEventListener("loadend", resolve, { once: true })) };
  };
  try {
    settings(true);
    await until(() => window.__biliThreadRipperDebug?.getPlayer());
    const player = __biliThreadRipperDebug.getPlayer();
    check("native factory selected", player.nativeTransport === true);
    f.delay = 5;
    f.fault = "partial"; // Fetch must never use the multipart downloader.
    const beforeFetch = f.requests.length, response = await get(80);
    const copy = response.clone();
    check("fetch returns the actual native Response", f.responses.includes(response));
    check("fetch and clone contain complete native bytes", valid(await response.arrayBuffer()) && valid(await copy.arrayBuffer()));
    check("fetch preserves the original range", f.requests.slice(beforeFetch).every(item => item.range.length === 524288));
    f.fault = "";
    f.delay = range => range.start === 123 ? 20 : 180;
    const request = xhr(116); request.x.send(); await request.done;
    check("XHR event order and status", request.events.join() === "loadstart,load,loadend" && request.states[0] === 1 && request.states[1] === 2 && request.states.at(-1) === 4 && request.x.status === 206);
    check("XHR progressive bytes", request.progress.length > 1 && request.progress[0][0] < request.progress[0][1] && valid(request.x.response));
    check("XHR response headers", request.x.responseURL === f.url(116) && request.x.getResponseHeader("Content-Range") === "bytes 123-524410/8388608" && request.x.getAllResponseHeaders().includes("content-length:"));
    let doubleSend = false; try { request.x.send(); } catch (error) { doubleSend = error.name === "InvalidStateError"; }
    check("XHR rejects second send without open", doubleSend);
    request.x.open("GET", "/manifest.json"); request.x.responseType = "text";
    await new Promise((resolve, reject) => { request.x.onload = resolve; request.x.onerror = reject; request.x.send(); });
    check("XHR reuse restores native getters", request.x.status === 200 && JSON.parse(request.x.responseText).manifest_version === 3);

    f.delay = 200;
    let before = f.requests.length;
    const controller = new AbortController(), promise = get(120, controller.signal).then(() => false, error => error.name === "AbortError");
    await until(() => f.requests.length > before); controller.abort();
    check("fetch AbortSignal propagates", await promise);
    const abort = xhr(120); abort.x.send(); await wait(10); abort.x.abort(); await abort.done;
    check("XHR abort no success or fallback", abort.events.join() === "loadstart,abort,loadend" && abort.x.readyState === 0 && abort.x.status === 0);
    const timeout = xhr(120); timeout.x.timeout = 25; timeout.x.send(); await timeout.done;
    check("XHR timeout no success", timeout.events.join() === "loadstart,timeout,loadend" && timeout.x.status === 0);
    const reuse = xhr(120); reuse.x.send(); reuse.x.open("GET", "/manifest.json"); reuse.x.responseType = "text";
    await new Promise((resolve, reject) => { reuse.x.onload = resolve; reuse.x.onerror = reject; reuse.x.send(); });
    await wait(240);
    check("open cancels stale callbacks", reuse.events.filter(e => e === "load").length === 1 && reuse.x.status === 200);

    // Caller abort remains attached after headers of a native fetch winner.
    f.delay = 5;
    let bodyCanceled = false;
    f.nativeResponse = (_item, signal) => new Response(new ReadableStream({
      start(controller) { signal.addEventListener("abort", () => { bodyCanceled = true; controller.error(signal.reason); }, { once: true }); },
      cancel() { bodyCanceled = true; }
    }), { status: 206, headers: { "content-range": "bytes 123-524410/8388608" } });
    const afterHeaders = new AbortController();
    const nativeStream = await get(120, afterHeaders.signal);
    const reading = nativeStream.arrayBuffer().then(() => false, error => { return true; });
    afterHeaders.abort();
    check("native stream remains abortable after headers", await reading && bodyCanceled);
    f.nativeResponse = null;
    f.delay = range => range.start === 123 ? 10 : 200;
    const midstream = xhr(120);
    midstream.x.addEventListener("progress", () => midstream.x.abort(), { once: true });
    midstream.x.send(); await midstream.done;
    check("XHR abort after first bytes stops load", midstream.progress.length === 1 && midstream.events.join() === "loadstart,abort,loadend" && midstream.x.status === 0);
    await until(() => f.live === 0 && player.getDebug().activeRequests === 0);

    f.delay = 5;
    f.fault = "before"; before = f.requests.length;
    const fallback = xhr(64); fallback.x.send(); await fallback.done;
    check("failure before bytes retries a complete CDN range", valid(fallback.x.response) && f.requests.slice(before).every(item => item.range.length === 524288));
    f.fault = "partial";
    const partial = xhr(32);
    let partialWasHidden = true;
    partial.x.addEventListener("progress", () => { partialWasHidden &&= partial.x.response === null; });
    partial.x.send(); await partial.done;
    check("partial failure exposes only a validated complete buffer", valid(partial.x.response) && partialWasHidden && partial.events.join() === "loadstart,load,loadend");
    check("fallback progress never decreases", partial.progress.every((value, index) => !index || value[0] >= partial.progress[index - 1][0]));
    f.fault = "silent";
    const stalledAt = performance.now(), stalled = xhr(80); stalled.x.send(); await stalled.done;
    check("silent acceleration falls back before switch timeout", valid(stalled.x.response) && performance.now() - stalledAt < 2200);
    f.fault = "";

    // Reject invalid CDN headers before exposing a Response; a peer wins instead.
    f.badHosts.add("upos-sz-mirrorali.bilivideo.com");
    const alternate = await get(16);
    check("refused CDN moves to another native stream", valid(await alternate.arrayBuffer()) && !alternate.url.includes("mirrorali."));
    f.badHosts.clear();

    f.fault = "partial";
    f.nativeResponse = () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("injected native body failure")); } }), {
      status: 206, headers: { "content-range": "bytes 123-524410/8388608" }
    });
    const failedBody = xhr(64); failedBody.x.send(); await failedBody.done;
    check("failed complete-range retry reaches XHR error and loadend", failedBody.events.join() === "loadstart,error,loadend" && failedBody.x.status === 0 && failedBody.x.response === null);
    f.nativeResponse = null; f.fault = "";
    const recovered = xhr(64); recovered.x.send(); await recovered.done;
    check("player retry can succeed after a body failure", valid(recovered.x.response));

    for (const host of __BILI_CDN_RESOLVER_FACTORY__.MAINLAND_HOSTS) f.badHosts.add(host);
    check("all native CDN failures reject before exposing a stream", await get(16).then(() => false, () => true));
    f.badHosts.clear();
    const customHost = "upos-sz-mirrorhw.bilivideo.com";
    settings(true, { mode: "custom", customHosts: [customHost] });
    await until(() => __biliThreadRipperDebug.getSettings().mode === "custom");
    f.badHosts.add(customHost);
    check("failed sole custom node rejects", await get(16).then(() => false, () => true));
    f.badHosts.clear();
    before = f.requests.length;
    check("sole custom node recovers without leaving chosen hosts", valid(await (await get(16)).arrayBuffer()) && f.requests.slice(before).every(item => new URL(item.url).hostname === customHost));
    settings(true);
    await until(() => __biliThreadRipperDebug.getSettings().mode === "mainland");
    before = f.requests.length;
    await fetch(new Request(f.url(80), { headers: { Range: "bytes=0-15", Authorization: "fixture" } }));
    await fetch(f.url(80), { credentials: "include", headers: { Range: "bytes=0-15" } });
    await fetch(f.url(80), { headers: { Range: "bytes=0-" } });
    await fetch(f.url(999), { headers: { Range: "bytes=0-15" } });
    check("unsupported requests pass through once", f.requests.length === before + 4);
    const requestInput = new Request(f.url(80), { headers: { Range: "bytes=123-524410" } });
    before = f.requests.length;
    const viaRequest = await fetch(requestInput);
    check("Request object passed through unchanged", valid(await viaRequest.arrayBuffer()) && f.requests.length === before + 1);

    for (let index = 0; index < 100; index++) {
      const id = [120, 16, 116, 80, 64, 32][index % 6];
      f.quality.newQ = id;
      document.querySelector(".bpx-player-ctrl-quality-menu-item").click();
      f.fault = index % 7 === 0 ? "partial" : "";
      const next = xhr(id), audio = xhr(30280, "bytes=0-1023");
      next.x.send(); audio.x.send(); await Promise.all([next.done, audio.done]);
      check(`switch ${index + 1} to ${id}: complete A/V ranges`, valid(next.x.response) && valid(audio.x.response, 0, 1024));
      f.quality.nowQ = id;
      f.fault = "";
      if (index % 10 === 0) await player.updatePlayinfo(f.playinfo);
    }
    check("100 repeated switches keep native source and transport", __biliThreadRipperDebug.getPlayer() === player && f.actions.length === 0);
    check("switch requests remain accelerated", player.getDebug().acceleratedRanges > 100 && player.getDebug().nativeSwitchRequests > 100);
    f.localNativeXHR = true;
    before = f.requests.length;
    const nativeXhr = xhr(120); nativeXhr.x.withCredentials = true; nativeXhr.x.send(); await nativeXhr.done;
    check("credentialed XHR preserves original browser transport", nativeXhr.x.status === 200 && nativeXhr.x.responseURL.endsWith("/manifest.json") && f.requests.length === before);
    f.localNativeXHR = false;
    // Disabling in flight retries the original request without clearing video state.
    f.delay = 100; before = f.requests.length;
    const ongoing = xhr(80); ongoing.x.send();
    await until(() => f.requests.length > before);
    settings(false);
    check("disable in flight finishes original request", (await ongoing.done, valid(ongoing.x.response)));
    await until(() => !__biliThreadRipperDebug.getPlayer());
    before = f.requests.length;
    await get(80);
    check("disabled bypasses splitting", f.requests.length === before + 1);
    settings(true); await until(() => __biliThreadRipperDebug.getPlayer());
    check("enable disable and playinfo never load pause or change src", f.actions.length === 0);
    result.textContent = JSON.stringify({ pass: true, steps, peakConnections: f.peak, mediaActions: f.actions }); result.dataset.pass = "true";
    document.title = `PASS: ${Object.keys(steps).length} checks, peak ${f.peak}, media resets ${f.actions.length}`;
  } catch (error) {
    document.title = `FAIL: ${error.message}`;
    result.textContent = JSON.stringify({ pass: false, steps, error: error.stack }); result.dataset.pass = "false";
  }
})();
