(function installInfoPanelTest(root) {
  "use strict";

  // Bilibili's "视频统计信息" panel keeps refreshing from its own player core, which downloads
  // nothing while BTR plays. While BTR is active the rows must show BTR's own data; once it
  // hands the video back, the native values stay untouched.
  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const BVID = "BV1infopanel1";
  const container = document.querySelector(".bpx-player-container");
  const panel = document.querySelector(".bpx-player-info-panel");
  const NATIVE = {
    "Mime Type": 'video/mp4;codecs="avc1.640032", audio/mp4;codecs="mp4a.40.2"',
    "Player Type": "DashPlayer",
    "Resolution": "1920 x 1080@30",
    "Video DataRate": "1500 Kbps [AVC]",
    "Audio DataRate": "65 Kbps",
    "Segments": "1 / 84",
    "Dropped Frames": "0 / 0",
    "Video Host": "native-video.bilivideo.com",
    "Audio Host": "native-audio.bilivideo.com",
    "Video Speed": "0 Kbps",
    "Audio Speed": "0 Kbps",
    "Network Activity": "0 KB"
  };
  for (const title of Object.keys(NATIVE)) {
    const line = document.createElement("div");
    line.className = "info-line";
    line.innerHTML = `<span class="info-title">${title}:</span><span class="info-data"></span>`;
    panel.append(line);
  }
  // The native player rewrites every row with its own, stale numbers.
  const nativeRefresh = () => {
    for (const line of panel.querySelectorAll(".info-line")) {
      const title = line.querySelector(".info-title").textContent.replace(":", "");
      line.querySelector(".info-data").textContent = NATIVE[title];
    }
  };
  nativeRefresh();
  setInterval(nativeRefresh, 200);

  history.replaceState(null, "", `/video/${BVID}`);
  root.__INITIAL_STATE__ = { videoData: { bvid: BVID, cid: 101 } };
  root.__playinfo__ = { data: { dash: { duration: 100, video: [], audio: [] } } };
  root.__BILI_RANGE_CORE__ = {
    normalizeSettings(value) {
      return { enabled: value?.enabled !== false, mode: value?.mode || "mainland", concurrency: 32 };
    }
  };
  root.__BILI_THREAD_RIPPER_EARLY_MASK__ = { arm() {}, release() {} };
  let createdOptions = null;
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = {
    createNativePlayer(options) {
      createdOptions = options;
      options.container.dataset.btrMseActive = "true";
      return {
        applySettings() {},
        async setQuality() {},
        async updatePlayinfo() {},
        destroy() { delete options.container.dataset.btrMseActive; },
        getDebug: () => ({
          codec: "av1",
          videoType: 'video/mp4; codecs="av01.0.08M.08"',
          audioType: 'audio/mp4; codecs="mp4a.40.2"',
          videoBandwidth: 382000,
          audioBandwidth: 111000,
          tracks: [{ kind: "video", nextIndex: 5, segments: 80 }, { kind: "audio", nextIndex: 6, segments: 80 }]
        }),
        video: container.querySelector("video")
      };
    }
  };
  root.fetch = async function fakeFetch(input) {
    throw new Error(`unexpected request: ${input}`);
  };

  const result = document.getElementById("info-panel-result");
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rows = () => Object.fromEntries([...panel.querySelectorAll(".info-line")].map((line) => [line.querySelector(".info-title").textContent.replace(":", ""), line.querySelector(".info-data").textContent]));
  document.addEventListener("DOMContentLoaded", () => {
    root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 32 } }, "*");
  }, { once: true });

  (async () => {
    const startedAt = performance.now();
    while (!createdOptions && performance.now() - startedAt < 5000) await wait(25);
    // BTR downloads a piece of video and a piece of audio from its own nodes.
    const videoId = createdOptions.onTransfer({ phase: "start", kind: "video", url: "https://upos-btr-video.bilivideo.com/a-1-100023.m4s", totalBytes: 4 << 20 });
    const audioId = createdOptions.onTransfer({ phase: "start", kind: "audio", url: "https://upos-btr-audio.bilivideo.com/a-1-30280.m4s", totalBytes: 1 << 20 });
    for (let i = 0; i < 8; i += 1) {
      createdOptions.onTransfer({ phase: "progress", id: videoId, bytes: 64 * 1024 });
      createdOptions.onTransfer({ phase: "progress", id: audioId, bytes: 16 * 1024 });
      await wait(100);
    }
    await wait(250);
    const active = rows();
    root.__biliThreadRipperDebug.getPlayer().destroy();
    await wait(1500);
    const handedBack = rows();
    const output = {
      active,
      handedBack,
      checks: {
        playerType: active["Player Type"] === "线程撕裂者 0.9.1.5 接管",
        mime: active["Mime Type"].startsWith('video/mp4; codecs="av01'),
        dataRate: active["Video DataRate"] === "382 Kbps [AV1]" && active["Audio DataRate"] === "111 Kbps",
        segments: active.Segments === "5 / 80",
        hosts: active["Video Host"] === "upos-btr-video.bilivideo.com" && active["Audio Host"] === "upos-btr-audio.bilivideo.com",
        speeds: parseInt(active["Video Speed"], 10) > 0 && parseInt(active["Audio Speed"], 10) > 0,
        activity: parseInt(active["Network Activity"], 10) > 0,
        resolutionLeftAlone: active.Resolution === NATIVE.Resolution,
        nativeValuesAfterHandBack: JSON.stringify(handedBack) === JSON.stringify(NATIVE)
      }
    };
    output.pass = Object.values(output.checks).every(Boolean);
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  })();
})(globalThis);
