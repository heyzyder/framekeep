import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {installPageTranscripts} from '../extension/page-transcripts.js';

// Offline integration: run the actual content script and caption router, with
// synthetic DOM/ports/native replies. No browser, provider, or user media access.
const source = await readFile(new URL('../extension/youtube-transcript.js', import.meta.url), 'utf8');
const videoA = 'aaaaaaaaaaa', videoB = 'bbbbbbbbbbb';
const watchUrl = (id = videoA, hash = '') => `https://www.youtube.com/watch?v=${id}${hash}`;
const metadata = (title = 'Fixture video') => ({title, tracks: [{language: 'en', name: 'English', automatic: true}]});
const transcript = {language: 'en', cues: [{start: 0, text: 'SYNTHETIC opening caption'}, {start: 9, text: 'SYNTHETIC second caption'}]};
const cached = () => ({videoId: videoA, info: metadata(), transcript: {...transcript, name: 'English', automatic: true}});
const event = () => ({listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(value) { for (const fn of [...this.listeners]) fn(value); }});
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {};
    this.value = ''; this._text = ''; this.hidden = false; this.disabled = false;
    this.classList = {toggle() {}};
  }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  prepend(node) { this.append(node); this.children.unshift(this.children.pop()); }
  insertBefore(node, before) { if (!before) this.append(node); else { node.remove(); node.parentElement = this; this.children.splice(this.children.indexOf(before), 0, node); } }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  replaceChildren(...nodes) { for (const node of [...this.children]) node.remove(); this._text = ''; this.append(...nodes); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  get isConnected() { return !!this.root || !!this.parentElement?.isConnected; }
  getBoundingClientRect() { return {width: 400}; }
  compareDocumentPosition() { return 0; }
  querySelector(selector) { return selector.startsWith('#') && !selector.includes(',') ? this.getElementById(selector.slice(1)) : null; }
  getElementById(id) { if (this.id === id) return this; for (const child of this.children) { const found = child.getElementById(id); if (found) return found; } return null; }
  attachShadow() { return this.shadowRoot = new Element('shadow-root'); }
  click() { if (!this.disabled) return this.onclick?.(); }
  set innerHTML(markup) {
    this.replaceChildren(); const stack = [this];
    for (const token of markup.matchAll(/<\/?([a-z][\w-]*)([^>]*)>|([^<]+)/gi)) {
      if (token[3]) { const text = new Element('#text'); text._text = token[3]; stack.at(-1).append(text); continue; }
      if (token[0].startsWith('</')) { stack.pop(); continue; }
      const node = new Element(token[1]);
      for (const attr of token[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
        const [, name, value = ''] = attr; node.setAttribute(name, value);
        if (['hidden', 'disabled', 'checked'].includes(name)) node[name] = true;
        else if (name === 'id') node.id = value;
      }
      stack.at(-1).append(node);
      if (!['input', 'br', 'img'].includes(token[1])) stack.push(node);
    }
  }
}

async function harness(t, {href = watchUrl(), cache = [], watchPresent = true, marker} = {}) {
  const natives = [], clients = [], outgoing = [], stored = {pageTranscriptCache: cache};
  const runtime = {id: 'framekeep', onConnect: event(), connectNative() {
    const native = {requests: [], onMessage: event(), onDisconnect: event(), postMessage(message) { this.requests.push(message); }, disconnect() { if (!this.closed) { this.closed = true; this.onDisconnect.emit(); } }};
    natives.push(native); return native;
  }};
  installPageTranscripts({runtime, storage: {session: {async get() { return stored; }, async set(value) { Object.assign(stored, structuredClone(value)); }}}});
  const location = {href, reload() { this.reloaded = true; }};
  const listeners = new Map(), timers = new Map(), observers = [];
  const addListener = (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); };
  const emit = name => { for (const fn of listeners.get(name) || []) fn(); };
  const html = new Element('html'); html.root = true;
  const watch = new Element('ytd-watch-flexy'), secondary = new Element('div'); secondary.id = 'secondary-inner';
  watch.append(secondary); if (watchPresent) html.append(watch);
  const document = {documentElement: html, createElement: tag => new Element(tag), getElementById: id => html.getElementById(id),
    querySelector: selector => selector === 'ytd-watch-flexy' && watch.isConnected ? watch : null, addEventListener: addListener};
  const chrome = {runtime: {...runtime, connect({name}) {
    const client = {onMessage: event(), onDisconnect: event()};
    const server = {name, sender: {id: runtime.id, url: location.href, tab: {id: 1}, frameId: 0}, onMessage: event(), onDisconnect: event()};
    client.postMessage = message => { outgoing.push(structuredClone(message)); queueMicrotask(() => { if (!client.closed) server.onMessage.emit(message); }); };
    server.postMessage = message => queueMicrotask(() => { if (!client.closed) client.onMessage.emit(structuredClone(message)); });
    client.disconnect = () => { if (!client.closed) { client.closed = true; server.onDisconnect.emit(); client.onDisconnect.emit(); } };
    clients.push(client); runtime.onConnect.emit(server); return client;
  }}};
  let timerId = 0, copied;
  const context = vm.createContext({document, location, chrome, URL, URLSearchParams, Blob, Node: {DOCUMENT_POSITION_PRECEDING: 2},
    navigator: {clipboard: {async writeText(text) { copied = text; }}}, addEventListener: addListener,
    MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() {} },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, {fn, delay}); return id; }, clearTimeout(id) { timers.delete(id); },
    ...(marker ? {__framekeepTranscript: marker} : {})});
  vm.runInContext(source, context);
  t.after(async () => { for (const client of clients) client.disconnect(); await flush(); });
  const h = {location, html, watch, document, clients, natives, outgoing, context, emit, timers,
    get host() { return document.getElementById('framekeep-transcript'); },
    get copied() { return copied; },
    get shadow() { return this.host?.shadowRoot; },
    $(id) { return this.shadow?.getElementById(id); },
    async navigate(url, eventName = 'yt-navigate-finish') { location.href = url; emit(eventName); await flush(); },
    async runTimers() { const pending = [...timers]; timers.clear(); for (const [, timer] of pending) timer.fn(); await flush(); },
    async layout() { observers[0].callback(); await this.runTimers(); },
    async reply(native, data) { native.onMessage.emit({id: native.requests.at(-1).id, event: 'result', data}); await flush(); },
    async load() { this.$('load-captions').click(); await flush(); },
    async complete() { await this.reply(natives.at(-1), metadata()); await this.reply(natives.at(-1), transcript); },
    injectAgain() { vm.runInContext(source, context); }};
  await flush(); return h;
}

function paused(h) {
  assert.equal(h.host.dataset.captionMode, 'intake'); assert.equal(h.host.dataset.captionState, 'paused');
  assert.equal(h.$('intake').hidden, false); assert.equal(h.$('caption-content').hidden, true);
  assert.equal(h.$('cues').children.length, 0); assert.doesNotMatch(h.shadow.textContent, /SYNTHETIC/);
  assert.equal(h.$('load-captions').textContent, 'Load captions');
}

test('initial intake blocks port, native work and warm-cache caption DOM before first load', async t => {
  const href = watchUrl(videoA, '#framekeep=intake');
  const h = await harness(t, {href, cache: [cached()]});
  paused(h); assert.equal(h.clients.length, 0); assert.equal(h.natives.length, 0); assert.equal(h.outgoing.length, 0);
  assert.equal(h.location.href, href); assert.equal(h.host.dataset.videoId, videoA);
  await h.layout(); paused(h); assert.equal(h.clients.length, 0);
});

test('ordinary URLs still automatically load captions and retain search/copy/collapse controls', async t => {
  const href = watchUrl(videoA, '&list=fixture&t=12#t=12');
  const h = await harness(t, {href});
  assert.equal(h.natives.length, 1); assert.equal(h.natives[0].requests[0].action, 'probe');
  assert.equal(h.natives[0].requests[0].url, watchUrl());
  await h.complete(); assert.equal(h.$('cues').children.length, 2);
  h.$('search').value = 'second'; h.$('search').oninput(); assert.equal(h.$('cues').children.length, 1);
  await h.$('copy').click(); assert.match(h.copied, /opening caption[\s\S]*second caption/);
  h.$('collapse').click(); assert.equal(h.$('body').hidden, true);
  assert.equal(h.location.href, href); assert.equal(h.host.dataset.captionMode, 'normal');
});

test('intentional intake Load captions reuses a warm cache only after the click', async t => {
  const h = await harness(t, {href: watchUrl(videoA, '#framekeep=intake'), cache: [cached()]});
  await h.load(); assert.equal(h.$('cues').children.length, 2); assert.equal(h.natives.length, 0);
  assert.equal(h.outgoing.length, 1); assert.equal(h.host.dataset.captionMode, 'intake');
  await h.layout(); assert.equal(h.outgoing.length, 1); assert.equal(h.$('cues').children.length, 2);
});

test('intentional cold-cache loading still uses the normal probe and transcript pipeline', async t => {
  const h = await harness(t, {href: watchUrl(videoA, '#framekeep=intake')});
  await h.load(); await h.complete(); assert.equal(h.$('cues').children.length, 2);
  assert.deepEqual(h.natives[0].requests.map(request => request.action), ['probe', 'transcript']);
  assert.equal(h.natives[0].closed, true); assert.equal(h.host.dataset.captionState, 'ready');
});

test('SPA next-video navigation retains intake, revokes permission and drops late old-port results', async t => {
  const h = await harness(t, {href: watchUrl(videoA, '#framekeep=intake'), cache: [cached()]});
  await h.load(); const old = h.clients[0];
  await h.navigate(watchUrl(videoB)); paused(h); assert.equal(old.closed, true);
  assert.equal(h.host.dataset.videoId, videoB); assert.equal(h.outgoing.length, 1);
  for (const videoId of [videoA, videoB]) old.onMessage.emit({status: 'ready', ...cached(), videoId});
  paused(h); assert.equal(h.natives.length, 0);
  await h.load(); assert.equal(h.natives.length, 1); assert.equal(h.outgoing.at(-1).videoId, videoB);
});

test('intake selected on a non-watch page survives SPA arrival and leaving/revisiting the video', async t => {
  const h = await harness(t, {href: 'https://www.youtube.com/#framekeep=intake'});
  assert.equal(h.host, null);
  await h.navigate(watchUrl()); paused(h); assert.equal(h.clients.length, 0);
  await h.load(); await h.complete();
  await h.navigate('https://www.youtube.com/results?search_query=fixture'); assert.equal(h.host, null);
  await h.navigate(watchUrl()); paused(h); assert.equal(h.outgoing.length, 1);
});

test('initial directive is honored even when watch layout arrives after YouTube drops its fragment', async t => {
  const h = await harness(t, {href: watchUrl(videoA, '#framekeep=intake'), watchPresent: false});
  assert.equal(h.clients.length, 0);
  h.location.href = watchUrl(); h.html.append(h.watch); await h.layout();
  paused(h); assert.equal(h.clients.length, 0);
});

test('switching a loaded normal page to intake removes cached text instead of just hiding it', async t => {
  const h = await harness(t, {cache: [cached()]}); assert.equal(h.$('cues').children.length, 2);
  await h.navigate(watchUrl(videoA, '#framekeep=intake'), 'hashchange'); paused(h);
  h.clients[0].onMessage.emit({status: 'ready', ...cached()}); paused(h);
  assert.equal(h.outgoing.length, 1); assert.equal(h.clients[0].closed, true);
});

test('a response arriving before the SPA/hash event cannot expose captions under the new intake URL', async t => {
  const h = await harness(t); const old = h.clients[0];
  h.location.href = watchUrl(videoA, '#framekeep=intake');
  old.onMessage.emit({status: 'ready', ...cached()}); await flush();
  paused(h); assert.equal(old.closed, true); assert.equal(h.natives[0].closed, true);
  assert.equal(h.natives[0].requests.length, 1);
});

test('pending reconnect cannot fetch after entering intake without a navigation event', async t => {
  const h = await harness(t); h.clients[0].disconnect();
  assert.equal(h.timers.size, 1);
  h.location.href = watchUrl(videoA, '#framekeep=intake'); await h.runTimers();
  paused(h); assert.equal(h.clients.length, 1); assert.equal(h.natives.length, 1);
});

test('an invalidated port cannot prevent removal of already-loaded captions on entering intake', async t => {
  const h = await harness(t, {cache: [cached()]});
  const client = h.clients[0], disconnect = client.disconnect;
  client.disconnect = () => { throw new Error('Extension context invalidated.'); };
  try {
    await h.navigate(watchUrl(videoA, '#framekeep=intake'), 'hashchange'); paused(h);
    client.onMessage.emit({status: 'ready', ...cached()}); paused(h);
  } finally { client.disconnect = disconnect; disconnect(); }
});

test('explicit normal directive restores automatic caption loading only in its document', async t => {
  const h = await harness(t, {href: watchUrl(videoA, '#framekeep=intake'), cache: [cached()]});
  const other = await harness(t, {href: watchUrl(videoA, '#framekeep=intake'), cache: [cached()]});
  await h.navigate(watchUrl(videoA, '#framekeep=normal'), 'hashchange');
  assert.equal(h.host.dataset.captionMode, 'normal'); assert.equal(h.$('cues').children.length, 2);
  paused(other); assert.equal(other.clients.length, 0);
  await h.navigate(watchUrl(videoB)); assert.equal(h.outgoing.at(-1).videoId, videoB);
});

test('fragment parameters preserve existing source/timestamp data; intake wins conflicting directives', async t => {
  const href = watchUrl(videoA, '&list=fixture#t=12&framekeep=normal&framekeep=intake');
  const h = await harness(t, {href}); paused(h); assert.equal(h.location.href, href); assert.equal(h.clients.length, 0);
  await h.navigate(watchUrl(videoA, '#other=value')); paused(h);
});

test('query parameters, unrelated fragments and a new document keep normal behavior', async t => {
  for (const hash of ['&framekeep=intake', '#framekeep=unknown', '#other=intake', '']) {
    const h = await harness(t, {href: watchUrl(videoA, hash), cache: [cached()]});
    assert.equal(h.host.dataset.captionMode, 'normal'); assert.equal(h.$('cues').children.length, 2);
  }
});

test('a new directed intake navigation revokes the previous same-video opt-in', async t => {
  const h = await harness(t, {href: watchUrl(videoA, '#framekeep=intake'), cache: [cached()]});
  await h.load(); await h.navigate(watchUrl(videoA, '&t=30#framekeep=intake')); paused(h);
  assert.equal(h.outgoing.length, 1);
});

test('source change cancels active work before missing layout can defer placement', async t => {
  const h = await harness(t, {href: watchUrl(videoA, '#framekeep=intake')});
  await h.load(); h.watch.remove(); await h.navigate(watchUrl(videoB));
  assert.equal(h.natives[0].closed, true); assert.equal(h.clients[0].closed, true);
  h.html.append(h.watch); await h.layout(); paused(h); assert.equal(h.outgoing.length, 1);
});

test('normal SPA navigation still clears the prior transcript and auto-loads the next source', async t => {
  const h = await harness(t, {cache: [cached()]});
  await h.navigate(watchUrl(videoB)); assert.equal(h.$('cues').children.length, 0);
  assert.equal(h.natives[0].requests[0].url, watchUrl(videoB));
  await h.complete(); assert.equal(h.$('cues').children.length, 2); assert.equal(h.host.dataset.videoId, videoB);
});

test('script repair never creates a second client over an existing old or current injection', async t => {
  const old = await harness(t, {marker: '1.4.0'}); assert.equal(old.clients.length, 0); assert.equal(old.host, null);
  const current = await harness(t, {cache: [cached()]}); current.injectAgain(); await flush();
  assert.equal(current.clients.length, 1); assert.equal(current.context.__framekeepTranscript, '1.6.0-intake.1');
});
