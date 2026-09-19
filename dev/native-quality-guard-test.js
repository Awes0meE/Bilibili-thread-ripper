"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");

async function fixture({ completed = true, started = false, displayed = 0 } = {}) {
  const frames = new Map(), timers = new Map(), listeners = new Map();
  let serial = 0, starts = 0, confirmations = 0;
  const video = Object.assign(new EventTarget(), { currentTime: 2, buffered: { length: 0 }, readyState: 4,
    videoWidth: 1920, videoHeight: 1080,
    requestVideoFrameCallback(fn) { const id = ++serial; frames.set(id, fn); return id; },
    cancelVideoFrameCallback(id) { frames.delete(id); }
  });
  const settings = { enabled: true }, buffer = { getIsBufferingCompleted: () => completed, getStreamProcessor: () => processor };
  const original = buffer.getIsBufferingCompleted;
  const scheduler = { isStarted: () => started, start() { starts++; started = true; } };
  const request = { type: "MediaSegment", quality: displayed, index: 0 };
  const processor = { getType: () => "video", getScheduleController: () => scheduler,
    getFragmentModel: () => ({ getRequests: () => [request] }), getMediaInfo: () => ({ bitrateList: [{width: 1920, height: 1080}, {width: 640, height: 360}] }) };
  const dash = { on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    off(name, fn) { listeners.get(name)?.delete(fn); }, getQualityFor: () => 0, getVideoElement: () => video };
  const events = [];
  const wrapper = { getCorePlayer: () => dash, qnSwitchingInfo: {}, getQualityChangedData: event => ({...event, newQualityNumber: event.newQuality === 0 ? 116 : 16}), fire: (name, event) => events.push([name, event]) };
  const emit = (name, event) => { for (const fn of listeners.get(name) || []) fn(event); };
  const context = vm.createContext({ AbortController, DOMException, Event, URL, Request, Headers, Response, performance, queueMicrotask,
    setTimeout: fn => { const id = ++serial; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    fetch, XMLHttpRequest: class {}, __BILI_RANGE_CORE__: { normalizeSettings: s => s }, __BILI_CDN_RESOLVER_FACTORY__: {},
    __BILI_IDM_DOWNLOADER_FACTORY__: { createDownloader: () => ({}) }, player: { getQuality: () => ({}), __core: () => wrapper } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/native-range-transport.js"), "utf8"), context);
  const owner = context.__BILI_NATIVE_RANGE_PLAYER_FACTORY__.createNativePlayer({ container: { querySelector: () => video }, getSettings: () => settings });
  await Promise.resolve(); emit("bufferLevelUpdated", { sender: buffer });
  return { video, buffer, original, scheduler, request, processor, dash, wrapper, emit, events, timers, frames, settings, owner,
    starts: () => starts, confirmations: () => confirmations,
    requestQuality(target) {
      emit("qualityChangeRequested", { mediaType: "video", oldQuality: 1 - target, newQuality: target });
      wrapper.qnSwitchingInfo.video = { switching: true, qn: target, listener() { confirmations++; this.switching = false; } };
    },
    frame() { const batch = [...frames.values()]; frames.clear(); for (const fn of batch) fn(0, { mediaTime: video.currentTime }); }
  };
}

test("completed scheduler resumes and native completion restores after rendering", async () => {
  const f = await fixture(); f.requestQuality(1); await Promise.resolve();
  assert.equal(f.starts(), 1); assert.equal(f.buffer.getIsBufferingCompleted(), false);
  f.emit("qualityChangeRendered", {mediaType: "video", newQuality: 1});
  assert.equal(f.buffer.getIsBufferingCompleted(), true); assert.equal(f.video.currentTime, 2);
  f.owner.destroy(); assert.equal(f.buffer.getIsBufferingCompleted, f.original);
});

test("running scheduler is never restarted or unlocked", async () => {
  const f = await fixture({ started: true }); f.requestQuality(1); await Promise.resolve();
  assert.equal(f.starts(), 0); f.owner.destroy();
});

test("rendering one new segment does not strand old future segments or finish an active source", async () => {
  const f = await fixture(); f.dash.getQualityFor = () => 1;
  const old = {type: "MediaSegment", quality: 0, index: 1, startTime: 10, duration: 5};
  let history = [old], loading = [], ended = 0;
  const source = {readyState: "open", sourceBuffers: [{updating: false}], endOfStream() { ended++; this.readyState = "ended"; }};
  f.buffer.getMediaSource = () => source;
  f.processor.getFragmentModel = () => ({ getRequests: filter => "time" in filter ? [history.at(-1)] : history, getLoadingRequests: () => loading });
  f.requestQuality(1); f.emit("qualityChangeRendered", {mediaType: "video", newQuality: 1});
  assert.equal(f.buffer.getIsBufferingCompleted(), false, "later old quality must keep scheduling alive");
  f.emit("bufferLevelUpdated", {sender:f.buffer}); await Promise.resolve(); assert.equal(ended, 0);
  history.push({...old, quality:1}); loading = [{}];
  assert.equal(f.buffer.getIsBufferingCompleted(), true, "superseded history must not keep scheduling alive");
  f.emit("bufferLevelUpdated", {sender:f.buffer}); await Promise.resolve(); assert.equal(ended, 0);
  loading = []; f.emit("bufferLevelUpdated", {sender:f.buffer}); await Promise.resolve(); assert.equal(ended, 1);
  f.owner.destroy();
});

test("already displayed quality requires two decoded frames and native matching history", async () => {
  const f = await fixture(); f.requestQuality(0); await Promise.resolve();
  f.frame(); assert.equal(f.confirmations(), 0); f.frame(); assert.equal(f.confirmations(), 1);
  assert.equal(f.events[0][0], "qualityChangeRendered"); assert.equal(f.buffer.getIsBufferingCompleted(), true);
  assert.equal(f.events[0][1].newQualityNumber, 116, "wrapper consumers receive the native quality-number payload");
  assert.equal(f.timers.size, 0); f.owner.destroy();
});

test("future scheduling resumes only when an old segment reaches the native replacement window", async () => {
  const f = await fixture(); f.dash.getQualityFor = () => 1;
  const old = {type:"MediaSegment",quality:0,startTime:10,duration:5};
  f.processor.getFragmentModel = () => ({getRequests: filter => "time" in filter ? [filter.time >= 10 && filter.time < 15 ? old : null] : [old]});
  f.emit("bufferLevelUpdated", {sender:f.buffer}); await Promise.resolve(); assert.equal(f.starts(), 0);
  f.video.currentTime = 2.6; f.emit("bufferLevelUpdated", {sender:f.buffer}); await Promise.resolve(); assert.equal(f.starts(), 1);
  f.emit("bufferLevelUpdated", {sender:f.buffer}); await Promise.resolve(); assert.equal(f.starts(), 1);
  f.owner.destroy();
});

test("matching history cannot confirm the wrong decoded resolution", async () => {
  const f = await fixture(); f.video.videoHeight = 2160; f.requestQuality(0); f.frame(); f.frame();
  assert.equal(f.confirmations(), 0); assert.equal(f.events.length, 0); f.owner.destroy();
});

test("missing seek history waits for a matching media segment and consecutive decoded frames", async () => {
  const f = await fixture(); let history = null;
  f.processor.getFragmentModel = () => ({getRequests: () => [history]});
  f.requestQuality(0); f.frame(); f.frame(); assert.equal(f.confirmations(), 0);
  history = f.request; f.frame();
  history = null; f.frame(); assert.equal(f.confirmations(), 0);
  history = f.request; f.frame(); assert.equal(f.confirmations(), 0);
  f.frame(); assert.equal(f.confirmations(), 1); f.owner.destroy();
});

test("new target, request identity or changed fragment invalidates pending frame confirmation", async () => {
  for (const change of [f => f.requestQuality(1), f => { f.wrapper.qnSwitchingInfo.video = {...f.wrapper.qnSwitchingInfo.video}; }, f => { f.request.quality = 1; }]) {
    const f = await fixture(); f.requestQuality(0); f.frame(); change(f); f.frame();
    assert.equal(f.confirmations(), 0); f.owner.destroy();
  }
});

test("late rendered event cannot clear a newer request", async () => {
  const f = await fixture(); f.requestQuality(0); f.requestQuality(1);
  f.emit("qualityChangeRendered", {mediaType: "video", newQuality: 0});
  assert.equal(f.buffer.getIsBufferingCompleted(), false); f.owner.destroy();
});

test("timeout only restores bookkeeping and never reports success", async () => {
  const f = await fixture(); f.requestQuality(1); for (const fn of [...f.timers.values()]) fn();
  assert.equal(f.buffer.getIsBufferingCompleted(), true); assert.equal(f.confirmations(), 0); f.owner.destroy();
});

test("disable and destroy detach hooks, timers and decoded-frame callbacks", async () => {
  const f = await fixture(); f.requestQuality(0); f.settings.enabled = false; f.owner.applySettings();
  await Promise.resolve(); assert.equal(f.starts(), 0); assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.buffer.getIsBufferingCompleted, f.original); f.emit("qualityChangeRequested", {mediaType:"video",newQuality:1});
  assert.equal(f.timers.size, 0); f.owner.destroy();
});
