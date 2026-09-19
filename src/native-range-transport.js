(function installNativeRangeTransport(root) {
  "use strict";

  const core = root.__BILI_RANGE_CORE__;
  if (root.__BILI_NATIVE_RANGE_PLAYER_FACTORY__) return;
  const resolvers = root.__BILI_CDN_RESOLVER_FACTORY__;
  const downloaders = root.__BILI_IDM_DOWNLOADER_FACTORY__;
  if (!core || !resolvers || !downloaders || !root.fetch || !root.XMLHttpRequest) return;
  const nativeFetch = root.fetch.bind(root);
  const MAX_RANGE_BYTES = 32 * 1024 * 1024;
  const FIRST_PIECE_TIMEOUT_MS = 1500;
  const ORDERED_STALL_TIMEOUT_MS = 3000;
  let active = null;

  function nativeSwitchPending() {
    try {
      const quality = root.player?.getQuality?.();
      const current = Number(quality?.nowQ), target = Number(quality?.newQ);
      return Number.isFinite(current) && Number.isFinite(target) && current > 0 && target > 0 && current !== target;
    } catch (_error) { return false; }
  }

  // A completed VOD scheduler stays stopped when Bilibili changes quality.
  // Reopen scheduling during that request; native rules still choose every
  // fragment. Never restart a running scheduler: start() clears its append lock.
  function attachQualityGuard(dash, video, note) {
    const records = new Map();
    let disposed = false;
    const clear = record => {
      record.pending = null;
      clearTimeout(record.timer);
      if (record.frame) video.cancelVideoFrameCallback?.(record.frame);
      record.frame = 0;
    };
    const restore = record => {
      clear(record);
      if (record.buffer.getIsBufferingCompleted === record.wrapped) record.buffer.getIsBufferingCompleted = record.original;
    };
    function oldFuture(record) {
      const model = record.processor.getFragmentModel?.(), target = dash.getQualityFor(record.processor.getType());
      const history = model?.getRequests?.({ state: "executed", type: "MediaSegment" }) || [];
      return history.some(request => request && request.quality !== target && request.startTime > video.currentTime
        && model.getRequests({ state: "executed", time: request.startTime + request.duration / 2, threshold: 0 })?.[0] === request);
    }
    function finishSource() {
      const source = [...records.values()][0]?.buffer.getMediaSource?.();
      if (disposed || source?.readyState !== "open" || source.sourceBuffers.length !== records.size) return;
      if ([...records.values()].every(record => record.buffer.getMediaSource?.() === source
        && record.buffer.getIsBufferingCompleted() && !record.processor.getFragmentModel?.()?.getLoadingRequests?.().length)
        && [...source.sourceBuffers].every(buffer => !buffer.updating)) source.endOfStream();
    }
    function resumeFuture(record) {
      if (disposed || dash.getFastSwitchEnabled?.() === false) return;
      const processor = record.processor, scheduler = processor.getScheduleController();
      if (scheduler.isStarted()) return;
      const target = dash.getQualityFor(processor.getType());
      const duration = processor.getRepresentationInfoForQuality?.(target)?.fragmentDuration || 5;
      const offsets = dash.getFastSwitchQnV2Enabled?.() ? [1, 1.5] : [1.5];
      const due = offsets.some(offset => {
        const request = processor.getFragmentModel?.()?.getRequests?.({ state: "executed", time: video.currentTime + duration * offset, threshold: 0 })?.[0];
        return request?.type === "MediaSegment" && request.quality !== target;
      });
      if (due) { scheduler.start(); note("native future replacement resumed", processor.getType()); }
    }
    function observe(event) {
      const buffer = event.sender, processor = buffer?.getStreamProcessor?.(), type = processor?.getType?.();
      if (!type || typeof buffer.getIsBufferingCompleted !== "function" || !processor.getScheduleController) return;
      const scheduler = processor.getScheduleController();
      if (typeof scheduler?.isStarted !== "function" || typeof scheduler.start !== "function") return;
      const previous = records.get(type);
      if (previous?.processor === processor) {
        queueMicrotask(() => { resumeFuture(previous); finishSource(); });
        return;
      }
      if (previous) restore(previous);
      const record = { buffer, processor, original: buffer.getIsBufferingCompleted, pending: null, frame: 0 };
      // A successful switch only confirms the current segment. Keep native
      // replacement scheduling alive while later buffered segments are old.
      record.wrapped = function () { return record.original.call(this) && !record.pending && !oldFuture(record); };
      buffer.getIsBufferingCompleted = record.wrapped;
      records.set(type, record);
    }
    function requested(event) {
      const record = records.get(event.mediaType);
      if (!record || !Number.isInteger(event.newQuality)) return;
      clear(record);
      record.pending = event;
      // Only a cleanup bound: Bilibili keeps its original switch timeout.
      record.timer = setTimeout(() => clear(record), 21000);
      const processor = record.processor;
      queueMicrotask(() => {
        if (disposed || record.pending !== event) return;
        const scheduler = processor.getScheduleController();
        if (!scheduler.isStarted()) { scheduler.start(); note("native stopped scheduler resumed", event.mediaType); }
      });

      // After seeking back into an old rendition, the requested quality can
      // already be displayed. Native rendering notifications require a change
      // from the previous frame and otherwise never resolve this request.
      const wrapper = root.player?.__core?.();
      if (event.mediaType !== "video" || !video.requestVideoFrameCallback || typeof wrapper?.fire !== "function"
        || typeof wrapper.getQualityChangedData !== "function") return;
      const at = time => processor.getFragmentModel?.()?.getRequests?.({ state: "executed", time, threshold: 0 })
        ?.find(request => request?.type === "MediaSegment");
      const target = processor.getMediaInfo?.()?.bitrateList?.[event.newQuality];
      if (!target) return;
      let frames = 0, switching = null;
      const confirm = (_now, metadata) => {
        record.frame = 0;
        if (disposed || record.pending !== event || wrapper.getCorePlayer() !== dash) return;
        const current = wrapper.qnSwitchingInfo?.video, request = at(metadata.mediaTime);
        if (!current?.switching || current.qn !== event.newQuality || typeof current.listener !== "function"
          || (switching && switching !== current)) return;
        switching = current;
        // Native history may be absent immediately after a seek. Observe until
        // matching frames arrive; an index/init response alone is never success.
        frames = request?.quality === event.newQuality && video.videoWidth === target.width
          && video.videoHeight === target.height ? frames + 1 : 0;
        if (frames < 2) { record.frame = video.requestVideoFrameCallback(confirm); return; }
        const rendered = { type: "qualityChangeRendered", mediaType: "video", oldQuality: event.oldQuality, newQuality: event.newQuality,
          index: request.index, requestType: request.type, isMediaSegment: true };
        wrapper.fire("qualityChangeRendered", wrapper.getQualityChangedData(rendered));
        current.listener(rendered);
        clear(record);
        note("native already-rendered quality confirmed", `${target.width}x${target.height} / 2 decoded frames`);
      };
      record.frame = video.requestVideoFrameCallback(confirm);
    }
    function rendered(event) {
      const record = records.get(event.mediaType);
      if (record?.pending?.newQuality === event.newQuality) clear(record);
    }
    const handlers = { bufferLevelUpdated: observe, qualityChangeRequested: requested, qualityChangeRendered: rendered };
    for (const [name, handler] of Object.entries(handlers)) dash.on(name, handler);
    return () => {
      disposed = true;
      for (const [name, handler] of Object.entries(handlers)) dash.off(name, handler);
      for (const record of records.values()) restore(record);
      records.clear();
    };
  }

  // Only bounded, ordinary media GETs are replaced. Authentication, conditional
  // requests, open-ended ranges, sync XHR and unknown files retain native behavior.
  function planRequest(url, method, headers, credentials) {
    const owner = active;
    if (!owner || owner.disposed || !owner.settings().enabled || method !== "GET"
      || credentials === "include" || !core.isBilibiliMediaUrl(url)) return null;
    if ([...headers.keys()].some(name => !["range", "accept"].includes(name))) return null;
    const range = core.parseRangeHeader(headers.get("range"));
    if (!range || range.length > MAX_RANGE_BYTES) return null;
    const track = owner.track(url);
    if (!track) return null;
    if (nativeSwitchPending()) owner.nativeSwitchRequest();
    return { owner, url, range, track, headers };
  }

  // FetchLoader swallows reader errors after headers. Never give it a synthetic
  // multipart stream: race a small number of real CDN connections and return the
  // winning browser Response unchanged, including its native body and aborts.
  async function fetchNativeRange(plan, init = {}) {
    const { owner, range, track } = plan;
    const resolver = owner.resolver(plan.url, track);
    const healthy = resolver.rescueCandidates();
    const preferred = healthy.length ? healthy : resolver.urls();
    const settings = owner.settings();
    const original = settings.mode === "custom" && settings.customHosts.length ? [] : [plan.url];
    const urls = [...new Set([preferred[0], ...original, ...preferred])].filter(Boolean).slice(0, 3);
    const attempts = urls.map(() => new AbortController());
    const cancel = () => attempts.forEach(controller => controller.abort(init.signal.reason));
    if (init.signal?.aborted) cancel();
    else init.signal?.addEventListener("abort", cancel, { once: true });
    let winner = -1;
    try {
      const result = await Promise.any(urls.map(async (url, index) => {
        const controller = attempts[index];
        // Keep the original connection available promptly, even if the selected
        // CDN answers slowly or refuses a signed address.
        let delay;
        try {
          if (index) await new Promise((resolve, reject) => {
            delay = setTimeout(resolve, index * 150);
            controller.signal.addEventListener("abort", () => { clearTimeout(delay); reject(controller.signal.reason); }, { once: true });
            if (controller.signal.aborted) { clearTimeout(delay); reject(controller.signal.reason); }
          });
          const response = await nativeFetch(url, { ...init, signal: controller.signal });
          const contentRange = core.parseContentRange(response.headers.get("content-range"));
          if (response.status !== 206 || !contentRange || contentRange.start !== range.start
            || contentRange.end !== range.end || contentRange.total <= range.end) {
            throw Object.assign(new Error("CDN 返回了不一致的 Range"), { status: response.status });
          }
          return { response, index };
        } catch (error) {
          if (!controller.signal.aborted) resolver.failure(url, error, 0);
          controller.abort();
          throw error;
        } finally { clearTimeout(delay); }
      }));
      winner = result.index;
      owner.nativeStream(track, urls[winner]);
      return result.response;
    } catch (error) {
      throw init.signal?.aborted ? init.signal.reason : error.errors?.at(-1) || error;
    } finally {
      attempts.forEach((controller, index) => { if (index !== winner) controller.abort(); });
      // The winning native stream still needs the caller's cancellation after
      // headers; keep only that controller in the signal's listener closure.
      const selected = attempts[winner];
      init.signal?.removeEventListener("abort", cancel);
      if (selected && init.signal) {
        const abortWinner = () => selected.abort(init.signal.reason);
        if (init.signal.aborted) abortWinner();
        else init.signal.addEventListener("abort", abortWinner, { once: true });
      }
    }
  }

  async function readNativeRange(plan, signal, progress) {
    const response = await fetchNativeRange(plan, { headers: plan.headers, signal });
    const reader = response.body.getReader(), chunks = [];
    const cancel = () => { reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const total = core.parseContentRange(response.headers.get("content-range")).total;
    let received = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (signal.aborted) throw signal.reason;
        if (done) break;
        received += value.byteLength;
        if (received > plan.range.length) throw new Error("媒体 Range 长度不符");
        chunks.push(value);
        progress(received, total);
      }
      if (received !== plan.range.length) throw new Error("媒体 Range 长度不符");
      return { bytes: core.concatChunks(chunks, received), headers: response.headers, url: response.url };
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  }

  // XHR exposes bytes only at DONE. Keep that contract: progress may advance as
  // pieces arrive, but no partial buffer reaches the player before validation.
  async function accelerate(plan, signal, progress) {
    if (signal.aborted) throw signal.reason;
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    const { range, owner, track } = plan;
    owner.jobs.add(controller);
    let timer, received = 0, total = null;
    const chunks = [];
    const arm = ms => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new DOMException("Acceleration budget exceeded", "TimeoutError")), ms);
    };
    let stop;
    const interrupted = new Promise((_, reject) => {
      stop = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", stop, { once: true });
    });
    arm(FIRST_PIECE_TIMEOUT_MS);
    try {
      const download = owner.downloader.downloadRange(range, owner.resolver(plan.url, track), {
        signal: controller.signal, parallel: true, startup: true, kind: track.kind, probeLimit: 2,
        onOrderedChunk(bytes, piece, fileTotal) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (piece.start !== range.start + received || bytes.byteLength !== piece.length
            || !Number.isSafeInteger(fileTotal) || fileTotal <= range.end
            || (total !== null && total !== fileTotal)) throw new Error("媒体 Range 校验失败");
          total = fileTotal;
          chunks.push(bytes);
          received += bytes.byteLength;
          progress(received, total);
          arm(ORDERED_STALL_TIMEOUT_MS);
        }
      });
      const result = await Promise.race([download, interrupted]);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (received !== range.length || result.total !== total) throw new Error("媒体 Range 长度不符");
      owner.delivered(track, result);
      return { bytes: core.concatChunks(chunks, received), headers: new Headers({
        "Content-Type": track.representation.mimeType || track.representation.mime_type || `${track.kind}/mp4`,
        "Content-Length": String(range.length), "Content-Range": `bytes ${range.start}-${range.end}/${total}`,
        "Accept-Ranges": "bytes"
      }), url: plan.url };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      chunks.length = 0;
      owner.fallback(error);
      // No partial data has escaped XHR, so retry the range atomically. An error
      // in this real stream reaches XHR.onerror and Bilibili's normal retry path.
      return readNativeRange(plan, signal, progress);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", stop);
      controller.abort();
      signal.removeEventListener("abort", cancel);
      owner.jobs.delete(controller);
    }
  }

  root.fetch = function (input, init) {
    // The native DASH loader supplies a URL and init. Leave Request objects with
    // their native body/signal lifecycle rather than trying to reconstruct them.
    if (input instanceof Request) return nativeFetch(input, init);
    let url, headers;
    try {
      url = new URL(String(input), root.location.href).href;
      headers = new Headers(init?.headers);
    } catch (_error) { return nativeFetch(input, init); }
    const method = String(init?.method || "GET").toUpperCase();
    const plan = init?.mode === "no-cors" || init?.body != null || init?.integrity ? null : planRequest(url, method, headers, init?.credentials);
    if (!plan) return nativeFetch(input, init);
    return fetchNativeRange(plan, init);
  };

  // Preserve the actual XMLHttpRequest object, event handlers and prototype. Only
  // eligible arraybuffer requests receive a synthetic response. Calling open()
  // again restores all native response accessors before the object is reused.
  const proto = root.XMLHttpRequest.prototype;
  const nativeOpen = proto.open, nativeSend = proto.send, nativeAbort = proto.abort;
  const nativeSetHeader = proto.setRequestHeader;
  const nativeGetHeader = proto.getResponseHeader, nativeGetHeaders = proto.getAllResponseHeaders;
  const requests = new WeakMap();
  const fields = ["readyState", "status", "statusText", "response", "responseText", "responseURL"];
  function emit(xhr, type, progress) {
    xhr.dispatchEvent(progress ? new ProgressEvent(type, progress) : new Event(type));
  }
  function restore(xhr, entry) {
    if (!entry?.synthetic) return;
    for (const key of fields) {
      const descriptor = entry.descriptors[key];
      if (descriptor) Object.defineProperty(xhr, key, descriptor);
      else delete xhr[key];
    }
    entry.synthetic = false;
  }
  function isCurrent(xhr, entry) { return requests.get(xhr) === entry && entry.sending; }
  function finish(xhr, entry, type) {
    if (!isCurrent(xhr, entry)) return;
    clearTimeout(entry.timer);
    entry.sending = false;
    entry.state = 4;
    emit(xhr, "readystatechange");
    if (requests.get(xhr) !== entry || entry.state !== 4) return;
    const progress = { lengthComputable: type === "load", loaded: entry.body?.byteLength || 0, total: entry.body?.byteLength || 0 };
    emit(xhr, type, progress);
    if (requests.get(xhr) === entry) emit(xhr, "loadend", progress);
  }
  proto.open = function (method, url, async = true, ...rest) {
    const previous = requests.get(this);
    requests.delete(this);
    if (previous) {
      previous.sending = false;
      clearTimeout(previous.timer);
      previous.controller?.abort();
      restore(this, previous);
    }
    const result = nativeOpen.call(this, method, url, async, ...rest);
    requests.set(this, { method: String(method).toUpperCase(), url: new URL(String(url), root.location.href).href,
      async: async !== false, headers: new Headers(), authenticated: rest.some(value => value != null), sending: false, synthetic: false });
    return result;
  };
  proto.setRequestHeader = function (name, value) {
    const entry = requests.get(this);
    if (entry?.synthetic) throw new DOMException("Call open() before sending again", "InvalidStateError");
    const result = nativeSetHeader.call(this, name, value);
    entry?.headers.append(name, value);
    return result;
  };
  proto.getResponseHeader = function (name) {
    const entry = requests.get(this);
    return entry?.synthetic ? (entry.state >= 2 ? entry.responseHeaders.get(name) : null) : nativeGetHeader.call(this, name);
  };
  proto.getAllResponseHeaders = function () {
    const entry = requests.get(this);
    return entry?.synthetic ? (entry.state >= 2 ? [...entry.responseHeaders].map(([key, value]) => `${key}: ${value}\r\n`).join("") : "") : nativeGetHeaders.call(this);
  };
  proto.abort = function () {
    const entry = requests.get(this);
    if (!entry?.synthetic) return nativeAbort.call(this);
    entry.status = 0; entry.statusText = ""; entry.responseUrl = ""; entry.body = null; entry.responseHeaders = new Headers();
    if (entry.sending) {
      entry.controller.abort();
      finish(this, entry, "abort");
    }
    if (requests.get(this) === entry && !entry.sending) entry.state = 0;
  };
  proto.send = function (body) {
    const entry = requests.get(this);
    if (entry?.synthetic) throw new DOMException("Call open() before sending again", "InvalidStateError");
    if (this.readyState !== 1) return nativeSend.call(this, body);
    const plan = entry?.async && !entry.authenticated && body == null && this.responseType === "arraybuffer"
      ? planRequest(entry.url, entry.method, entry.headers, this.withCredentials ? "include" : "same-origin") : null;
    if (!plan) return nativeSend.call(this, body);
    entry.sending = true; entry.synthetic = true; entry.state = 1;
    entry.status = 0; entry.statusText = ""; entry.body = null; entry.responseUrl = "";
    entry.responseHeaders = new Headers(); entry.controller = new AbortController();
    entry.descriptors = Object.fromEntries(fields.map(key => [key, Object.getOwnPropertyDescriptor(this, key)]));
    Object.defineProperties(this, {
      readyState: { configurable: true, get: () => entry.state },
      status: { configurable: true, get: () => entry.status },
      statusText: { configurable: true, get: () => entry.statusText },
      response: { configurable: true, get: () => entry.state === 4 ? entry.body : null },
      responseText: { configurable: true, get() { throw new DOMException("arraybuffer response", "InvalidStateError"); } },
      responseURL: { configurable: true, get: () => entry.responseUrl }
    });
    if (this.timeout > 0) entry.timer = setTimeout(() => {
      if (!isCurrent(this, entry)) return;
      entry.controller.abort();
      entry.status = 0; entry.statusText = ""; entry.responseUrl = ""; entry.responseHeaders = new Headers();
      finish(this, entry, "timeout");
    }, this.timeout);
    emit(this, "loadstart", { lengthComputable: false, loaded: 0, total: 0 });
    if (!isCurrent(this, entry)) return;
    entry.loaded = 0;
    const reportProgress = (received, total) => {
      if (!isCurrent(this, entry)) return;
      if (entry.state === 1) {
        entry.status = 206; entry.statusText = "Partial Content"; entry.responseUrl = entry.url;
        entry.responseHeaders = new Headers({ "content-range": `bytes ${plan.range.start}-${plan.range.end}/${total}`, "content-length": String(plan.range.length), "content-type": plan.track.representation.mimeType || plan.track.representation.mime_type || `${plan.track.kind}/mp4` });
        entry.state = 2; emit(this, "readystatechange");
      }
      if (!isCurrent(this, entry) || received <= entry.loaded) return;
      entry.loaded = received;
      entry.state = 3; emit(this, "readystatechange");
      if (isCurrent(this, entry)) emit(this, "progress", { lengthComputable: true, loaded: received, total: plan.range.length });
    };
    accelerate(plan, entry.controller.signal, reportProgress).then(result => {
      if (!isCurrent(this, entry)) return;
      entry.responseHeaders = result.headers; entry.responseUrl = result.url || entry.url;
      entry.body = result.bytes.buffer;
      finish(this, entry, "load");
    }).catch(() => {
      if (!isCurrent(this, entry)) return;
      entry.status = 0; entry.statusText = ""; entry.responseUrl = ""; entry.body = null; entry.responseHeaders = new Headers();
      finish(this, entry, "error");
    });
  };

  function createNativePlayer(options) {
    const video = options.container.querySelector("video");
    if (!video) throw new Error("没有找到 B 站原生 video 元素");
    if (active) active.destroy();
    let tracks = [], lastVideo = null, lastAudio = null;
    let delivered = 0, fallbacks = 0, nativeStreams = 0, nativeSwitchRequests = 0;
    let qualityState = "", guardedDash = null, releaseGuard = null;
    const cache = new Map(), jobs = new Set(), timeline = [];
    const settings = () => core.normalizeSettings(options.getSettings());
    const note = (what, detail = "") => {
      timeline.push({ at: Math.round(performance.now()), time: Number(video.currentTime) || 0, what, detail });
      if (timeline.length > 120) timeline.shift();
    };
    const update = playinfo => {
      const dash = playinfo?.data?.dash || playinfo?.result?.dash || playinfo?.dash;
      if (!dash) return;
      const audio = [...(dash.audio || []), ...[].concat(dash.dolby?.audio || [], dash.flac?.audio || [])];
      tracks = (dash.video || []).map(representation => ({ kind: "video", representation }))
        .concat(audio.map(representation => ({ kind: "audio", representation })));
      // Retain healthy-node history across same-video playurl updates.
    };
    update(options.playinfo);
    const urls = representation => [representation.baseUrl || representation.base_url, ...[].concat(representation.backupUrl || representation.backup_url || [])].filter(Boolean);
    const pathOf = url => { try { return new URL(url).pathname; } catch (_error) { return ""; } };
    function sampleQuality() {
      try {
        const dash = settings().enabled ? root.player?.__core?.()?.getCorePlayer?.() : null;
        if (dash !== guardedDash) {
          releaseGuard?.(); releaseGuard = null; guardedDash = null;
          if (dash?.on && dash.off && dash.getQualityFor && dash.getVideoElement?.() === video) {
            releaseGuard = attachQualityGuard(dash, video, note);
            guardedDash = dash;
          }
        }
        const quality = root.player?.getQuality?.();
        const value = `${quality?.nowQ}/${quality?.newQ}/${quality?.realQ}`;
        if (value !== qualityState) { qualityState = value; note("native quality now/target/rendered", value); }
      } catch (_error) {}
    }
    const publish = () => {
      if (owner.disposed) return;
      sampleQuality();
      const rendered = tracks.find(track => track.kind === "video" && Number(track.representation.id) === Number(qualityState.split("/")[0]))?.representation;
      options.onState?.({ playerState: video.ended ? "ended" : video.readyState >= 2 ? "ready" : "buffering",
        mode: settings().mode, quality: rendered ? root.__BILI_NATIVE_MSE_PLAYER_FACTORY__?.qualityLabel?.(rendered) || String(rendered.id) : "原生画质",
        bufferedAhead: bufferedAhead(), cdnHosts: [...cache.values()].flatMap(resolver => resolver.status()) });
    };
    function bufferedAhead() {
      const time = Number(video.currentTime) || 0;
      for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= time && video.buffered.end(i) > time) return video.buffered.end(i) - time;
      return 0;
    }
    const owner = {
      disposed: false, jobs, settings,
      track: url => tracks.find(track => urls(track.representation).some(candidate => pathOf(candidate) === pathOf(url))) || null,
      resolver(url, track) {
        const parsed = new URL(url), key = parsed.pathname + parsed.search;
        if (!cache.has(key)) {
          if (cache.size >= 64) cache.delete(cache.keys().next().value);
          cache.set(key, resolvers.createResolver({ ...track.representation, baseUrl: url, base_url: url }, () => settings().mode, options.cdnBans, () => settings().customHosts));
        }
        return cache.get(key);
      },
      delivered(track, result) {
        if (owner.disposed) return;
        if (track.kind === "video") lastVideo = track.representation;
        else lastAudio = track.representation;
        delivered++;
        note("native range delivered", `${track.kind} ${result.byteLength} bytes / ${result.pieceCount} pieces`);
        options.onSegment?.({ kind: track.kind, bytes: result.byteLength, pieces: result.pieceCount, hosts: result.hosts });
        publish();
      },
      nativeSwitchRequest() {
        nativeSwitchRequests++;
        note("quality switch: accelerated request");
      },
      nativeStream(track, url) {
        nativeStreams++;
        note("native CDN stream", `${track.kind} ${track.representation.id} ${new URL(url).hostname}`);
      },
      fallback(error) {
        if (owner.disposed) return;
        fallbacks++;
        note("native request fallback", String(error?.name || "Error"));
        options.onLog?.("分段改用完整连接", "并发下载未完成，使用完整 CDN 连接重试。", "info", "download");
      },
      destroy() {
        if (owner.disposed) return;
        owner.disposed = true;
        releaseGuard?.();
        for (const controller of jobs) controller.abort();
        events.abort();
        if (active === owner) active = null;
        // The native media source, buffers, playback position and pause state are untouched.
      }
    };
    owner.downloader = downloaders.createDownloader({ getSettings: settings, nativeFetch, onTransfer: options.onTransfer });
    const events = new AbortController();
    for (const name of ["playing", "waiting", "stalled", "seeking", "seeked", "ended", "loadedmetadata", "progress", "timeupdate"]) video.addEventListener(name, () => {
      if (name !== "timeupdate" && name !== "progress") note(`media ${name}`, `buffer ${bufferedAhead().toFixed(2)}s`);
      sampleQuality();
      if (name !== "timeupdate") publish();
    }, { signal: events.signal });
    active = owner;
    note("native transport attached");
    queueMicrotask(publish);
    return Object.freeze({
      nativeTransport: true, video,
      applySettings() { sampleQuality(); if (!settings().enabled) for (const controller of jobs) controller.abort(); },
      async updatePlayinfo(playinfo) { update(playinfo); },
      destroy: owner.destroy,
      getDebug: () => ({ architecture: "native-player-range-transport", transportRevision: 4, qualityGuardRevision: 9, nativeQualityGuard: !!guardedDash,
        qualityId: Number(qualityState.split("/")[0]) || 0, downloadedQualityId: Number(lastVideo?.id) || 0,
        width: video.videoWidth, height: video.videoHeight, currentTime: Number(video.currentTime) || 0,
        videoType: lastVideo?.mimeType || lastVideo?.mime_type || "", audioType: lastAudio?.mimeType || lastAudio?.mime_type || "",
        videoBandwidth: Number(lastVideo?.bandwidth) || 0, audioBandwidth: Number(lastAudio?.bandwidth) || 0,
        codec: lastVideo?.codecs || "", frameRate: Number(lastVideo?.frameRate) || 0,
        acceleratedRanges: delivered, nativeFallbacks: fallbacks, nativeStreams, nativeSwitchRequests,
        nativeQuality: qualityState, nativeSwitchPending: nativeSwitchPending(), activeRequests: jobs.size,
        mediaSourceReplacements: 0, timeline: timeline.slice(), tracks: [] })
    });
  }
  root.__BILI_NATIVE_RANGE_PLAYER_FACTORY__ = Object.freeze({ createNativePlayer });
})(globalThis);
