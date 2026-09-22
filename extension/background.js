import { normalizeUrl, PLATFORMS, ACTIVE, HOST, downloadKey, recentJobs } from './shared.js';
import { installPageTranscripts } from './page-transcripts.js';
import { inspectMedia, mediaSource, previewImage, uniqueMedia } from './page-media.js';
import {installCapture} from './capture-worker.js';

installPageTranscripts(chrome);
installCapture(chrome);

const clients = new Set();
const sentTranscripts = new WeakMap();
const pending = new Map();
let nativePort = null;
let idleTimer;
let lastBadge = '';
let lastProgressSave = 0;
let state = {
  protocol: 2, workerVersion: '1.8.0',
  helper: {status: 'checking'},
  probe: {status: 'idle'},
  jobs: [],
  settings: {kind: 'video', quality: '1080', audioQuality: '192', notifications: true},
  alerts: {status: 'checking'},
  transcript: {status: 'idle'},
  page: {status: 'idle', candidates: [], origins: []},
};
let transcriptGeneration = 0;
let probeGeneration = 0;
let scanGeneration = 0;
let observedTab;
const ready = (async () => {
  const [saved, session] = await Promise.all([chrome.storage.local.get(['jobs', 'settings']), chrome.storage.session.get(['probe', 'transcript'])]);
  state.settings = {...state.settings, ...saved.settings};
  if (session.probe?.status === 'ready') state.probe = session.probe;
  if (session.transcript?.status === 'ready' && session.transcript.url === state.probe.url) state.transcript = session.transcript;
  state.jobs = recentJobs((saved.jobs || []).filter(job => !['trashed', 'missing'].includes(job.fileState))).map(job => ACTIVE.has(job.status)
    ? {...job, status: 'interrupted', unread: true, finished: Date.now(), error: 'Chrome or the helper closed before completion. Try downloading again.'} : {...job, fileState: job.fileState === 'trashing' ? undefined : job.fileState});
  try { state.alerts = {status: await chrome.notifications.getPermissionLevel()}; }
  catch { state.alerts = {status: 'denied'}; }
})();

function publish() {
  for (const port of clients) {
    try {
      if (state.transcript.status === 'ready' && sentTranscripts.get(port) === state.transcript) {
        port.postMessage({...state, transcript: {...state.transcript, cues: undefined, unchanged: true}});
      } else { port.postMessage(state); sentTranscripts.set(port, state.transcript); }
    } catch { clients.delete(port); }
  }
  const activeJobs = state.jobs.filter(job => ACTIVE.has(job.status)), active = activeJobs[0];
  const unseen = state.jobs.find(job => job.unread && ['complete', 'error', 'interrupted'].includes(job.status));
  const text = activeJobs.length > 1 ? String(activeJobs.length) : active ? (active.status === 'downloading' && Number.isFinite(active.percent) ? `${Math.floor(active.percent)}%` : '↓') : unseen ? (unseen.status === 'complete' ? '✓' : '!') : '';
  const color = active ? '#5965db' : unseen?.status === 'complete' ? '#247f6c' : '#b74658';
  const badgeKey = `${text}:${color}`;
  if (lastBadge !== badgeKey) {
    lastBadge = badgeKey;
    chrome.action.setBadgeText({text}).catch(() => {});
    chrome.action.setBadgeBackgroundColor({color}).catch(() => {});
    chrome.action.setTitle({title: activeJobs.length > 1 ? `Framekeep · ${activeJobs.length} downloads running` : active ? `Framekeep · ${text} · ${active.title}` : unseen ? `Framekeep · ${unseen.status === 'complete' ? 'Download finished' : 'Download needs attention'}` : 'Save with Framekeep'}).catch(() => {});
  }
}
async function saveJobs() { state.jobs = recentJobs(state.jobs); await chrome.storage.local.set({jobs: state.jobs}); }
async function notifyJob(job) {
  if (!state.settings.notifications) return;
  try {
    await chrome.notifications.create(`framekeep:${job.id}`, {
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: job.status === 'complete' ? 'Download finished' : 'Download needs attention',
      message: job.status === 'complete' ? `${job.title}\nYour ${job.kind === 'audio' ? 'MP3' : 'video'} is ready in the save folder.` : `${job.title}\n${job.error || 'Open Framekeep to try again.'}`,
      buttons: [{title: job.status === 'complete' ? 'Open save folder' : 'Open Framekeep'}],
      requireInteraction: true,
    });
    state.alerts = {status: 'granted'};
  } catch {
    state.alerts = {status: 'denied'};
  }
  publish();
}
function idleDisconnect() {
  clearTimeout(idleTimer);
  if (!clients.size && !pending.size && !state.jobs.some(job => ACTIVE.has(job.status))) {
    idleTimer = setTimeout(() => { const port = nativePort; nativePort = null; port?.disconnect(); }, 10000);
  }
}
function connect() {
  clearTimeout(idleTimer);
  if (nativePort) return nativePort;
  const port = chrome.runtime.connectNative(HOST);
  nativePort = port;
  port.onMessage.addListener(message => {
    const job = state.jobs.find(item => item.id === message.id);
    if (job) {
      const wasActive = ACTIVE.has(job.status);
      if (message.event === 'progress') {
        if (job.status !== 'cancelling') job.status = message.phase === 'processing' ? 'processing' : 'downloading';
        job.percent = Number.isFinite(message.percent) ? Math.min(100, Math.max(0, message.percent)) : null;
        job.detail = message.detail || '';
        for (const field of ['downloaded', 'total', 'speed', 'eta']) job[field] = Number.isFinite(message[field]) ? message[field] : null;
        job.stage = message.stage || 'media';
      } else if (message.event === 'complete') {
        Object.assign(job, {status: 'complete', percent: 100, filename: message.filename, bytes: message.bytes, finished: Date.now(), unread: true});
      } else if (message.event === 'error' || message.event === 'cancelled') {
        Object.assign(job, {status: message.event === 'cancelled' ? 'cancelled' : 'error', error: message.error, finished: Date.now(), unread: message.event === 'error'});
      }
      if (message.event !== 'progress' || Date.now() - lastProgressSave > 2000) {
        lastProgressSave = Date.now();
        saveJobs().catch(() => {});
      }
      if (wasActive && ['complete', 'error'].includes(job.status)) notifyJob(job).catch(() => {});
    }
    const task = pending.get(message.id);
    if (task && ['result', 'error', 'cancelled', 'complete'].includes(message.event)) {
      clearTimeout(task.timer);
      pending.delete(message.id);
      if (message.event === 'error') task.reject(new Error(message.error || 'The helper could not finish.'));
      else task.resolve(message);
    }
    publish();
    idleDisconnect();
  });
  port.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message;
    if (nativePort !== port) return;
    nativePort = null;
    state.helper = {status: 'missing', error: reason || 'The local helper disconnected.'};
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error(reason || 'The helper disconnected.')); }
    pending.clear();
    for (const job of state.jobs) if (ACTIVE.has(job.status)) {
      Object.assign(job, {status: 'interrupted', unread: true, finished: Date.now(), error: 'The helper disconnected. Try downloading again.'});
      notifyJob(job).catch(() => {});
    }
    saveJobs().catch(() => {});
    publish();
  });
  return port;
}
function request(action, data = {}, timeout = 130000) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      try { nativePort?.postMessage({id: crypto.randomUUID(), action: 'cancel', target: id}); } catch {}
      reject(new Error('The helper took too long. Retry when your connection is ready.'));
      idleDisconnect();
    }, timeout);
    pending.set(id, {resolve, reject, timer, action});
    try { connect().postMessage({id, action, ...data}); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
}
async function checkHelper() {
  if (nativePort && state.helper.status === 'ready' && state.helper.version === chrome.runtime.getManifest().version) return;
  state.helper = {status: 'checking'};
  publish();
  try {
    let result = await request('status', {}, 15000);
    if (result.data.version !== chrome.runtime.getManifest().version && !state.jobs.some(job => ACTIVE.has(job.status)) && !pending.size) {
      const previous = nativePort; nativePort = null; previous?.disconnect();
      result = await request('status', {}, 15000);
    }
    if (result.data.protocol !== 2 || !result.data.capabilities?.includes('parallel-downloads')) throw new Error(`Chrome reached helper ${result.data.version || 'unknown'} at ${result.data.location || 'the old installation'}. Run Install Framekeep.cmd to update the Windows helper for parallel downloads.`);
    state.helper = {status: 'ready', ...result.data};
  }
  catch (error) { state.helper = {status: 'missing', error: error.message}; }
  publish();
}
function resetSelection() {
  probeGeneration++;
  transcriptGeneration++;
  for (const [id, task] of pending) if (['probe', 'transcript', 'preview'].includes(task.action)) {
    clearTimeout(task.timer);
    pending.delete(id);
    task.resolve({event: 'cancelled'});
    try { nativePort?.postMessage({id: crypto.randomUUID(), action: 'cancel', target: id}); } catch {}
  }
  state.probe = {status: 'idle'};
  state.transcript = {status: 'idle'};
  chrome.storage.session.remove(['probe', 'transcript']).catch(() => {});
}
async function analyze(rawUrl, source) {
  resetSelection();
  const generation = probeGeneration;
  const thumbnail = previewImage(source?.thumbnail);
  if (source) source = mediaSource(source, source.pageUrl);
  let url;
  try {
    if (source) url = source.url;
    else {
      try { url = normalizeUrl(rawUrl); }
      catch (error) {
        const page = new URL(rawUrl.trim());
        if (!['http:', 'https:'].includes(page.protocol) || page.username || page.password || page.port || !page.hostname.includes('.') || PLATFORMS.some(p=>p.domains.some(h=>page.hostname===h||page.hostname.endsWith('.'+h)))) throw error;
        url = page.href;
      }
    }
  }
  catch (error) { state.probe = {status: 'error', error: error.message}; await chrome.storage.session.remove(['probe', 'transcript']); publish(); return; }
  state.probe = {status: 'loading', url};
  state.transcript = {status: 'idle', url};
  publish();
  try {
    await chrome.storage.session.remove(['probe', 'transcript']);
    if (generation !== probeGeneration) return;
    const result = await request('probe', {url, ...(source ? {source} : {})});
    if (generation !== probeGeneration) return;
    if (result.event !== 'result') throw new Error('Video check cancelled. Choose a video to try again.');
    if (result.data.source) { source = mediaSource(result.data.source, result.data.source.pageUrl); url = source.url; delete result.data.source; }
    if (source?.type === 'direct') { result.data.title = source.title; result.data.platform = result.data.audioOnly ? 'Page audio' : 'Page video'; }
    result.data.thumbnail = previewImage(result.data.thumbnail) || thumbnail;
    state.probe = {status: 'ready', url, source, info: result.data};
    await chrome.storage.session.set({probe: state.probe});
    if (generation !== probeGeneration) return;
    loadTranscript().catch(() => {});
    if (!result.data.audioOnly && !result.data.thumbnail && source?.type === 'direct') loadPreview(url, source, generation).catch(() => {});
  }
  catch (error) { if (generation !== probeGeneration) return; state.probe = {status: 'error', url, error: error.message}; }
  publish();
}
async function loadPreview(url, source, generation) {
  if (!state.helper.capabilities?.includes('preview')) return;
  const result = await request('preview', {source}, 25000);
  if (generation !== probeGeneration || state.probe.url !== url || state.probe.status !== 'ready') return;
  const thumbnail = previewImage(result.data?.thumbnail);
  if (thumbnail) { state.probe.info.thumbnail = thumbnail; await chrome.storage.session.set({probe: state.probe}); publish(); }
}
async function loadTranscript(language) {
  if (state.probe.status !== 'ready') return;
  const {url, info} = state.probe;
  const tracks = info.tracks || [];
  if (!tracks.length) { state.transcript = {status: 'unavailable', url}; publish(); return; }
  const track = language ? tracks.find(item => item.language === language) : tracks[0];
  if (!track) throw new Error('Choose an available caption language.');
  if (state.transcript.status === 'loading') return;
  const generation = ++transcriptGeneration;
  state.transcript = {status: 'loading', url, language: track.language};
  publish();
  try {
    const response = await request('transcript', {url, source: state.probe.source, language: track.language});
    if (generation !== transcriptGeneration) return;
    if (response.event !== 'result' || !response.data?.cues?.length) throw new Error('This caption track is unavailable. Try another language or retry later.');
    state.transcript = {status: 'ready', url, automatic: track.automatic, name: track.name, ...response.data};
    await chrome.storage.session.set({transcript: state.transcript});
  } catch (error) {
    if (generation !== transcriptGeneration) return;
    state.transcript = {status: 'error', url, language: track.language, error: error.message};
  }
  publish();
}
async function download(message) {
  if (state.probe.status !== 'ready') throw new Error('Check a video before downloading.');
  if (state.jobs.some(job => job.fileState === 'trashing')) throw new Error('Wait for the file to reach the Recycle Bin.');
  const {kind, quality} = message;
  if (!['video', 'audio'].includes(kind)) throw new Error('Choose MP4 or MP3.');
  const allowed = kind === 'video' ? ['best', ...state.probe.info.heights.map(String)] : ['128', '192', '320'];
  if (!allowed.includes(String(quality))) throw new Error('Choose one of the available qualities.');
  const {url, source, info} = state.probe;
  const key = downloadKey(source?.pageUrl || url, kind, quality);
  if (state.jobs.some(job => ACTIVE.has(job.status) && job.key === key)) throw new Error('This video is already downloading in that format.');
  const job = {id: crypto.randomUUID(), key, url: source?.pageUrl || url, title: info.title, kind, quality, status: 'starting', percent: null, created: Date.now(), unread: false};
  state.jobs = recentJobs([job, ...state.jobs]);
  publish();
  await saveJobs();
  try { connect().postMessage({id: job.id, action: 'download', url, source, kind, quality}); }
  catch (error) { Object.assign(job, {status: 'error', error: error.message, unread: true, finished: Date.now()}); await saveJobs(); publish(); notifyJob(job).catch(() => {}); }
}

async function trashDownload(id) {
  const job = state.jobs.find(item => item.id === id && item.status === 'complete' && item.filename);
  if (!job || ['trashed', 'missing', 'trashing'].includes(job.fileState)) return;
  if (state.jobs.some(item => ACTIVE.has(item.status) || item.fileState === 'trashing')) throw new Error('Wait for the current operation before deleting a file.');
  const matches = state.jobs.filter(item => item.filename?.toLocaleLowerCase() === job.filename.toLocaleLowerCase());
  for (const item of matches) { item.fileState = 'trashing'; delete item.fileError; }
  publish(); await saveJobs();
  try {
    const result = await request('trash', {filename: job.filename}, 30000);
    if (!['trashed', 'missing'].includes(result.data?.fileState)) throw new Error('The helper did not confirm file deletion. Update the helper and retry.');
    state.jobs = state.jobs.filter(item => !matches.includes(item));
  } catch (error) { for (const item of matches) { item.fileState = 'error'; item.fileError = error.message; } }
  await saveJobs(); publish();
}

async function refreshFiles() {
  const jobs = state.jobs.filter(job => job.status === 'complete' && job.filename && job.fileState !== 'trashing');
  if (!jobs.length) return;
  try {
    const response = await request('files', {filenames: [...new Set(jobs.map(job => job.filename))]}, 10000);
    for (const job of jobs) {
      if (response.data?.[job.filename] === true && ['missing', 'trashed'].includes(job.fileState)) delete job.fileState;
      else if (response.data?.[job.filename] === false && job.fileState !== 'trashed') job.fileState = 'missing';
    }
    state.jobs = state.jobs.filter(job => !['missing', 'trashed'].includes(job.fileState));
    await saveJobs(); publish();
  } catch { /* Older helpers still support downloads; file validation can wait for an update. */ }
}

async function scanPage(autoSelect = false) {
  const generation = ++scanGeneration;
  state.page = {status: 'scanning', candidates: [], origins: []}; publish();
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (generation !== scanGeneration) return;
    const context = tab && `${tab.id}:${tab.url}`;
    if (context !== observedTab) {
      observedTab = context;
      resetSelection(); publish();
    }
    if (!tab?.id || !/^https?:\/\//.test(tab.url || '')) throw new Error('Open Framekeep from the toolbar on the page containing the video.');
    let platformUrl;
    try { platformUrl = normalizeUrl(tab.url); } catch {}
    if (platformUrl) {
      state.page = {status: 'ready', tabId: tab.id, url: tab.url, title: tab.title, candidates: [], origins: [], platformUrl, message: 'Video from your current tab'};
      publish();
      if (autoSelect && state.helper.status === 'ready' && (state.probe.url !== platformUrl || !['ready', 'loading'].includes(state.probe.status))) await analyze(platformUrl);
      return;
    }
    const top = new URL(tab.url), all = await chrome.webNavigation.getAllFrames({tabId: tab.id});
    const frameIds = [0], origins = new Set();
    for (const frame of all || []) {
      if (frame.frameId === 0 || !/^https?:\/\//.test(frame.url)) continue;
      const origin = new URL(frame.url).origin;
      if (origin === top.origin || await chrome.permissions.contains({origins: [origin + '/*']})) frameIds.push(frame.frameId);
      else origins.add(origin + '/*');
    }
    const results = [];
    for (const frameId of frameIds.slice(0, 20)) {
      try { results.push(...await chrome.scripting.executeScript({target: {tabId: tab.id, frameIds: [frameId]}, func: inspectMedia})); }
      catch (error) { if (frameId === 0) throw new Error('Chrome could not scan this page. Close Framekeep, click its toolbar icon on the video page, then try again.'); }
    }
    const seen = new Set(), found = [];
    for (const {result} of results) for (const candidate of result?.media || []) {
      try {
        const source = mediaSource(candidate, tab.url);
        if (seen.has(source.url)) continue;
        seen.add(source.url); found.push({...source, thumbnail: previewImage(candidate.thumbnail), id: crypto.randomUUID()});
      } catch {}
    }
    const candidates = uniqueMedia(found);
    // Signed media URLs stay in memory/session, never in the persistent download history.
    const [currentTab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (generation !== scanGeneration) return;
    if (currentTab?.id !== tab.id || currentTab?.url !== tab.url) return scanPage(autoSelect);
    state.page = {status: 'ready', tabId: tab.id, url: tab.url, title: tab.title, candidates: candidates.slice(0, 20), origins: [...origins].slice(0, 10),
      message: candidates.length ? `${candidates.length} video${candidates.length === 1 ? '' : 's'} found on this tab` : results.some(x => x.result?.protectedMedia) ? 'This player uses protected media, which Framekeep cannot download.' : 'Play a video on this page. Framekeep will check again automatically.'};
    publish();
    if (autoSelect && state.helper.status === 'ready') {
      if (candidates.length === 1) {
        const source = candidates[0];
        if (state.probe.url !== source.url || !['ready', 'loading'].includes(state.probe.status)) await analyze(source.url, source);
      } else if (!candidates.some(source => source.url === state.probe.url)) {
        resetSelection();
      }
    }
  } catch (error) { if (generation !== scanGeneration) return; resetSelection(); state.page = {status: 'error', candidates: [], origins: [], message: error.message}; }
  publish();
}

// A visible sidebar follows tab switches; its running download belongs to its own job.
chrome.tabs.onActivated.addListener(() => {
  if (clients.size) ready.then(async () => {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.url?.startsWith(chrome.runtime.getURL(''))) await scanPage(true);
  }).catch(() => {});
});
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (clients.size && tab.active && !tab.url?.startsWith(chrome.runtime.getURL('')) && (change.url || change.status === 'complete')) ready.then(() => scanPage(true)).catch(() => {});
});

async function repairTranscriptTabs() {
  if (!chrome.scripting) return;
  const tabs = await chrome.tabs.query({url: 'https://www.youtube.com/*'});
  for (const tab of tabs) if (tab.id) await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['youtube-transcript.js']}).catch(() => {});
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'framekeep-popup' || port.sender?.id !== chrome.runtime.id) return;
  clients.add(port);
  clearTimeout(idleTimer);
  port.onDisconnect.addListener(() => { clients.delete(port); idleDisconnect(); });
  port.onMessage.addListener(message => {
    (async () => {
      await ready;
      switch (message.action) {
        case 'init':
          // Do not flash a cached video from a different tab while checking the helper.
          const [openingTab] = await chrome.tabs.query({active: true, currentWindow: true});
          if (!openingTab?.url?.startsWith(chrome.runtime.getURL('')) && observedTab !== `${openingTab?.id}:${openingTab?.url}`) resetSelection();
          publish();
          repairTranscriptTabs().catch(() => {});
          await checkHelper();
          if (state.helper.status === 'ready') refreshFiles().catch(() => {});
          if (state.helper.status === 'ready' && state.probe.status === 'ready' && state.transcript.status === 'idle') loadTranscript().catch(() => {});
          const saved = await chrome.storage.session.get(['contextUrl','captureVideoContext']);
          await chrome.storage.session.remove(['contextUrl','captureVideoContext']);
          const capture=saved.captureVideoContext;
          if(capture && capture.tabId===openingTab?.id && capture.pageUrl===openingTab?.url && state.helper.status==='ready') {
            state.formatIntent={id:crypto.randomUUID(),kind:capture.kind==='audio'?'audio':'video'};
            await analyze(capture.url,capture.source);
          }
          else if (saved.contextUrl && state.helper.status === 'ready' && state.probe.status !== 'loading' && !state.jobs.some(job => ACTIVE.has(job.status))) await analyze(saved.contextUrl);
          else await scanPage(true);
          break;
        case 'check': await checkHelper(); break;
        case 'analyze': await analyze(message.url); break;
        case 'scan': await scanPage(message.autoSelect !== false); break;
        case 'page-video': {
          const source = state.page.candidates.find(item => item.id === message.id);
          if (!source) throw new Error('Scan the page again to refresh its video links.');
          await analyze(source.url, source); break;
        }
        case 'trash': await trashDownload(message.id); break;
        case 'transcript': await loadTranscript(message.language); break;
        case 'seek': {
          if (state.probe.status !== 'ready' || !Number.isFinite(message.seconds) || message.seconds < 0) break;
          const url = new URL(state.probe.url);
          if (url.hostname === 'www.youtube.com') url.searchParams.set('t', `${Math.floor(message.seconds)}s`);
          else if (url.hostname.endsWith('vimeo.com')) url.hash = `t=${Math.floor(message.seconds)}s`;
          else break;
          await chrome.tabs.create({url: url.href});
          break;
        }
        case 'download': await download(message); break;
        case 'cancel': {
          const job = state.jobs.find(item => item.id === message.id && ACTIVE.has(item.status));
          if (job) { job.status = 'cancelling'; publish(); await request('cancel', {target: job.id}, 15000); }
          break;
        }
        case 'folder': await request('folder', {}, 10000); break;
        case 'desktop': await request('desktop', state.probe.status === 'ready' ? {url:state.probe.url, source:state.probe.source} : {}, 10000); break;
        case 'acknowledge':
          for (const job of state.jobs) if (!ACTIVE.has(job.status)) job.unread = false;
          await saveJobs(); publish(); break;
        case 'expand': {
          const url = chrome.runtime.getURL('popup.html?view=window');
          const tabs = await chrome.tabs.query({});
          const existing = tabs.find(tab => tab.url === url);
          if (existing) { await chrome.tabs.update(existing.id, {active: true}); await chrome.windows.update(existing.windowId, {focused: true}); }
          else await chrome.tabs.create({url});
          break;
        }
        case 'clear': state.jobs = state.jobs.filter(job => ACTIVE.has(job.status) || job.fileState === 'trashing'); await saveJobs(); publish(); break;
        case 'settings': {
          const {kind, quality, audioQuality} = message;
          if (['video', 'audio'].includes(kind)) state.settings.kind = kind;
          if (quality === 'best' || /^\d{3,4}$/.test(quality)) state.settings.quality = quality;
          if (['128', '192', '320'].includes(audioQuality)) state.settings.audioQuality = audioQuality;
          if (typeof message.notifications === 'boolean') state.settings.notifications = message.notifications;
          await chrome.storage.local.set({settings: state.settings});
          publish();
          break;
        }
      }
    })().catch(error => { try { port.postMessage({uiError: error.message}); } catch {} });
  });
});
async function openNotification(id) {
  if (!id.startsWith('framekeep:')) return;
  await ready;
  const job = state.jobs.find(item => `framekeep:${item.id}` === id);
  try {
    if (job?.status === 'complete') await request('folder', {}, 10000);
    else await chrome.tabs.create({url: chrome.runtime.getURL('popup.html?view=window')});
    if (job) job.unread = false;
    await saveJobs();
    await chrome.notifications.clear(id);
    publish();
  } catch { /* The completion remains in history if the helper is unavailable. */ }
}
chrome.notifications.onClicked.addListener(id => { openNotification(id).catch(() => {}); });
chrome.notifications.onButtonClicked.addListener(id => { openNotification(id).catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => {
  repairTranscriptTabs().catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({id: 'framekeep-save', title: 'Save with Framekeep', contexts: ['page', 'link'],
      documentUrlPatterns: PLATFORMS.flatMap(platform => platform.domains.map(domain => `https://*.${domain}/*`))});
  });
});
chrome.contextMenus.onClicked.addListener(async info => {
  if (info.menuItemId !== 'framekeep-save') return;
  try {
    const contextUrl = normalizeUrl(info.linkUrl || info.pageUrl);
    await chrome.storage.session.set({contextUrl});
    state.probe = {status: 'idle'};
    await chrome.action.openPopup();
  } catch { await chrome.action.openPopup().catch(() => {}); }
});
