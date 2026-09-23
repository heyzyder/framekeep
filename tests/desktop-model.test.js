import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaKind,timestamp,validTiming,transcriptTracks,activeCueIndex,orderedItems,playableItems,safeMediaUrl} from '../extension/desktop-model.js';

test('unknown media never becomes video; verified stream kind takes precedence',()=>{
  assert.equal(mediaKind({filename:'pretend.mp4'}),'unknown');
  assert.equal(mediaKind({kind:'video',capabilities:{kind:'unknown'}}),'unknown');
  assert.equal(mediaKind({kind:'video',capabilities:{kind:'audio'}}),'audio');
});
test('timestamps are readable and absent timing is never fabricated',()=>{
  assert.equal(timestamp(65.25),'01:05');assert.equal(timestamp(3665),'01:01:05');
  assert.equal(timestamp(65.25,true,','),'00:01:05,250');
  for(const value of [null,undefined,NaN,-1,'12'])assert.equal(timestamp(value),'');
  assert.equal(validTiming({start:0,end:1}),true);
  for(const cue of [{text:'untimed'},{start:1,end:1},{start:2,end:1},{start:null,end:2}])assert.equal(validTiming(cue),false);
});
test('existing generated transcript is available without source captions and original stays intact',()=>{
  const original={status:'ready',id:'generated',source:'generated-transcription',cues:[{start:0,end:2,text:'Xin chào'}]};
  const item={transcript:{status:'unavailable'},transcriptTracks:[original]};
  assert.equal(transcriptTracks(item)[0],original);assert.equal(activeCueIndex(original.cues,1),0);assert.equal(activeCueIndex(original.cues,2),-1);
  assert.deepEqual(item.transcript,{status:'unavailable'});
});
test('playlist collection ordering is stable and excludes missing unsupported files',()=>{
  const items=[{id:'a',kind:'video',previewUrl:'a'},{id:'b',kind:'audio',previewUrl:'b'},{id:'missing',kind:'video',previewUrl:'c',fileState:'missing'},{id:'unknown',previewUrl:'d'}];
  const ordered=orderedItems(items,{itemIds:['b','missing','a','unknown']},'collection');
  assert.deepEqual(ordered.map(i=>i.id),['b','missing','a','unknown']);
  assert.deepEqual(playableItems(ordered).map(i=>i.id),['b','a']);
  assert.deepEqual(items.map(i=>i.id),['a','b','missing','unknown']);
});

test('missing artwork and unsafe URLs never resolve against the app origin',()=>{
  for(const value of [undefined,null,'','  ',42,{},'undefined','relative-image.png','javascript:alert(1)','file:///private/audio.wav','data:text/html;base64,PHNjcmlwdD4=','https://user:password@example.test/media'])assert.equal(safeMediaUrl(value),'');
  for(const value of ['http://127.0.0.1:8000/token/audio.wav','https://example.test/image.jpg','blob:https://example.test/id','data:audio/wav;base64,UklGRg=='])assert.equal(safeMediaUrl(value),value);
});
