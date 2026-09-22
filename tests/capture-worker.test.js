import test from 'node:test';
import assert from 'node:assert/strict';
import {installCapture} from '../extension/capture-worker.js';
import {randomUUID} from 'node:crypto';
const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);},emit(...a){for(const fn of this.listeners)fn(...a);}});
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
function harness(t){
  const natives=[],storage={},timers=[];
  const chrome={runtime:{id:'fixture',onConnect:event(),connectNative(){const p={onMessage:event(),onDisconnect:event(),sent:[],postMessage(m){this.sent.push(m);},disconnect(){this.onDisconnect.emit();}};natives.push(p);return p;}},storage:{session:{async get(){return storage;},async set(x){Object.assign(storage,x);}}},tabs:{async get(id){return{id,url:'https://example.org/gallery'};}},webNavigation:{async getFrame(){return{url:'https://example.org/gallery'};}},action:{async openPopup(){}}};
  const connect=(tabId=1,frameId=0)=>{const messages=[],p={name:'framekeep-capture',sender:{id:'fixture',tab:{id:tabId},frameId,url:'https://example.org/gallery'},onMessage:event(),onDisconnect:event(),postMessage(m){messages.push(structuredClone(m));}};chrome.runtime.onConnect.emit(p);return{messages,send:m=>p.onMessage.emit(m),p};};
  installCapture(chrome);t.after(()=>{for(const p of natives)p.disconnect();});return{chrome,natives,connect};
}
test('discovery normalizes URLs, rejects executable sources and keeps MIME-dependent status honest',()=>{
  const {item}=globalThis.FramekeepCapture;
  assert.equal(item('javascript:alert(1)','https://example.org','image'),null);
  assert.equal(item('data:image/png;base64,aa','https://example.org','image'),null);
  assert.equal(item('/photo.png','https://example.org','image').sanitization,'automatic');
  assert.equal(item('/photo.webp','https://example.org','image').sanitization,'by-format');
  assert.equal(item('/song.mp3','https://example.org','audio').kind,'audio');
  assert.equal(item('/playlist.m3u8','https://example.org','video').stream,true);
});
test('only top-frame trusted extension content can start capture',async t=>{
  const h=harness(t),bad=h.connect(1,2);bad.send({action:'capture',items:[{url:'https://example.org/a.png',kind:'image'}]});await flush();assert.equal(h.natives.length,0);
});
test('completion stays isolated to its originating tab and records verified filenames',async t=>{
  const h=harness(t),one=h.connect(1),two=h.connect(2);
  one.send({action:'capture',items:[{url:'https://cdn.example.org/a.png',kind:'image'}]});await flush();assert.equal(h.natives.length,1);
  const n=h.natives[0],id=n.sent[0].id;n.onMessage.emit({id,event:'complete',folder:'Capture-fixture',files:[{filename:'001-a.png',sanitized:true}]});await flush();
  assert.equal(one.messages.at(-1).run.status,'complete');assert.equal(two.messages.length,0);
});
test('invalid mixed selection and duplicate batch starts do not open extra native jobs',async t=>{
  const h=harness(t),one=h.connect();
  one.send({action:'capture',items:[{url:'file:///private/a.png',kind:'image'}]});await flush();assert.equal(h.natives.length,0);
  const m={action:'capture',items:[{url:'https://example.org/a.png',kind:'image'}]};one.send(m);await flush();one.send(m);await flush();assert.equal(h.natives.length,1);assert.match(one.messages.at(-1).error,/already/);
});
test('same-document navigation accepts only the newly verified page URL',async t=>{
  const h=harness(t),one=h.connect();
  h.chrome.webNavigation.getFrame=async()=>({url:'https://example.org/next'});
  one.send({action:'capture',pageUrl:'https://example.org/gallery',items:[{url:'https://example.org/a.png',kind:'image'}]});await flush();assert.equal(h.natives.length,0);
  one.send({action:'capture',pageUrl:'https://example.org/next',items:[{url:'https://example.org/a.png',kind:'image'}]});await flush();assert.equal(h.natives.length,1);
});

test('video page identities distinguish watch, Shorts and embeds from channels and lookalikes',()=>{
  const {youtubePage,player}=FramekeepCapture;
  for(const url of ['https://www.youtube.com/watch?v=jNQXAC9IVRw&t=2','https://www.youtube.com/shorts/jNQXAC9IVRw','https://www.youtube-nocookie.com/embed/jNQXAC9IVRw'])assert.equal(youtubePage(url).url,'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  for(const url of ['https://www.youtube.com/','https://www.youtube.com/@channel','https://youtube.com.evil.example/watch?v=jNQXAC9IVRw'])assert.equal(youtubePage(url),null);
  assert.equal(player('https://www.youtube.com/watch?v=jNQXAC9IVRw',null,{title:'A video'}).filename,'A video');
});

test('playing YouTube video opens the exact selected video without starting a download',async t=>{
  const h=harness(t),one=h.connect(),url='https://www.youtube.com/watch?v=jNQXAC9IVRw#framekeep=intake';
  one.p.sender.url=url;h.chrome.webNavigation.getFrame=async()=>({url});let opened=0;h.chrome.action.openPopup=async()=>opened++;
  one.send({action:'video-tools',pageUrl:url,url:'https://www.youtube.com/watch?v=jNQXAC9IVRw',sourceType:'page'});await flush();
  const stored=await h.chrome.storage.session.get();assert.equal(stored.captureVideoContext.url,'https://www.youtube.com/watch?v=jNQXAC9IVRw');assert.equal(opened,1);assert.equal(h.natives.length,0);
  one.send({action:'video-tools',pageUrl:url,url:'https://www.youtube.com/watch?v=aqz-KE-bpKQ',sourceType:'page'});await flush();assert.equal(opened,1);assert.match(one.messages.at(-1).error,/different page/);
});

test('embedded player selection retains its exact source and originating page',async t=>{
  const h=harness(t),one=h.connect();let opened=0;h.chrome.action.openPopup=async()=>opened++;
  one.send({action:'video-tools',url:'https://player.vimeo.com/video/12345',sourceType:'embed',title:'Second video'});await flush();
  const stored=await h.chrome.storage.session.get();assert.equal(stored.captureVideoContext.source.pageUrl,'https://example.org/gallery');assert.equal(stored.captureVideoContext.source.url,'https://player.vimeo.com/video/12345');assert.equal(opened,1);
  one.send({action:'video-tools',url:'https://evil.example/player',sourceType:'embed'});await flush();assert.equal(opened,1);
});

test('stale page or document cannot open a video from a previous navigation',async t=>{
  const h=harness(t),one=h.connect();let opened=0;h.chrome.action.openPopup=async()=>opened++;
  h.chrome.webNavigation.getFrame=async()=>({url:'https://example.org/next',documentId:'new'});one.p.sender.documentId='old';
  one.send({action:'video-tools',pageUrl:'https://example.org/next'});await flush();assert.equal(opened,0);assert.match(one.messages.at(-1).error,/Refresh/);
});

test('audio filter exposes extraction without counting a video twice in All',()=>{
  const video=FramekeepCapture.player('https://www.youtube.com/watch?v=jNQXAC9IVRw');
  const audio=FramekeepCapture.item('https://cdn.example.org/speech.webm',null,'audio');
  assert.equal(audio.kind,'audio');
  assert.equal(FramekeepCapture.forFilter([video,audio],'all').length,2);
  const list=FramekeepCapture.forFilter([video,audio],'audio');assert.equal(list.length,2);
  assert.equal(list[0].kind,'audio');assert.equal(list[0].audioFromVideo,true);assert.equal(video.kind,'video');
});

test('Spotify podcast identity is audio and preserves preferred audio across popup handoff',async t=>{
  const h=harness(t),one=h.connect(),url='https://open.spotify.com/episode/2zTyabIrSSTlPes6AtFAeY?si=page';
  one.p.sender.url=url;h.chrome.webNavigation.getFrame=async()=>({url});
  assert.equal(FramekeepCapture.player(url).kind,'audio');
  assert.equal(FramekeepCapture.spotifyEpisode('https://open.spotify.com/track/2zTyabIrSSTlPes6AtFAeY'),null);
  one.send({action:'video-tools',kind:'audio',pageUrl:url,url:FramekeepCapture.spotifyEpisode(url).url});await flush();
  assert.equal((await h.chrome.storage.session.get()).captureVideoContext.kind,'audio');assert.equal(h.natives.length,0);
  const canonical=FramekeepCapture.player('https://open.spotify.com/embed/episode/2zTyabIrSSTlPes6AtFAeY',null,{sourceType:'embed'});
  one.send({action:'video-tools',kind:'audio',pageUrl:url,url:canonical.url,sourceType:canonical.sourceType});await flush();
  assert.equal((await h.chrome.storage.session.get()).captureVideoContext.source.url,canonical.url);
});

test('cross-origin frame discovery retains the verified player referer and rejects stale documents',async t=>{
  const h=harness(t),one=h.connect(),top='https://example.org/gallery',frame='https://player.example.org/video/one',url='https://cdn.example.org/master.m3u8';
  let documentId='frame-one';
  h.chrome.webNavigation.getFrame=async({frameId})=>frameId?{url:frame,documentId}:{url:top,documentId:'top'};
  h.chrome.webNavigation.getAllFrames=async()=>[{frameId:0,url:top},{frameId:5,url:frame,documentId}];
  h.chrome.tabs.sendMessage=async()=>({pageUrl:frame,items:[{url,kind:'video',stream:true,title:'Embedded episode'}]});
  one.send({action:'discover-frames',pageUrl:top});await flush();
  assert.equal(one.messages.at(-1).frameItems.length,1);assert.equal(h.natives.length,0);
  one.send({action:'video-tools',pageUrl:top,frameId:5,url});await flush();
  const saved=(await h.chrome.storage.session.get()).captureVideoContext;assert.equal(saved.pageUrl,top);assert.equal(saved.source.pageUrl,frame);assert.equal(saved.source.url,url);
  documentId='replacement';one.send({action:'video-tools',pageUrl:top,frameId:5,url});await flush();assert.match(one.messages.at(-1).error,/embedded player changed/);
});
