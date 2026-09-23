import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const workletSource=await readFile(new URL('../extension/browser-audio-worklet.js',import.meta.url),'utf8');
const offscreenSource=await readFile(new URL('../extension/browser-audio.js',import.meta.url),'utf8');
test('worklet sends bounded mono 16k PCM and flushes a real final partial second',()=>{
  let Worklet;const buffers=[];
  class Base{constructor(){this.port={postMessage:value=>buffers.push(value)};}}
  vm.runInNewContext(workletSource,{AudioWorkletProcessor:Base,sampleRate:48000,Int16Array,Math,registerProcessor:(name,value)=>{assert.equal(name,'framekeep-pcm');Worklet=value;}});
  const worklet=new Worklet();
  const channel=new Float32Array(48000).fill(.25);
  worklet.process([[channel,channel]]);
  assert.equal(buffers.length,1);assert.equal(buffers[0].byteLength,32000);
  assert.equal(new Int16Array(buffers[0])[0],8192);
  worklet.process([[new Float32Array(24000).fill(.25)]]);
  worklet.port.onmessage({data:'flush'});
  assert.equal(buffers[1].byteLength,16000);assert.equal(buffers[2].flushed,true);
  worklet.process([[channel]]);assert.equal(buffers.length,3);
});

async function offscreenHarness(t,{hold=false}={}){
  const calls=[],routes=[],messages=[],timers=new Set();let listener,node,resolveChunk,tracksStopped=0,closed=0;
  const stream={getTracks:()=>[track],getAudioTracks:()=>[track]},track={stop(){tracksStopped++;}};
  const input={connect:target=>routes.push(target),disconnect(){}};
  class Context{constructor(){this.destination={speakers:true};this.audioWorklet={async addModule(path){assert.equal(path,'browser-audio-worklet.js');}};}
    createMediaStreamSource(value){assert.equal(value,stream);return input;}async resume(){}async close(){closed++;}}
  class Worklet{constructor(){node=this;this.port={postMessage:message=>{if(message==='flush')queueMicrotask(()=>this.port.onmessage({data:{flushed:true}}));}};}connect(){}disconnect(){}}
  const chrome={runtime:{id:'test',getURL:path=>'chrome-extension://test/'+path,onMessage:{addListener(fn){listener=fn;}},async sendMessage(message){
    messages.push(message);if(message.action==='chunk'){if(hold)return await new Promise(resolve=>{resolveChunk=()=>resolve({ok:true,sequence:message.sequence});});return {ok:true,sequence:message.sequence};}return {ok:true,active:true};
  }}};
  vm.runInNewContext(offscreenSource,{chrome,navigator:{mediaDevices:{async getUserMedia(options){calls.push(options);return stream;}}},AudioContext:Context,AudioWorkletNode:Worklet,Uint8Array,Promise,Error,String,queueMicrotask,
    btoa:value=>Buffer.from(value,'binary').toString('base64'),
    setInterval:()=>42,clearInterval(){},setTimeout(fn,ms){const timer=setTimeout(fn,ms);timers.add(timer);return timer;},clearTimeout});
  t.after(()=>{for(const timer of timers)clearTimeout(timer);});
  const send=(message,sender={id:'test'})=>new Promise(resolve=>{if(!listener({target:'framekeep-offscreen',...message},sender,resolve))resolve(undefined);});
  return {send,calls,routes,messages,push:buffer=>node.port.onmessage({data:buffer}),release:()=>resolveChunk?.(),get stopped(){return tracksStopped;},get closed(){return closed;}};
}
test('offscreen requests authorized tab audio only and routes original audio to speakers',async t=>{
  const h=await offscreenHarness(t);await h.send({action:'start',sessionId:'fixture',streamId:'chrome-authorized'});
  assert.equal(h.calls[0].video,false);assert.equal(h.calls[0].audio.mandatory.chromeMediaSource,'tab');assert.equal(h.calls[0].audio.mandatory.chromeMediaSourceId,'chrome-authorized');
  assert.ok(h.routes.some(r=>r.speakers));
  const stopped=await h.send({action:'stop',sessionId:'fixture'});assert.equal(stopped.stopped,true);assert.ok(h.stopped);assert.equal(h.closed,1);
});
test('offscreen stops tracks at bounded backpressure instead of dropping invisible audio',async t=>{
  const h=await offscreenHarness(t,{hold:true});await h.send({action:'start',sessionId:'fixture',streamId:'chrome-authorized'});
  for(let n=0;n<22;n++)h.push(new ArrayBuffer(32000));
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(h.stopped);assert.equal(h.closed,1);
  const fault=h.messages.find(m=>m.action==='fault');assert.equal(fault.droppedChunks,20);assert.match(fault.reason,/20 seconds/);
  assert.equal(h.messages.filter(m=>m.action==='chunk').length,1);h.release();
  await new Promise(resolve=>setImmediate(resolve));
});
test('a page sender cannot activate offscreen audio',async t=>{
  const h=await offscreenHarness(t);const result=await h.send({action:'start',streamId:'forged'},{id:'test',url:'https://example.org'});
  assert.equal(result,undefined);assert.equal(h.calls.length,0);
});
