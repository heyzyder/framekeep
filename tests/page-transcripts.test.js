import test from 'node:test';
import assert from 'node:assert/strict';
import {installPageTranscripts} from '../extension/page-transcripts.js';

const event = () => ({listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(value) { for (const fn of this.listeners) fn(value); }});
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const metadata = title => ({title, tracks: [{language: 'en', name: 'English', automatic: false}]});
async function harness(t, stored = {}) {
  const natives = [], ports = [];
  const chrome = {runtime: {id: 'framekeep', onConnect: event(), connectNative() {
    const native = {requests: [], onMessage: event(), onDisconnect: event(), postMessage(message) { this.requests.push(message); }, disconnect() { this.closed = true; this.onDisconnect.emit(); }};
    natives.push(native); return native;
  }}, storage: {session: {async get() { return stored; }, async set(data) { Object.assign(stored, structuredClone(data)); }}}};
  installPageTranscripts(chrome);
  const page = (sender = {}) => {
    const port = {name: 'framekeep-page-transcript', sender: {id: 'framekeep', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', tab: {id: ports.length + 1}, frameId: 0, ...sender}, messages: [], onMessage: event(), onDisconnect: event(), postMessage(message) { this.messages.push(structuredClone(message)); }};
    ports.push(port); chrome.runtime.onConnect.emit(port); return port;
  };
  t.after(async () => { for (const port of ports) port.onDisconnect.emit(); await flush(); });
  const send = async (port, videoId = 'jNQXAC9IVRw', fields = {}) => { port.onMessage.emit({action: 'load', videoId, ...fields}); await flush(); };
  const reply = async (native, data, event = 'result') => { native.onMessage.emit({id: native.requests.at(-1).id, event, data, error: event === 'error' ? 'Caption unavailable' : undefined}); await flush(); };
  return {chrome, natives, stored, page, send, reply};
}

test('two page transcripts remain isolated and never request a download', async t => {
  const h = await harness(t), first = h.page(), second = h.page();
  await h.send(first); await h.send(second, '48jlHaxZnig');
  await h.reply(h.natives[0], metadata('First video')); await h.reply(h.natives[1], metadata('Second video'));
  await h.reply(h.natives[1], {language: 'en', cues: [{start: 2, text: 'Second captions'}]});
  await h.reply(h.natives[0], {language: 'en', cues: [{start: 1, text: 'First captions'}]});
  assert.equal(first.messages.at(-1).info.title, 'First video'); assert.equal(second.messages.at(-1).info.title, 'Second video');
  assert.equal(first.messages.at(-1).transcript.cues[0].text, 'First captions');
  assert.ok(h.natives.every(native => native.closed && native.requests.every(request => ['probe', 'transcript'].includes(request.action))));
});

test('SPA navigation cancels old extraction and drops late results', async t => {
  const h = await harness(t), page = h.page(); await h.send(page); const old = h.natives[0];
  await h.send(page, '48jlHaxZnig'); assert.equal(old.closed, true);
  await h.reply(old, metadata('Old source'));
  assert.ok(!page.messages.some(message => message.info?.title === 'Old source'));
  await h.reply(h.natives[1], {...metadata('New source'), tracks: []});
  assert.equal(page.messages.at(-1).status, 'unavailable'); assert.equal(page.messages.at(-1).videoId, '48jlHaxZnig');
});

test('page extraction concurrency is bounded and closing a page releases its slot', async t => {
  const h = await harness(t), pages = [h.page(), h.page(), h.page()];
  for (const page of pages) await h.send(page);
  assert.equal(h.natives.length, 2); assert.match(pages[2].messages.at(-1).message, /Waiting/);
  pages[0].onDisconnect.emit(); await flush(); assert.equal(h.natives.length, 3); assert.equal(h.natives[0].closed, true);
});

test('session cache avoids refetching and language changes remain validated', async t => {
  const entry = {videoId: 'jNQXAC9IVRw', info: metadata('Cached video'), transcript: {language: 'en', cues: [{start: 1, text: 'Cached captions'}]}};
  const h = await harness(t, {pageTranscriptCache: [entry]}), page = h.page(); await h.send(page);
  assert.equal(h.natives.length, 0); assert.equal(page.messages.at(-1).status, 'ready');
  await h.send(page, 'jNQXAC9IVRw', {language: 'de'});
  assert.equal(page.messages.at(-1).status, 'error'); assert.equal(h.natives[0].requests.length, 0);
  await h.send(page, 'jNQXAC9IVRw', {retry: true}); assert.equal(h.natives[1].requests[0].action, 'probe');
  await h.reply(h.natives[1], metadata('Refreshed source')); assert.equal(h.natives[1].requests.at(-1).action, 'transcript');
});

test('untrusted senders and malformed page requests cannot start native work', async t => {
  const h = await harness(t);
  for (const sender of [{id: 'another-extension'}, {url: 'https://www.youtube.com.evil.test/watch'}, {frameId: 1}, {tab: {}}]) await h.send(h.page(sender));
  const valid = h.page(); await h.send(valid, '../outside'); await h.send(valid, 'jNQXAC9IVRw', {language: 'en;calc'});
  assert.equal(h.natives.length, 0);
});

test('an old no-captions cache entry cannot hide a currently available transcript', async t => {
  const h = await harness(t, {pageTranscriptCache:[{videoId:'jNQXAC9IVRw',info:{title:'Old result',tracks:[]}}]});
  const page = h.page(); await h.send(page);
  assert.equal(h.natives.length,1); assert.equal(h.natives[0].requests[0].action,'probe');
  await h.reply(h.natives[0],metadata('Current video'));
  await h.reply(h.natives[0],{language:'en',cues:[{start:0,text:'Available now'}]});
  assert.equal(page.messages.at(-1).status,'ready'); assert.equal(page.messages.at(-1).transcript.cues[0].text,'Available now');
});
