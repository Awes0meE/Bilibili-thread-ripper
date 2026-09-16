"use strict";
// Runs the real service worker with a fake chrome API and checks the one-time 0.9.1.2 settings move.
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const source=fs.readFileSync(path.join(__dirname,"../src/service-worker.js"),"utf8");

function worker(initial){
  let sync={...initial};
  const listeners={installed:[],startup:[]},noop={addListener(){}};
  const chrome={
    storage:{sync:{
      async get(keys){return keys===null?{...sync}:{...keys,...sync};},
      async set(update){sync={...sync,...update};}
    }},
    sidePanel:{setPanelBehavior:()=>Promise.resolve()},
    action:{setBadgeBackgroundColor:()=>Promise.resolve(),setBadgeText:()=>Promise.resolve()},
    runtime:{onInstalled:{addListener:fn=>listeners.installed.push(fn)},onStartup:{addListener:fn=>listeners.startup.push(fn)},onMessage:noop},
    tabs:{onUpdated:noop}
  };
  vm.runInNewContext(source,{chrome,console,setTimeout,clearTimeout,URL,AbortController,DOMException,fetch:()=>Promise.reject(Error("offline"))});
  const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
  return {
    async install(){listeners.installed.forEach(fn=>fn({reason:"update"}));await settle();},
    async start(){listeners.startup.forEach(fn=>fn());await settle();},
    get:()=>({...sync}),
    set:update=>{sync={...sync,...update};}
  };
}

test("updating from 0.9.1.1 moves CDN, threads and error notices to the new defaults once",async()=>{
  const sw=worker({enabled:true,concurrency:32,mode:"overseas",errorNotices:true,debugNotices:true,compatibilityMode:"a",debugCategories:{download:false}});
  await sw.install();
  assert.deepEqual(sw.get(),{enabled:true,concurrency:8,mode:"mainland",errorNotices:false,debugNotices:true,compatibilityMode:"a",debugCategories:{download:false},settingsRevision:2});
  // Later choices are kept on the next browser start or extension reload.
  sw.set({concurrency:16,errorNotices:true,mode:"overseas"});
  await sw.start();await sw.install();
  assert.equal(sw.get().concurrency,16);assert.equal(sw.get().errorNotices,true);assert.equal(sw.get().mode,"overseas");
});

test("a fresh install only records the settings revision",async()=>{
  const sw=worker({});
  await sw.install();
  assert.deepEqual(sw.get(),{settingsRevision:2});
});
