import test from 'node:test';
import assert from 'node:assert/strict';
import {installBrowserTranscription} from '../extension/browser-transcript-worker.js';

const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);}});
function harness({studyStates=[],deferStart=false}={}){
  const requests=[],sent=[],storage={},root='chrome-extension://test/';
  let captureError=false,completeStart,tab={id:3,url:'https://example.org/authored',title:'Authored media'},media={src:'https://example.org/voice.wav',time:0,rate:1,paused:true};
  const chrome={runtime:{id:'test',getURL:path=>root+path,onMessage:event(),onConnect:event(),async getContexts(){return [];},async sendMessage(message){sent.push(message);return message.action==='start'&&captureError?{error:'Permission denied'}:{started:true};}},
    storage:{session:{async get(){return structuredClone(storage);},async set(value){Object.assign(storage,value);}}},
    tabs:{async query(){return [tab];},async get(){return tab;},onRemoved:event(),onUpdated:event()},
    scripting:{async executeScript(){return [{result:structuredClone(media)}];}},
    offscreen:{async createDocument(){}},tabCapture:{async getMediaStreamId(){return 'authorized-tab-only';}},
    action:{async setBadgeText(){},async setBadgeBackgroundColor(){},async setTitle(){}}};
  installBrowserTranscription(chrome,{request:async(action,data)=>{
    requests.push({action,...data});
    if(action==='browser-start'&&deferStart)return await new Promise(resolve=>{completeStart=()=>resolve({data:{status:'recording',sessionId:data.sessionId}});});
    if(action==='download')return {id:'whole-fixture',event:'complete'};
    if(action==='browser-study')return {data:{status:'ready',state:'submitted',itemId:data.itemId,tracks:[]}};
    if(action==='browser-study-status')return {data:studyStates.shift()};
    return {data:action==='browser-stop'?{status:'stopped'}:action==='browser-chunk'?{cues:[{start:0,end:1,text:'Hello'}]}:{status:'recording',sessionId:data.sessionId}};
  },captions:async()=>({cues:[]}),generateSource:async()=>({url:'https://example.org/authored',title:'Authored media'})});
  const send=(message,sender={id:'test',url:root+'browser-transcript.html'})=>new Promise(resolve=>{const accepted=chrome.runtime.onMessage.listeners[0]({target:'framekeep-browser',...message},sender,resolve);if(!accepted)resolve(undefined);});
  const closePanel=()=>{const disconnect=event();chrome.runtime.onConnect.listeners[0]({name:'framekeep-browser-panel',sender:{id:'test',url:root+'browser-transcript.html'},onDisconnect:disconnect});disconnect.listeners[0]();};
  return {send,requests,sent,storage,root,closePanel,finishStart:()=>completeStart(),setMedia:value=>{media=value;},deny:()=>{captureError=true;}};
}
test('only extension UI can start; same tab alone may stop active capture',async()=>{
  const h=harness();const blocked=await h.send({action:'start'},{id:'test',tab:{id:3},url:'https://example.org/authored'});
  assert.match(blocked.error,/selected tab/);assert.equal(h.requests.length,0);
  const started=await h.send({action:'start',language:'en'});assert.equal(started.live.status,'recording');
  const unrelated=await h.send({action:'stop'},{id:'test',tab:{id:4},url:'https://example.org/other'});assert.match(unrelated.error,/selected tab/);
  const stopped=await h.send({action:'stop'},{id:'test',tab:{id:3},url:'https://example.org/authored'});assert.equal(stopped.live.status,'stopped');
});
test('permission refusal stops native session and never reports recording',async()=>{
  const h=harness();h.deny();const result=await h.send({action:'start'});assert.match(result.error,/Permission denied/);
  assert.equal(h.requests.at(-1).action,'browser-stop');assert.equal(h.storage.browserTranscript.status,'stopped');
});
test('incremental output persists across panel reconnect and offscreen identity is checked',async()=>{
  const h=harness();await h.send({action:'start'});const sid=h.storage.browserTranscript.sessionId;
  const forged=await h.send({action:'chunk',sessionId:sid,sequence:0,pcm:'AAAA'},{id:'test',tab:{id:3},url:'https://example.org/authored'});assert.ok(forged.error);
  const result=await h.send({action:'chunk',sessionId:sid,sequence:0,pcm:'AAAA'},{id:'test',url:h.root+'browser-audio.html'});assert.equal(result.sequence,0);
  const reopened=await h.send({action:'state'});assert.equal(reopened.live.cues[0].text,'Hello');assert.equal(reopened.live.status,'recording');
  await h.send({action:'stop'});
});
test('no-capture widget stop is safe and idempotent',async()=>{
  const h=harness();const result=await h.send({action:'stop'},{id:'test',tab:{id:9},url:'https://example.org/'});assert.equal(result.ok,true);assert.equal(result.live.status,'idle');assert.equal(h.requests.length,0);
});
test('panel closure stops by default and continuing capture requires explicit choice',async()=>{
  const first=harness();await first.send({action:'start'});first.closePanel();await new Promise(resolve=>setImmediate(resolve));assert.equal(first.storage.browserTranscript.status,'stopped');
  const second=harness();await second.send({action:'start'});await second.send({action:'continue-hidden',enabled:true});second.closePanel();await new Promise(resolve=>setImmediate(resolve));assert.equal(second.storage.browserTranscript.status,'recording');await second.send({action:'stop'});
});
test('whole-media polling ignores ready response envelope until real tracks arrive and only then reuses the result',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const h=harness({studyStates:[{status:'ready',state:'running',tracks:[]},
    {status:'ready',state:'evidence_ready',tracks:[{cues:[{start:0,end:1,text:'Actual generated words'}]}]}]});
  await h.send({action:'generate'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.storage.browserWholeTranscript.status,'processing');
  assert.equal(h.requests.filter(r=>r.action==='browser-study-status').length,1);
  t.mock.timers.tick(5000);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.requests.filter(r=>r.action==='browser-study-status').length,2);
  assert.equal(h.storage.browserWholeTranscript.status,'ready');
  assert.equal(h.storage.browserWholeTranscript.tracks[0].cues[0].text,'Actual generated words');
  const reused=await h.send({action:'generate'});
  assert.equal(reused.whole.status,'ready');
  assert.equal(h.requests.filter(r=>r.action==='download').length,1);
});
test('stop while preparing awaits the original model-load request and cleans up its late success',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const h=harness({deferStart:true});const starting=h.send({action:'start'});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(h.storage.browserTranscript.status,'preparing');
  const stopping=h.send({action:'stop'});await new Promise(resolve=>setImmediate(resolve));
  for(let n=0;n<110;n++){t.mock.timers.tick(1000);await new Promise(resolve=>setImmediate(resolve));}
  assert.equal(h.requests.some(r=>r.action==='browser-stop'),false);
  h.finishStart();const stopped=await stopping,started=await starting;
  assert.match(started.error,/cancelled/);assert.equal(stopped.live.status,'stopped');
  assert.equal(h.requests.filter(r=>r.action==='browser-stop').length,1);
  assert.equal(h.sent.some(m=>m.target==='framekeep-offscreen'&&m.action==='start'),false);
});
test('stale offscreen faults cannot stop a newer session',async()=>{
  const h=harness();await h.send({action:'start'});
  const result=await h.send({action:'fault',sessionId:'old-session',reason:'Old failure'},{id:'test',url:h.root+'browser-audio.html'});
  assert.equal(result.ignored,true);assert.equal(h.storage.browserTranscript.status,'recording');
  await h.send({action:'stop'});
});
