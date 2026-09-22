import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaSource, uniqueMedia, previewImage, inspectMedia} from '../extension/page-media.js';
import vm from 'node:vm';
const page = 'https://members.example.org/course/lesson/';
test('signed HLS links and embedded players retain their playback parameters', () => {
  const url = 'https://video.b-cdn.net/bcdn_token=fixture&expires=123/video/playlist.m3u8';
  assert.equal(mediaSource({url, type:'direct', title:'Lesson'}, page).url, url);
  assert.equal(mediaSource({url:'https://player.vimeo.com/video/123?h=unlisted',type:'embed'},page).type,'embed');
});
test('quality variants of a Bunny asset collapse while different videos remain distinct', () => {
  const asset = 'ef550d49-e937-49fd-800b-ad2ebfc91f39';
  const sources = ['720p/video.m3u8', 'playlist.m3u8', '480p/video.m3u8'].map(p => ({url:`https://vz-test.b-cdn.net/token=fixture/${asset}/${p}`,type:'direct'}));
  sources.push({url:'https://vz-test.b-cdn.net/11111111-2222-3333-4444-555555555555/playlist.m3u8',type:'direct'});
  const result = uniqueMedia(sources); assert.equal(result.length,2); assert.ok(result[0].url.endsWith('/playlist.m3u8'));
});
test('preview images reject executable and unbounded data while keeping small real JPEGs', () => {
  assert.equal(previewImage('javascript:alert(1)'), ''); assert.equal(previewImage('data:image/svg+xml,<svg/>'), '');
  assert.equal(previewImage('data:image/jpeg;base64,' + 'a'.repeat(180000)), '');
  assert.equal(previewImage('data:image/jpeg;base64,/9j/'), 'data:image/jpeg;base64,/9j/');
});
test('current Presto player excludes old lesson and rendition resource history', () => {
  const player={getAttribute:name=>name==='src'?'https://video.example/current/playlist.m3u8':''};
  const document={title:'Current lesson',baseURI:page,querySelectorAll:selector=>selector==='presto-player[src]'?[player]:[]};
  const context={document,URL,window:{performance:{getEntriesByType:()=>[{name:'https://video.example/old/playlist.m3u8'},{name:'https://video.example/current/720p/video.m3u8'}]}}};
  const result=vm.runInNewContext('('+inspectMedia.toString()+')()',context);assert.equal(result.media.length,1);assert.ok(result.media[0].url.includes('/current/playlist'));
});
test('scanner results cannot select executable schemes, local targets or unrelated frames', () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/video.mp4', 'https://localhost/video.mp4', 'https://127.0.0.1/video.mp4', 'https://user:pass@video.example.org/a.mp4', 'https://example.org/not-media']) assert.throws(()=>mediaSource({url,type:'direct'},page));
  assert.throws(()=>mediaSource({url:'https://player.vimeo.com.evil.org/video/123',type:'embed'},page));
});
