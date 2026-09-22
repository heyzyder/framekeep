import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeUrl, duration, PLATFORMS, transferView, formatBytes, transferPresentation} from '../extension/shared.js';

test('progress is active-only and completion disappears after eight seconds without removing history', () => {
  const now=10000, job={id:'saved',status:'complete',finished:now-1000,unread:true};
  assert.equal(transferPresentation(null,now),'hidden');
  assert.equal(transferPresentation({status:'processing'},now),'progress');
  assert.equal(transferPresentation(job,now),'result');
  assert.equal(transferPresentation(job,now+7000),'hidden');
  assert.equal(transferPresentation(job,now,true),'hidden');
  assert.equal(job.unread,true); assert.equal(job.status,'complete');
  assert.equal(transferPresentation({...job,status:'error'},now+7000),'result');
  assert.equal(transferPresentation({...job,status:'error',unread:false},now),'hidden');
});

test('canonicalizes supported links and drops tracking / playlist / timestamp data', () => {
  for (const value of ['https://youtu.be/BaW_jenozKc?si=tracking', 'https://www.youtube.com/watch?v=BaW_jenozKc&list=PLfoo&t=3', 'https://m.youtube.com/shorts/BaW_jenozKc', 'https://music.youtube.com/watch?v=BaW_jenozKc', 'https://youtube.com/live/BaW_jenozKc']) {
    assert.equal(normalizeUrl(value), 'https://www.youtube.com/watch?v=BaW_jenozKc');
  }
});
test('rejects lookalike hosts, credentials, unsupported paths, ports and non-video URLs', () => {
  for (const value of ['https://youtube.com.evil.org/watch?v=BaW_jenozKc', 'https://user:pass@youtube.com/watch?v=BaW_jenozKc', 'https://youtube.com:8443/watch?v=BaW_jenozKc', 'javascript:alert(1)', 'file:///etc/passwd', 'https://youtube.com/playlist?list=PLx', 'https://youtu.be/short', 'https://youtu.be/BaW_jenozKc/extra', 'https://youtube.com/watch?v=../../../a', null]) assert.throws(() => normalizeUrl(value));
});
test('duration handles hours and unavailable values', () => {
  assert.equal(duration(11), '0:11'); assert.equal(duration(3611), '1:00:11'); assert.equal(duration(null), ''); assert.equal(duration(-10), '0:00');
});
test('all 16 platforms route identically in the extension and helper', async () => {
  const nativePlatforms = JSON.parse(await readFile(new URL('../native/platforms.json', import.meta.url)));
  assert.deepEqual(PLATFORMS, nativePlatforms);
  assert.equal(PLATFORMS.length, 16);
  for (const platform of PLATFORMS.filter(p => p.name !== 'YouTube')) for (const domain of platform.domains) {
    assert.equal(normalizeUrl(`https://${domain}/video/example?utm_source=test#tracking`), `https://${domain}/video/example`);
    assert.throws(() => normalizeUrl(`https://${domain}.evil.test/video/example`));
  }
  assert.equal(normalizeUrl('https://vimeo.com/123?h=unlisted&utm_source=mail'), 'https://vimeo.com/123?h=unlisted');
});
test('persistent bubble runs on web pages; transcript injection stays on YouTube', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url)));
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'contextMenus', 'nativeMessaging', 'storage', 'notifications', 'sidePanel', 'scripting', 'webNavigation'].sort());
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://*/*']);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.content_scripts[0], {matches: ['https://www.youtube.com/*'], js: ['youtube-transcript.js'], run_at: 'document_idle'});
  assert.deepEqual(manifest.content_scripts[1], {matches:['http://*/*','https://*/*'],js:['capture-discovery.js','frame-media.js','floating.js'],run_at:'document_idle',all_frames:true});
  assert.match(manifest.content_security_policy.extension_pages, /connect-src 'none'/);
});
test('transfer stages distinguish preparation, real stream progress, merging and completion', () => {
  assert.equal(transferView({status:'starting'}).percent, null);
  const downloading = transferView({status:'downloading',stage:'video',percent:42.5,downloaded:2097152,total:5242880,speed:1048576,eta:12});
  assert.equal(downloading.title,'Downloading video'); assert.equal(downloading.metric,'42%');
  assert.equal(downloading.bytes,'2.0 MB of 5.0 MB'); assert.equal(downloading.speed,'1.0 MB/s'); assert.equal(downloading.eta,'0:12 left');
  assert.equal(transferView({status:'processing',percent:100,kind:'audio'}).percent,null);
  assert.equal(transferView({status:'complete',bytes:1024}).metric,'✓ Saved');
  assert.equal(transferView({status:'error',error:'Unavailable'}).detail,'Unavailable');
});
test('missing progress and byte sizes do not produce fake percentages or NaN', () => {
  assert.equal(transferView({status:'downloading',percent:null}).metric,'');
  assert.equal(formatBytes(undefined),''); assert.equal(formatBytes(-1),'');
  assert.equal(transferView({status:'downloading',percent:900}).percent,100);
});
