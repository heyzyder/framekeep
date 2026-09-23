import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import * as shared from '../extension/shared.js';
import {inspectMedia, mediaSource, uniqueMedia, previewImage} from '../extension/page-media.js';

const source = (await readFile(new URL('../extension/background.js', import.meta.url), 'utf8')).replace(/^import .*?;\s*/gm, '');
const url = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const info = {title: 'A test video', heights: [720], tracks: [{language: 'en', name: 'English', automatic: false}]};
const event = () => ({listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(value) { for (const fn of this.listeners) fn(value); }});
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

async function harness(t, {jobs = [], notifications = true, tab = null, media = [], manifest = {version: '1.6.0'}} = {}) {
  const requests = [], alerts = [], messages = [], timers = new Set();
  const local = {jobs, settings: {notifications}}, session = {};
  const storage = data => ({
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])); },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  });
  const native = {onMessage: event(), onDisconnect: event(), disconnect() {}, postMessage(message) {
    requests.push(message);
    if (['status', 'cancel'].includes(message.action)) queueMicrotask(() => native.onMessage.emit({id: message.id, event: 'result', data: {version: manifest.version_name || manifest.version, protocol:2, capabilities:['page-sources','parallel-downloads']}}));
  }};
  const chrome = {
    storage: {local: storage(local), session: storage(session)},
    runtime: {id: 'test', getManifest: () => manifest, onConnect: event(), onInstalled: event(), getURL: path => 'chrome-extension://test/' + path, connectNative: () => native},
    action: {async setBadgeText({text}) { chrome.badge = text; }, async setBadgeBackgroundColor() {}, async setTitle() {}},
    notifications: {async getPermissionLevel() { return 'granted'; }, async create(id, options) { alerts.push({id, ...options}); }, onClicked: event(), onButtonClicked: event()},
    contextMenus: {onClicked: event()}, tabs: {onActivated: event(), onUpdated: event(), async query(query) { return query.url ? [] : tab ? [tab] : []; }},
    webNavigation: {async getAllFrames() { return [{frameId: 0, url: tab?.url}]; }},
    permissions: {async contains() { return false; }},
    scripting: {async executeScript() { return [{result: {media}}]; }},
  };
  vm.runInNewContext(source, {...shared, inspectMedia, mediaSource, uniqueMedia, previewImage, chrome, console, URL, crypto: {randomUUID}, installPageTranscripts() {}, installCapture() {}, registerWidgetVisibility() {}, installBrowserTranscription(){return {isActive:()=>false,disconnected(){}};},
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timers.add(timer); return timer; }, clearTimeout,
  });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const port = {name: 'framekeep-popup', sender: {id: 'test'}, onMessage: event(), onDisconnect: event(), postMessage(message) {
    const copy = structuredClone(message);
    if (copy.transcript?.unchanged) copy.transcript.cues = messages.at(-1)?.transcript?.cues;
    messages.push(copy);
  }};
  chrome.runtime.onConnect.emit(port);
  const send = async (action, data = {}) => { port.onMessage.emit({action, ...data}); await flush(); };
  const respond = async (id, data) => { native.onMessage.emit({id, ...data}); await flush(); };
  await send('init');
  const probe = async (metadata = info) => {
    await send('analyze', {url});
    await respond(requests.findLast(x => x.action === 'probe').id, {event: 'result', data: metadata});
  };
  return {chrome, alerts, requests, messages, send, respond, probe, local, session, setTab(value) { tab = value; }, get state() { return messages.at(-1); }};
}

test('matching prerelease helper is recognized without repeated reconnects', async t => {
  const h = await harness(t, {manifest: {version: '1.8.0', version_name: '1.8.0-beta.2'}});
  assert.equal(h.state.workerVersion, '1.8.0-beta.2');
  assert.equal(h.state.helper.status, 'ready');
  await h.send('check');
  assert.equal(h.requests.filter(request => request.action === 'status').length, 1);
});

test('opening on a course automatically detects and checks its single video without starting a download', async t => {
  const h = await harness(t, {tab:{id:1,url:'https://course.example/lesson/one',title:'Lesson one'}, media:[{type:'direct',url:'https://cdn.example/one.m3u8?token=test',title:'Lesson one'}]});
  assert.equal(h.state.page.candidates.length,1); assert.equal(h.state.probe.status,'loading');
  const probe=h.requests.find(x=>x.action==='probe'); assert.equal(probe.source.pageUrl,'https://course.example/lesson/one');
  assert.equal(h.requests.some(x=>x.action==='download'),false);
  await h.respond(probe.id,{event:'result',data:{...info,tracks:[]}});
  assert.equal(h.state.probe.info.title,'Lesson one');
  await h.send('scan'); assert.equal(h.requests.filter(x=>x.action==='probe').length,1);
});

test('floating video choice is consumed by the popup with its exact embedded source',async t=>{
  const tab={id:9,url:'https://course.example/lesson'};
  const h=await harness(t,{tab});
  h.session.captureVideoContext={tabId:9,pageUrl:tab.url,url:'https://player.vimeo.com/video/12345',source:{url:'https://player.vimeo.com/video/12345',pageUrl:tab.url,type:'embed',title:'Selected embedded video'}};
  await h.send('init');const request=h.requests.findLast(x=>x.action==='probe');
  assert.equal(request.url,'https://player.vimeo.com/video/12345');assert.equal(request.source.title,'Selected embedded video');assert.equal(h.session.captureVideoContext,undefined);assert.equal(h.requests.some(x=>x.action==='download'),false);
});

test('floating audio choice carries a fresh MP3 intent even when saved preference is video',async t=>{
  const tab={id:9,url};const h=await harness(t,{tab});
  h.session.captureVideoContext={tabId:9,pageUrl:url,url,kind:'audio'};
  await h.send('init');assert.equal(h.state.formatIntent.kind,'audio');assert.ok(h.state.formatIntent.id);
  assert.equal(h.requests.some(x=>x.action==='download'),false);
});

test('a floating selection from another tab is discarded rather than analyzed',async t=>{
  const h=await harness(t,{tab:{id:9,url:'https://course.example/lesson'}});
  h.session.captureVideoContext={tabId:8,pageUrl:'https://course.example/lesson',url:'https://player.vimeo.com/video/12345'};
  await h.send('init');assert.equal(h.requests.some(x=>x.action==='probe'),false);assert.equal(h.session.captureVideoContext,undefined);
});

test('multiple page videos remain selectable and navigating to another course clears the old preview', async t => {
  const media=[{type:'direct',url:'https://cdn.example/one.mp4',title:'One'},{type:'direct',url:'https://cdn.example/two.mp4',title:'Two'}];
  const h=await harness(t,{tab:{id:1,url:'https://course.example/lesson',title:'Course'},media});
  assert.equal(h.state.page.candidates.length,2); assert.equal(h.requests.some(x=>x.action==='probe'),false);
  await h.send('page-video',{id:h.state.page.candidates[1].id});
  await h.respond(h.requests.findLast(x=>x.action==='probe').id,{event:'result',data:{...info,tracks:[]}});
  assert.equal(h.state.probe.url,'https://cdn.example/two.mp4');
  h.setTab({id:1,url:'https://course.example/next',title:'Next'}); media.length=0;
  await h.send('scan'); assert.equal(h.state.probe.status,'idle'); assert.equal(h.state.transcript.status,'idle');
});

test('opening a supported platform checks that video directly and active downloads survive a scan', async t => {
  const h=await harness(t,{tab:{id:1,url,title:'YouTube'}});
  assert.equal(h.state.page.platformUrl,url);
  await h.respond(h.requests.findLast(x=>x.action==='probe').id,{event:'result',data:{...info,tracks:[]}});
  await h.send('download',{kind:'video',quality:'720'});
  h.setTab({id:2,url:'https://course.example/next',title:'Next'}); await h.send('scan');
  assert.equal(h.state.jobs[0].status,'starting'); assert.equal(h.state.probe.status,'idle');
  assert.equal(h.requests.filter(x=>x.action==='probe').length,1);
});

test('switching tabs during a download selects the new video and ignores late metadata from the old tab', async t => {
  const media=[{type:'direct',url:'https://cdn.example/one.mp4',title:'One'}];
  const h=await harness(t,{tab:{id:1,url:'https://course.example/one'},media});
  await h.respond(h.requests.findLast(x=>x.action==='probe').id,{event:'result',data:{...info,tracks:[]}});
  await h.send('download',{kind:'video',quality:'720'});
  const jobId=h.state.jobs[0].id;
  h.setTab({id:2,url:'https://course.example/two'}); media[0]={type:'direct',url:'https://cdn.example/two.mp4',title:'Two'};
  h.chrome.tabs.onActivated.emit({tabId:2}); await flush();
  const oldProbe=h.requests.findLast(x=>x.action==='probe');
  assert.equal(h.state.probe.url,'https://cdn.example/two.mp4');
  h.setTab({id:3,url:'https://course.example/three'}); media[0]={type:'direct',url:'https://cdn.example/three.mp4',title:'Three'};
  await h.send('scan');
  const newProbe=h.requests.findLast(x=>x.action==='probe');
  await h.respond(newProbe.id,{event:'result',data:{...info,tracks:[]}});
  await h.respond(oldProbe.id,{event:'result',data:{...info,title:'Stale reply',tracks:[]}});
  assert.equal(h.state.probe.info.title,'Three'); assert.equal(h.state.jobs[0].id,jobId);
  assert.equal(h.state.jobs[0].title,'One');
  await h.respond(jobId,{event:'progress',percent:40,downloaded:400,total:1000});
  assert.equal(h.state.probe.info.title,'Three'); assert.equal(h.state.jobs[0].percent,40);
  assert.ok(h.requests.some(x=>x.action==='cancel'&&x.target===oldProbe.id));
  assert.ok(!h.requests.some(x=>x.action==='cancel'&&x.target===jobId));
});

test('real worker handlers retain progress fields and notify only on verified completion', async t => {
  const h = await harness(t); await h.probe();
  assert.equal(h.state.transcript.status, 'loading');
  await h.send('download', {kind: 'video', quality: '720'});
  const id = h.state.jobs[0].id;
  assert.equal(h.state.jobs[0].status, 'starting');
  await h.respond(id, {event: 'progress', percent: 35, downloaded: 350, total: 1000, speed: 20, eta: 33, stage: 'video'});
  assert.equal(h.state.jobs[0].downloaded, 350); assert.equal(h.chrome.badge, '35%'); assert.equal(h.alerts.length, 0);
  await h.respond(id, {event: 'progress', phase: 'processing', percent: null});
  assert.equal(h.state.jobs[0].status, 'processing'); assert.equal(h.alerts.length, 0);
  await h.respond(id, {event: 'complete', filename: 'video.mp4', bytes: 1000});
  assert.equal(h.state.jobs[0].unread, true); assert.equal(h.chrome.badge, '✓'); assert.equal(h.alerts.length, 1);
  await h.respond(id, {event: 'complete', filename: 'video.mp4', bytes: 1000});
  assert.equal(h.alerts.length, 1);
  await h.send('acknowledge'); assert.equal(h.chrome.badge, ''); assert.equal(h.local.jobs[0].unread, false);
});

test('parallel downloads retain every active job beyond the history limit and cancel independently', async t => {
  const h=await harness(t); await h.probe({...info,tracks:[],heights:Array.from({length:16},(_,i)=>144+i)});
  for(let i=0;i<16;i++) await h.send('download',{kind:'video',quality:String(144+i)});
  assert.equal(h.state.jobs.length,16); assert.equal(h.local.jobs.length,16); assert.equal(h.chrome.badge,'16');
  const oldest=h.state.jobs.at(-1).id, second=h.state.jobs.at(-2).id;
  await h.respond(oldest,{event:'progress',percent:25,downloaded:250,total:1000});
  await h.respond(second,{event:'progress',percent:70,downloaded:700,total:1000});
  assert.equal(h.state.jobs.find(j=>j.id===oldest).percent,25);
  await h.send('cancel',{id:second}); await h.respond(second,{event:'cancelled'});
  assert.equal(h.state.jobs.find(j=>j.id===oldest).status,'downloading');
  for(const job of h.state.jobs.filter(j=>j.id!==oldest&&j.id!==second)) await h.respond(job.id,{event:'complete',filename:job.id+'.mp4',bytes:10});
  assert.ok(h.local.jobs.some(j=>j.id===oldest));
  assert.equal(h.local.jobs.filter(j=>!shared.ACTIVE.has(j.status)).length,12);
  await h.send('download',{kind:'video',quality:'144'});
  assert.equal(h.requests.filter(r=>r.action==='download').length,16,'Duplicate start is rejected');
});

test('caption loading runs alongside a download and stays cached through progress', async t => {
  const h = await harness(t); await h.probe();
  const caption = h.requests.findLast(x => x.action === 'transcript');
  await h.send('download', {kind: 'audio', quality: '192'});
  await h.respond(caption.id, {event: 'result', data: {language: 'en', cues: [{start: 1, duration: 2, text: 'Available source captions'}], truncated: false}});
  assert.equal(h.state.transcript.status, 'ready'); assert.equal(h.session.transcript.cues.length, 1);
  await h.respond(h.state.jobs[0].id, {event: 'progress', percent: 20});
  assert.equal(h.state.transcript.cues[0].text, 'Available source captions');
});

test('invalid new source clears captions and ignores a late result from the old video', async t => {
  const h = await harness(t); await h.probe();
  const caption = h.requests.findLast(x => x.action === 'transcript');
  await h.send('analyze', {url: 'file:///private/video'});
  await h.respond(caption.id, {event: 'result', data: {cues: [{start: 0, duration: 1, text: 'Old video'}]}});
  assert.equal(h.state.probe.status, 'error'); assert.equal(h.state.transcript.status, 'idle');
  assert.equal(h.session.probe, undefined); assert.equal(h.session.transcript, undefined);
  assert.ok(h.requests.some(x => x.action === 'cancel' && x.target === caption.id));
});

test('missing and failed captions are distinct from successful transcripts', async t => {
  const h = await harness(t); await h.probe({...info, tracks: []});
  assert.equal(h.state.transcript.status, 'unavailable'); assert.ok(!h.requests.some(x => x.action === 'transcript'));
  await h.probe();
  await h.respond(h.requests.findLast(x => x.action === 'transcript').id, {event: 'error', error: 'Captions unavailable'});
  assert.equal(h.state.transcript.status, 'error');
  await h.send('transcript', {language: 'en'});
  await h.respond(h.requests.findLast(x => x.action === 'transcript').id, {event: 'cancelled'});
  assert.equal(h.state.transcript.status, 'error');
});

test('mute keeps a completion badge, while cancellation never shows success', async t => {
  const h = await harness(t, {notifications: false}); await h.probe({...info, tracks: []});
  await h.send('download', {kind: 'audio', quality: '192'});
  const id = h.state.jobs[0].id;
  await h.send('cancel', {id});
  await h.respond(id, {event: 'progress', percent: 50}); assert.equal(h.state.jobs[0].status, 'cancelling');
  await h.respond(id, {event: 'cancelled'}); assert.equal(h.state.jobs[0].status, 'cancelled'); assert.equal(h.alerts.length, 0);
  await h.send('download', {kind: 'audio', quality: '192'});
  await h.respond(h.state.jobs[0].id, {event: 'complete', bytes: 200, filename: 'audio.mp3'});
  assert.equal(h.chrome.badge, '✓'); assert.equal(h.alerts.length, 0);
});

test('a failed download alerts once and a browser restart exposes interrupted work', async t => {
  const h = await harness(t, {jobs: [{id: 'interrupted', title: 'Previous file', status: 'downloading'}]});
  assert.equal(h.state.jobs[0].status, 'interrupted'); assert.equal(h.chrome.badge, '!');
  await h.probe({...info, tracks: []}); await h.send('download', {kind: 'video', quality: '720'});
  await h.respond(h.state.jobs[0].id, {event: 'error', error: 'Connection failed'});
  assert.equal(h.state.jobs[0].status, 'error'); assert.equal(h.chrome.badge, '!');
  assert.equal(h.alerts.length, 1); assert.equal(h.alerts[0].title, 'Download needs attention');
});

test('delete uses the recorded filename and updates duplicate entries only after confirmation', async t => {
  const jobs = [{id:'a', title:'A', status:'complete', filename:'lesson.mp4'}, {id:'b', title:'B', status:'complete', filename:'lesson.mp4'}, {id:'c', title:'C', status:'complete', filename:'other.mp4'}];
  const h = await harness(t, {jobs});
  await h.send('trash', {id:'a', filename:'outside.mp4'});
  const request = h.requests.findLast(x => x.action === 'trash');
  assert.equal(request.filename, 'lesson.mp4'); assert.equal(h.state.jobs[0].fileState, 'trashing');
  await h.respond(request.id, {event:'result', data:{fileState:'trashed'}});
  assert.equal(h.local.jobs.length,1); assert.equal(h.local.jobs[0].filename,'other.mp4');
  await h.send('trash', {id:'a'}); assert.equal(h.requests.filter(x=>x.action==='trash').length,1);
});

test('failed deletion preserves the completed download and offers a retry', async t => {
  const h = await harness(t, {jobs:[{id:'a', title:'A', status:'complete', filename:'lesson.mp4'}]});
  await h.send('trash', {id:'a'});
  await h.respond(h.requests.findLast(x=>x.action==='trash').id, {event:'error', error:'File is in use'});
  assert.equal(h.state.jobs[0].status,'complete'); assert.equal(h.state.jobs[0].fileState,'error'); assert.equal(h.state.jobs[0].fileError,'File is in use');
});
