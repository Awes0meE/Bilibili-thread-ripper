// Userscripts have no extension storage. This small stand-in keeps the parts of the
// chrome.* API that bridge.js uses and saves settings in this site's localStorage.
// Changes made in another bilibili tab arrive through the storage event.
const chrome = (() => {
  const PREFIX = "BTR_Userscript.";
  const listeners = new Set();
  const parse = (text) => {
    try {
      const value = JSON.parse(text || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (_error) {
      return {};
    }
  };
  const read = (area) => {
    try { return parse(localStorage.getItem(PREFIX + area)); }
    catch (_error) { return {}; }
  };
  const diff = (before, after) => {
    const changes = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = { oldValue: before[key], newValue: after[key] };
    }
    return changes;
  };
  const notify = (changes, area) => {
    if (!Object.keys(changes).length) return;
    for (const listener of listeners) {
      try { listener(changes, area); }
      catch (error) { console.error("BTR settings listener", error); }
    }
  };
  // No toolbar icon or background page: nothing sends messages here.
  const runtime = {
    lastError: null,
    sendMessage: () => Promise.resolve(),
    onMessage: { addListener() {} }
  };
  // Callers either pass a callback and read runtime.lastError, or await the promise.
  const finish = (value, callback, error = null) => {
    if (typeof callback !== "function") return error ? Promise.reject(error) : Promise.resolve(value);
    queueMicrotask(() => {
      runtime.lastError = error ? { message: String(error.message || error) } : null;
      try { callback(value); }
      finally { runtime.lastError = null; }
    });
    return Promise.resolve(value);
  };
  const write = (area, next) => {
    const before = read(area);
    try { localStorage.setItem(PREFIX + area, JSON.stringify(next)); }
    catch (error) { return error; }
    queueMicrotask(() => notify(diff(before, next), area));
    return null;
  };
  const storageArea = (area) => ({
    get(keys, callback) {
      const stored = read(area);
      let value;
      if (keys === null || keys === undefined) value = { ...stored };
      else if (typeof keys === "string") value = keys in stored ? { [keys]: stored[keys] } : {};
      else if (Array.isArray(keys)) value = Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]]));
      else value = Object.fromEntries(Object.keys(keys).map((key) => [key, key in stored ? stored[key] : keys[key]]));
      return finish(value, callback);
    },
    set(items, callback) {
      return finish(undefined, callback, write(area, { ...read(area), ...items }));
    },
    remove(keys, callback) {
      const next = read(area);
      for (const key of [].concat(keys)) delete next[key];
      return finish(undefined, callback, write(area, next));
    }
  });
  addEventListener("storage", (event) => {
    if (!event.key?.startsWith(PREFIX)) return;
    notify(diff(parse(event.oldValue), parse(event.newValue)), event.key.slice(PREFIX.length));
  });
  return Object.freeze({
    runtime,
    storage: Object.freeze({
      sync: storageArea("sync"),
      local: storageArea("local"),
      onChanged: { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) }
    })
  });
})();
