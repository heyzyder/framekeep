import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import '../extension/capture-discovery.js';
const code=readFileSync(new URL('../extension/frame-media.js',import.meta.url),'utf8');
function scan({src='blob:https://player.example.org/video',protectedMedia=false,resources=[],sender='own',tag='VIDEO'}={}){
 let listener,reply;
 const media={tagName:tag,currentSrc:src,mediaKeys:protectedMedia?{}:null,getAttribute(){return src;},querySelectorAll(){return [];}};
 const doc={title:'Episode',baseURI:'https://player.example.org/video',querySelectorAll:s=>s==='video,audio'?[media]:[]};
 vm.runInNewContext(code,{window:{},top:{},URL,document:doc,location:{href:doc.baseURI},FramekeepCapture,performance:{getEntriesByType:()=>resources.map(name=>({name}))},chrome:{runtime:{id:'own',onMessage:{addListener(fn){listener=fn;}}}}});
 listener({action:'framekeep-frame-scan'},{id:sender},r=>reply=r);return reply;
}
test('embedded blob player finds its master manifest and excludes fragments and nested renditions',()=>{
 const result=scan({resources:['https://cdn.example.org/hls/master.m3u8','https://cdn.example.org/hls/720/index.m3u8','https://cdn.example.org/hls/720/part.ts']});
 assert.equal(result.items.length,1);assert.equal(result.items[0].url,'https://cdn.example.org/hls/master.m3u8');assert.equal(result.items[0].stream,true);
});
test('frame scans do not use resource history without an active blob player or for protected media',()=>{
 const resources=['https://cdn.example.org/old/master.m3u8'];
 assert.equal(scan({src:'',resources}).items.length,0);
 assert.equal(scan({protectedMedia:true,resources}).items.length,0);
 assert.equal(scan({src:'https://cdn.example.org/current.mp4',resources}).items[0].url,'https://cdn.example.org/current.mp4');
});
test('only extension messages get frame data and audio remains batch selectable',()=>{
 assert.equal(scan({sender:'page'}),undefined);
 const result=scan({src:'https://cdn.example.org/song.mp3',tag:'AUDIO'});assert.equal(result.items[0].kind,'audio');assert.equal(result.items[0].stream,false);
});
