(function installQualitySyncTest(root) {
  "use strict";

  // Bilibili's quality menu switches between qualities that are already in the playinfo
  // without a new playurl request. The page hook has to read the choice from the native
  // player and pass it on; the same choice twice must not be passed again.
  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const BVID = "BV1quality001";
  let nativeQuality = 64;
  const created = [];
  const qualityCalls = [];

  history.replaceState(null, "", `/video/${BVID}`);
  root.__INITIAL_STATE__ = { videoData: { bvid: BVID, cid: 101 } };
  root.__playinfo__ = { data: { quality: 64, dash: { duration: 100, video: [], audio: [] } } };
  root.__BILI_RANGE_CORE__ = {
    normalizeSettings(value) {
      return { enabled: value?.enabled !== false, mode: value?.mode || "mainland", concurrency: 32 };
    }
  };
  root.__BILI_THREAD_RIPPER_EARLY_MASK__ = { arm() {}, release() {} };
  // The native player: its menu sets newQ, like Bilibili's own click handler.
  root.player = { getQuality: () => ({ nowQ: 0, newQ: nativeQuality, realQ: 16 }) };
  for (const item of document.querySelectorAll(".bpx-player-ctrl-quality-menu-item")) {
    item.addEventListener("click", () => { nativeQuality = Number(item.dataset.value); });
  }
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = {
    createNativePlayer(options) {
      created.push({ preferredQuality: options.preferredQuality });
      return {
        applySettings() {},
        async setQuality(quality) { qualityCalls.push({ quality, at: performance.now() }); },
        async updatePlayinfo() {},
        destroy() {},
        video: { isConnected: true, paused: false }
      };
    }
  };
  root.fetch = async function fakeFetch(input) {
    throw new Error(`unexpected request: ${input}`);
  };

  const result = document.getElementById("quality-sync-result");
  const click = (value) => document.querySelector(`.bpx-player-ctrl-quality-menu-item[data-value="${value}"] span`)
    .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const output = { created, qualityCalls, steps: {} };
  const render = () => { result.textContent = JSON.stringify(output); };

  document.addEventListener("DOMContentLoaded", () => {
    root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 32 } }, "*");
  }, { once: true });

  (async () => {
    const startedAt = performance.now();
    while (!created.length && performance.now() - startedAt < 5000) await wait(25);
    // The quality chosen before takeover goes straight to the new player.
    output.steps.initial = created[0]?.preferredQuality;
    await wait(1200);
    output.steps.noCallWhileUnchanged = qualityCalls.length === 0;

    let clickedAt = performance.now();
    click(32);
    await wait(150);
    output.steps.clickFollowedQuickly = qualityCalls.at(-1)?.quality === 32 && qualityCalls.at(-1).at - clickedAt < 150;

    click(32);
    await wait(1300);
    output.steps.sameChoiceNotRepeated = qualityCalls.length === 1;

    // A change the menu did not make (keyboard shortcut, Bilibili itself) is still picked up.
    nativeQuality = 16;
    await wait(1300);
    output.steps.changeWithoutClick = qualityCalls.at(-1)?.quality === 16 && qualityCalls.length === 2;

    clickedAt = performance.now();
    click(0);
    await wait(150);
    output.steps.backToAuto = qualityCalls.at(-1)?.quality === 0 && qualityCalls.length === 3;

    output.steps.onePlayer = created.length === 1;
    output.pass = output.steps.initial === 64
      && output.steps.noCallWhileUnchanged
      && output.steps.clickFollowedQuickly
      && output.steps.sameChoiceNotRepeated
      && output.steps.changeWithoutClick
      && output.steps.backToAuto
      && output.steps.onePlayer
      && root.__biliThreadRipperDebug?.version === "0.9.1.4";
    render();
    result.dataset.pass = String(output.pass);
  })();
})(globalThis);
