import {duration, ACTIVE, PLATFORMS, transferView, transferPresentation, downloadKey} from './shared.js';
import {createTransport, desktop} from './transport.js';
import {icon, decorateIcons} from './ui-icons.js';
const $ = id => document.getElementById(id);
const port = createTransport();
const UI_VERSION = globalThis.chrome?.runtime?.getManifest?.().version_name || globalThis.chrome?.runtime?.getManifest?.().version || '1.8.0-beta.2';
let current, displayedInfo, historyKey, transcriptKey, sourceUrl, pageKey, deleteId;
let formatIntentId, preferencesLoaded = false, view = document.documentElement.classList.contains('panel') ? 'transcript' : 'save', pendingStart = false;
let resultTimer, scanTimer, autoScanCount = 0, completionJobId;
let pendingJobIds = new Set();
const transferRows = new Map();
const dismissedResults = new Set();
let kind = 'video', videoQuality = '1080', audioQuality = '192';
const text = (id, value = '') => { if ($(id).textContent !== value) $(id).textContent = value; };
const send = (action, fields = {}) => port.postMessage({action, ...fields});
$('platform-list').textContent = PLATFORMS.map(platform => platform.name).join(' · ');
function notice(message) {
  text('notice', message || ''); $('notice').hidden = !message;
  if (message) for (const id of ['empty', 'loading', 'video']) $(id).hidden = true;
}
function choices() {
  const info = current?.probe.info; if (!info) return;
  const options = kind === 'audio' ? [['128', '128 kbps · smaller'], ['192', '192 kbps · balanced'], ['320', '320 kbps · highest']] : [['best', 'Best available'], ...info.heights.map(height => [String(height), `${height}p${height >= 2160 ? ' · 4K' : height === 1080 ? ' · Full HD' : ''}`])];
  $('quality').replaceChildren(...options.map(([value, label]) => { const el = document.createElement('option'); el.value = value; el.textContent = label; return el; }));
  const preferred = kind === 'video' ? videoQuality : audioQuality;
  $('quality').value = options.some(([value]) => value === preferred) ? preferred : options[0][0];
  text('quality-note', kind === 'video' ? 'Resolution is capped at your choice. Picture and sound are merged locally.' : 'MP3 is converted locally. A higher bitrate cannot restore missing source detail.');
  $('quality').title = $('quality-note').textContent;
}
function setView(next) {
  view = next;
  document.body.dataset.view = next;
  for (const [name, section] of [['save', 'composer'], ['transcript', 'transcript-view'], ['history', 'history']]) {
    $(section).hidden = view !== name; const button = $(name + '-tab'); button.classList.toggle('selected', view === name);
    if (view === name) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  $('main').scrollTop = 0; $('save-actions').hidden = view !== 'save';
  if (view === 'history') send('acknowledge');
}
function renderHistory(jobs) {
  const visible = jobs.filter(job => !['trashed', 'missing'].includes(job.fileState));
  const finished = visible.filter(job => !ACTIVE.has(job.status)); text('history-count', String(visible.length));
  $('clear').disabled = !finished.length; $('history-empty').hidden = finished.length > 0;
  const busy = jobs.some(job => ACTIVE.has(job.status) || job.fileState === 'trashing');
  const key = JSON.stringify([finished, busy]); if (key === historyKey) return; historyKey = key;
  $('jobs').replaceChildren(...finished.map(job => {
    const card = document.createElement('article'); card.className = `job ${job.status}`;
    const tile = document.createElement('div'); tile.className = 'job-tile'; tile.append(icon(job.kind === 'audio' ? 'audio' : 'video')); card.append(tile);
    const title = document.createElement('p'); title.className = 'job-title'; title.textContent = job.title; title.title = job.title;
    const row = document.createElement('div'); row.className = 'job-status'; const status = document.createElement('span'); const result = transferView(job);
    const removed = ['trashed', 'missing'].includes(job.fileState);
    status.textContent = job.fileState === 'trashed' ? 'Moved to Recycle Bin' : job.fileState === 'missing' ? 'File no longer in the save folder' : job.fileState === 'trashing' ? 'Moving to Recycle Bin…' : job.status === 'complete' ? `✓ Saved · ${job.kind === 'audio' ? 'MP3' : 'MP4'}${result.bytes ? ' · ' + result.bytes : ''}` : job.error || result.title; row.append(status);
    if (job.status === 'complete' && !removed) {
      const actions = document.createElement('div'); actions.className = 'job-actions';
      const button = document.createElement('button'); button.className = 'text-button'; button.textContent = 'Open folder ↗'; button.onclick = () => send('folder'); actions.append(button);
      if (job.filename) {
        const remove = document.createElement('button'); remove.className = 'text-button danger'; remove.textContent = 'Delete file'; remove.disabled = busy;
        remove.onclick = () => { deleteId = job.id; text('delete-filename', job.filename); $('delete-dialog').showModal(); }; actions.append(remove);
      }
      row.append(actions);
    }
    const copy = document.createElement('div'); copy.className = 'job-copy'; copy.append(title, row); card.append(copy);
    if (job.fileError) { const error = document.createElement('p'); error.className = 'hint danger'; error.textContent = job.fileError; error.setAttribute('role', 'alert'); card.append(error); }
    return card;
  }));
}
function renderTransfers(jobs) {
  clearTimeout(resultTimer);
  const active = jobs.filter(job => ACTIVE.has(job.status));
  $('transfer').hidden = !active.length;
  text('active-heading', `${active.length} download${active.length === 1 ? '' : 's'} running`);
  const ids = new Set(active.map(job => job.id));
  for (const [id, row] of transferRows) if (!ids.has(id)) { row.remove(); transferRows.delete(id); }
  for (const job of [...active].reverse()) {
    let row = transferRows.get(job.id);
    if (!row) {
      row = document.createElement('article'); row.className = 'transfer-item'; row.dataset.jobId = job.id;
      const top = document.createElement('div'); top.className = 'transfer-item-heading';
      const title = document.createElement('span'); title.className = 'transfer-item-title';
      const metric = document.createElement('span'); metric.className = 'transfer-metric';
      const cancel = document.createElement('button'); cancel.className = 'text-button transfer-cancel'; cancel.textContent = 'Cancel';
      cancel.onclick = () => { cancel.disabled = true; send('cancel', {id: job.id}); };
      const progress = document.createElement('progress'); progress.max = 100;
      const stats = document.createElement('div'); stats.className = 'transfer-item-stats';
      top.append(title, metric, cancel); row.append(top, progress, stats);
      row.parts = {title, metric, cancel, progress, stats};
      transferRows.set(job.id, row); $('active-jobs').append(row);
    }
    const result = transferView(job), {title, metric, cancel, progress, stats} = row.parts;
    title.textContent = job.title; title.title = job.title;
    metric.textContent = result.metric;
    cancel.disabled = job.status === 'cancelling'; cancel.setAttribute('aria-label', `Cancel ${job.title}`);
    if (result.percent === null) progress.removeAttribute('value'); else progress.value = result.percent;
    progress.setAttribute('aria-label', `${job.title}: ${result.title}`);
    stats.textContent = [result.title, result.bytes, result.speed, result.eta].filter(Boolean).join(' · ');
    stats.title = result.detail;
    if (row.dataset.status !== job.status) text('announcement', `${result.title}. ${job.title}`);
    row.dataset.status = job.status;
  }
  const latest = jobs.filter(job => transferPresentation(job, Date.now(), dismissedResults.has(job.id)) === 'result').sort((a,b) => b.finished-a.finished)[0];
  $('completion').hidden = !latest;
  completionJobId = latest?.id;
  if (latest) {
    text('completion-text', latest.status === 'complete' ? `✓ Saved · ${latest.title}` : `${transferView(latest).title} · ${latest.title}`);
    $('completion-text').title = $('completion-text').textContent;
    $('completion').classList.toggle('failed', ['error', 'interrupted'].includes(latest.status));
    if (!['error', 'interrupted'].includes(latest.status)) resultTimer = setTimeout(() => renderTransfers(current?.jobs || []), Math.max(10, 8000 - (Date.now() - latest.finished)));
  }
}
function renderCues() {
  const transcript = current?.transcript; if (transcript?.status !== 'ready') return;
  const query = $('transcript-search').value.trim().toLocaleLowerCase();
  const cues = transcript.cues.filter(cue => !query || cue.text.toLocaleLowerCase().includes(query));
  const canSeek = /(?:youtube\.com|vimeo\.com)\//.test(transcript.url);
  $('cues').replaceChildren(...cues.map(cue => {
    const row = document.createElement('div'); row.className = 'cue';
    const stamp = document.createElement('button'); stamp.className = 'cue-time'; stamp.textContent = duration(cue.start); stamp.disabled = !canSeek;
    stamp.title = canSeek ? 'Open video at this timestamp' : 'Caption timestamp'; stamp.onclick = () => send('seek', {seconds: cue.start});
    const paragraph = document.createElement('p'); paragraph.textContent = cue.text; row.append(stamp, paragraph); return row;
  }));
  text('transcript-feedback', `${cues.length} of ${transcript.cues.length} segments${transcript.truncated ? ' · Long transcript limited to the first 5,000 segments / 700 KB.' : ''}`);
}
function renderTranscript(state) {
  const transcript = state.transcript || {status: 'idle'};
  const key = `${transcript.status}:${transcript.url}:${transcript.language}:${transcript.error || ''}`;
  if (key === transcriptKey) return; transcriptKey = key;
  const ready = transcript.status === 'ready';
  text('transcript-badge', ready ? 'Ready' : transcript.status === 'loading' ? '…' : '—'); $('transcript-badge').classList.toggle('ready', ready);
  text('transcript-source', state.probe.info?.title || 'Captions load automatically when you check a video.');
  const messages = {idle: 'Choose a video in Save video to see its transcript.', loading: 'Loading the video’s captions… You can download while this finishes.', unavailable: 'This video does not provide source captions. Open Browser transcript to generate text from live tab audio or accessible saved media with your installed local speech model.', error: transcript.error};
  text('transcript-message', messages[transcript.status] || ''); $('transcript-message').hidden = ready;
  $('transcript-retry').hidden = transcript.status !== 'error';
  const tracks = state.probe.info?.tracks || [];
  $('transcript-tools').hidden = !tracks.length;
  for (const id of ['copy-transcript', 'save-transcript', 'transcript-search']) $(id).disabled = !ready;
  $('language').replaceChildren(...tracks.map(track => { const option = document.createElement('option'); option.value = track.language; option.textContent = `${track.name} (${track.language})${track.automatic ? ' · automatic' : ''}`; return option; }));
  if (transcript.language) $('language').value = transcript.language;
  $('language').disabled = transcript.status === 'loading';
  if (ready) { text('transcript-source', `${transcript.name || transcript.language} · ${transcript.automatic ? 'Automatic captions' : 'Creator-provided captions'}`); renderCues(); }
  else $('cues').replaceChildren();
}
function render(state) {
  if (state.uiError) { pendingStart = false; notice(state.uiError); return; }
  if (state.transcript?.unchanged) state.transcript = {...state.transcript, cues: current?.transcript?.cues || []};
  current = state;
  renderPage(state.page);
  if (!preferencesLoaded) { kind = state.settings.kind; videoQuality = state.settings.quality; audioQuality = state.settings.audioQuality; document.querySelector(`input[name="kind"][value="${kind === 'audio' ? 'audio' : 'video'}"]`).checked = true; preferencesLoaded = true; }
  if (state.formatIntent && state.formatIntent.id !== formatIntentId) {
    formatIntentId=state.formatIntent.id;kind=state.formatIntent.kind==='audio'?'audio':'video';
    document.querySelector(`input[name="kind"][value="${kind}"]`).checked=true;choices();
  }
  const audioOnly=state.probe.status==='ready'&&state.probe.info.audioOnly===true;
  document.querySelector('input[name="kind"][value="video"]').disabled=audioOnly;
  if(audioOnly&&kind!=='audio'){kind='audio';document.querySelector('input[name="kind"][value="audio"]').checked=true;choices();}
  const staleWorker = !desktop && (state.protocol !== 2 || state.workerVersion !== UI_VERSION);
  const available = state.helper.status === 'ready' && !staleWorker; $('helper-dot').className = `dot ${state.helper.status}`;
  text('helper-label', available ? (desktop ? 'On your computer' : 'Connected') : state.helper.status === 'checking' ? 'Connecting…' : 'Needs setup'); $('recheck').hidden = available || state.helper.status === 'checking';
  $('folder').disabled = !available;
  text('helper-info', available ? `Framekeep ${UI_VERSION} · Helper ${state.helper.version} · yt-dlp ${state.helper.extractor}\n${state.helper.location || ''}` : state.helper.error || 'The helper is not connected. Run the installer, then choose Retry.');
  text('save-path', state.helper.directory ? `Save folder: ${state.helper.directory}` : ''); text('destination', state.helper.directory ? 'Saved to Downloads / Framekeep' : 'Saved on your computer'); $('destination').title = state.helper.directory || '';
  $('notifications-toggle').checked = state.settings.notifications !== false;
  text('notification-note', desktop ? 'Play a short sound when a download finishes. Your saved videos stay in Downloads.' : state.alerts?.status === 'denied' ? 'Desktop notifications are blocked. Enable them for Chrome in Windows settings. The completion badge will still appear.' : 'A completion badge also stays on the toolbar until you view your downloads.');
  const activeJob = state.jobs.find(job => ACTIVE.has(job.status)), loading = state.probe.status === 'loading', videoReady = state.probe.status === 'ready';
  $('save-actions').hidden = view !== 'save';
  if (pendingStart && state.jobs.some(job => !pendingJobIds.has(job.id))) pendingStart = false;
  $('inspect').disabled = !available || loading || pendingStart; $('formats').disabled = !videoReady || pendingStart; $('quality').disabled = !videoReady || pendingStart; $('download').disabled = !available || !videoReady || pendingStart;
  text('download-label', pendingStart ? 'Starting download…' : kind === 'video' ? 'Save video' : 'Save audio');
  $('loading').hidden = !loading; $('empty').hidden = videoReady || loading; $('video').hidden = !videoReady;
  if (state.probe.status === 'error') notice(state.probe.error); else if (!$('notice').hidden && (loading || videoReady)) notice('');
  if (state.helper.status === 'missing' && !videoReady && !loading) notice(state.helper.error || 'The local helper needs setup. Open Settings & help for the installation steps.');
  if (staleWorker) notice(`Framekeep was updated to ${UI_VERSION}. Reload it once on Chrome’s Extensions page to activate the updated downloader.`);
  if (state.probe.url && sourceUrl !== state.probe.url) { sourceUrl = state.probe.url; $('video-url').value = state.probe.source?.pageUrl || sourceUrl; }
  if (!videoReady) displayedInfo = '';
  if (videoReady && displayedInfo !== state.probe.url) {
    displayedInfo = state.probe.url; text('video-title', state.probe.info.title); $('video-title').title = state.probe.info.title;
    text('channel', state.probe.info.channel); text('duration', duration(state.probe.info.duration)); $('duration').hidden = !$('duration').textContent; text('platform-name', state.probe.info.platform || 'Video');
    choices();
  }
  if (videoReady) {
    const thumbnail = state.probe.info.thumbnail;
    if ($('thumbnail').getAttribute('src') !== (thumbnail || null)) {
      $('thumbnail').hidden = !thumbnail;
      if (thumbnail) $('thumbnail').src = thumbnail; else $('thumbnail').removeAttribute('src');
    }
  }
  document.body.classList.toggle('video-ready', videoReady);
  const selectedKey = videoReady ? downloadKey(state.probe.source?.pageUrl || state.probe.url, kind, $('quality').value) : '';
  if (state.jobs.some(job => ACTIVE.has(job.status) && job.key === selectedKey)) { $('download').disabled = true; text('download-label', 'Already downloading'); }
  renderHistory(state.jobs); renderTransfers(state.jobs); renderTranscript(state);
  if (autoScanCount >= 3 && state.page?.status === 'ready' && !state.page.platformUrl && !state.page.candidates?.length) text('page-message', 'No video found yet. Start playback, then choose Refresh.');
  clearTimeout(scanTimer);
  if (state.page?.status === 'ready' && !state.page.platformUrl && !state.page.candidates?.length && !activeJob && autoScanCount < 3 && state.probe.status === 'idle') {
    scanTimer = setTimeout(() => { autoScanCount++; send('scan'); }, 2500);
  }
}
function renderPage(page = {status: 'idle', candidates: [], origins: []}) {
  const key = JSON.stringify([page, current?.probe?.url, current?.probe?.status]); if (key === pageKey) return; pageKey = key;
  const count = page.candidates?.length || 0;
  text('page-heading', page.status === 'scanning' ? 'Looking for videos…' : page.platformUrl ? 'Video detected' : count ? `${count} video${count === 1 ? '' : 's'} available` : 'Videos on this page');
  text('page-message', page.status === 'scanning' ? 'Checking the player on your current tab.' : page.message || 'Videos appear here automatically.');
  $('find-page').disabled = page.status === 'scanning';
  $('scan-frames').hidden = !page.origins?.length;
  $('frame-note').hidden = !page.origins?.length;
  text('frame-note', page.origins?.length ? 'Allow access to check embedded players from ' + page.origins.map(value => new URL(value).hostname).join(', ') : '');
  // A single detected video opens its preview automatically. Multiple sources stay easy to choose.
  $('page-videos').hidden = count < 2;
  $('page-videos').replaceChildren(...(page.candidates || []).map((source, index) => {
    const button = document.createElement('button'); button.className = 'page-choice';
    const selected = current?.probe?.url === source.url;
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
    const name = document.createElement('strong'); name.textContent = source.title || `Video ${index + 1}`;
    const detail = document.createElement('small'); detail.textContent = `${selected ? 'Selected · ' : ''}${new URL(source.url).hostname} · ${source.type === 'embed' ? 'Player' : /\.m3u8(?:[?#]|$)/i.test(source.url) ? 'Stream' : 'Video'}`;
    const mark = document.createElement('span'); mark.textContent = selected ? '✓' : '→'; mark.setAttribute('aria-hidden', 'true');
    const preview = document.createElement('div'); preview.className = 'choice-preview';
    if (source.thumbnail) { const img = document.createElement('img'); img.src = source.thumbnail; img.alt = ''; img.referrerPolicy = 'no-referrer'; img.onerror = () => { img.remove(); preview.append(icon('video')); }; preview.append(img); } else preview.append(icon('video'));
    const copy = document.createElement('div'); copy.className = 'choice-copy'; copy.append(name, detail);
    button.append(preview, copy, mark); button.disabled = current?.probe?.status === 'loading';
    button.onclick = () => { displayedInfo = null; notice(''); send('page-video', {id: source.id}); setView('save'); };
    return button;
  }));
}
$('find-page').onclick = () => { autoScanCount = 0; send('scan'); };
$('scan-frames').onclick = async () => {
  const origins = current?.page?.origins || []; if (!origins.length) return;
  try { const granted = await chrome.permissions.request({origins}); if (granted) send('scan'); else text('page-message', 'Player access was not granted. You can still use the sources already found.'); }
  catch { text('page-message', 'Chrome could not grant player access. Try reopening Framekeep on the video page.'); }
};
$('delete-cancel').onclick = () => $('delete-dialog').close();
$('delete-confirm').onclick = () => { $('delete-dialog').close(); if (deleteId) send('trash', {id: deleteId}); deleteId = null; };
$('completion-view').onclick = () => { dismissedResults.add(completionJobId); $('completion').hidden = true; setView('history'); };
$('all-downloads').onclick = () => setView('history');
$('completion-dismiss').onclick = () => { dismissedResults.add(completionJobId); $('completion').hidden = true; send('acknowledge'); };
$('url-form').addEventListener('submit', event => { event.preventDefault(); notice(''); autoScanCount = 3; clearTimeout(scanTimer); displayedInfo = null; send('analyze', {url: $('video-url').value}); });
for (const name of ['save', 'transcript', 'history']) $(name + '-tab').onclick = () => setView(name);
$('help-toggle').onclick = () => $('settings-dialog').showModal(); $('dialog-close').onclick = () => $('settings-dialog').close();
$('expand').onclick = () => send('expand');
$('sidebar').onclick = async () => { try { const window = await chrome.windows.getCurrent(); await chrome.sidePanel.setOptions({path:'popup.html?view=panel',enabled:true}); await chrome.sidePanel.open({windowId: window.id}); } catch { notice('Chrome could not open the sidebar. Use Open larger view instead.'); } };
$('recheck').onclick = () => send('check'); for (const id of ['folder']) $(id).onclick = () => { send('folder'); send('acknowledge'); };
$('thumbnail').onerror = () => { $('thumbnail').hidden = true; }; $('clear').onclick = () => send('clear');
function savePreferences() { send('settings', {kind, quality: videoQuality, audioQuality, notifications: $('notifications-toggle').checked}); }
for (const input of document.querySelectorAll('input[name="kind"]')) input.addEventListener('change', () => { kind = input.value; choices(); text('download-label', kind === 'video' ? 'Save video' : 'Save audio'); savePreferences(); });
$('quality').onchange = () => { if (kind === 'video') videoQuality = $('quality').value; else audioQuality = $('quality').value; savePreferences(); }; $('notifications-toggle').onchange = savePreferences;
$('download').onclick = () => { notice(''); pendingStart = true; pendingJobIds = new Set(current.jobs.map(job => job.id)); $('download').disabled = true; text('download-label', 'Starting download…'); send('download', {kind, quality: $('quality').value}); };
$('language').onchange = () => send('transcript', {language: $('language').value}); $('transcript-retry').onclick = () => send('transcript', {language: current.transcript.language});
$('transcript-search').oninput = renderCues; $('timestamps').onchange = () => $('cues').classList.toggle('hide-times', !$('timestamps').checked);
function transcriptText() { return (current?.transcript?.cues || []).map(cue => `${$('timestamps').checked ? '[' + duration(cue.start) + '] ' : ''}${cue.text}`).join('\n'); }
$('copy-transcript').onclick = async () => { try { await navigator.clipboard.writeText(transcriptText()); text('transcript-feedback', 'Transcript copied.'); } catch { text('transcript-feedback', 'Copy was blocked by Chrome. Use Save .txt instead.'); } };
$('save-transcript').onclick = () => { const url = URL.createObjectURL(new Blob([transcriptText()], {type: 'text/plain;charset=utf-8'})); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `Framekeep transcript ${current.transcript.language}.txt`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); text('transcript-feedback', 'Transcript sent to Chrome’s downloads.'); };
if (desktop) {
  $('paste-link').open = true;
  $('video-url').placeholder = 'Paste a video link…';
  $('save-transcript').onclick = () => send('export-transcript', {timestamps: $('timestamps').checked});
  $('copy-transcript').onclick = () => { send('copy-transcript', {timestamps: $('timestamps').checked}); text('transcript-feedback', 'Transcript copied.'); };
  $('clear').hidden = true;
  $('notification-setting').querySelector('strong').textContent = 'Completion sound';
  $('notification-setting').querySelector('small').textContent = 'Know when a download is ready, even when the app is minimized.';
  text('notification-note', 'Downloads continue while this window is minimized. Framekeep asks before closing an active download.');
}
decorateIcons();
port.onMessage.addListener(render); port.onDisconnect.addListener(() => { clearTimeout(scanTimer); clearTimeout(resultTimer); notice(chrome.runtime.lastError?.message || 'The extension connection closed. Reopen Framekeep.'); $('download').disabled = true; $('inspect').disabled = true; });
setView(view);
send('init');

$('open-desktop').onclick = () => send('desktop');
$('desktop-handoff').onclick = () => send('desktop');
if (desktop) $('desktop-handoff').hidden = true;

// Restore the page widget, including a site on which it was disabled.
import {openBrowserTranscriptPanel} from './browser-transcript-ui.js';
if (!desktop) $('browserTranscriptOpen').onclick = () => openBrowserTranscriptPanel().catch(error => { $('bubble-feedback').textContent=error.message || 'Open a supported media tab and try again.'; });
else $('browserTranscriptOpen').hidden=true;
if (desktop) $('show-page-bubble').parentElement.hidden = true;
else $('show-page-bubble').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (!tab?.id || !/^https?:\/\//.test(tab.url || '')) throw Error('Open a webpage first.');
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:['capture-discovery.js','floating.js']});
    const result=await chrome.tabs.sendMessage(tab.id,{action:'show-framekeep'},{frameId:0});
    if(!result?.shown)throw Error('Widget did not restore');
    window.close();
  } catch { $('bubble-feedback').textContent='Refresh the webpage, then try again. Chrome internal pages do not allow the bubble.'; }
});
