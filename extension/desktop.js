import {createTransport} from './transport.js';
import {duration, formatBytes, transferView} from './shared.js';
import {icon as baseIcon} from './ui-icons.js';

const $ = id => document.getElementById(id);
const port = createTransport();
const RUNNING = new Set(['queued', 'starting', 'running', 'downloading', 'processing', 'cancelling']);
const icons = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  activity: '<path d="M3 13h4l3-8 4 14 3-6h4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 5 5 3-3 4 4"/>',
};
function icon(name) {
  const node = baseIcon(name);
  if (icons[name]) node.innerHTML = icons[name];
  return node;
}
for (const node of document.querySelectorAll('[data-icon]')) node.replaceChildren(icon(node.dataset.icon));
const send = (action, fields = {}) => port.postMessage({action, ...fields});
const text = (id, value = '') => { if ($(id).textContent !== String(value)) $(id).textContent = String(value); };
const node = (tag, className, content) => { const item = document.createElement(tag); if (className) item.className = className; if (content !== undefined) item.textContent = content; return item; };
const button = (label, className, action) => { const item = node('button', className, label); item.type = 'button'; item.onclick = action; return item; };
const sourceHost = value => { try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return ''; } };
const safeUrl = value => { try { const url = new URL(value, location.href); return ['http:', 'https:', 'blob:', 'data:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
const mediaKind = item => ['image', 'video', 'audio'].includes(item?.kind) ? item.kind : 'video';
const dateLabel = value => { const date = new Date(value || 0); return Number.isFinite(date.valueOf()) && date.getFullYear() > 1970 ? date.toLocaleDateString(undefined, {month: 'short', day: 'numeric'}) : ''; };
let state, view = 'library', type = 'all', collection = '', selectedId = null;
let libraryKey, activityKey, collectionsKey, workspaceKey, captionsKey, evidenceKey, captureKey;
let pendingDownload = false, pendingJobIds = new Set(), pendingCollection = null, toastTimer, captureRequested = false;

function announce(message) {
  text('toast', message); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500);
}
function error(message) { text('error-message', message); $('error-banner').hidden = !message; }
function library() { return Array.isArray(state?.library) ? state.library : (state?.jobs || []).filter(job => job.status === 'complete' && !['missing', 'trashed'].includes(job.fileState)); }
function setView(next, focus = true) {
  if (view === 'workspace' && next !== 'workspace') $('media-stage').querySelectorAll('video,audio').forEach(media => media.pause());
  view = next;
  for (const name of ['library', 'activity', 'settings', 'workspace']) $(name + '-view').hidden = name !== next;
  for (const name of ['library', 'activity', 'settings']) {
    const active = name === next || name === 'library' && next === 'workspace';
    $('nav-' + name).classList.toggle('selected', active);
    if (active) $('nav-' + name).setAttribute('aria-current', 'page'); else $('nav-' + name).removeAttribute('aria-current');
  }
  $('main').scrollTop = 0;
  if (focus) $('main').focus({preventScroll: true});
  if (next === 'activity') send('acknowledge');
  if (next === 'library') renderLibrary();
}
function waveform() {
  const wave = node('span', 'audio-glyph'); wave.setAttribute('aria-hidden', 'true');
  for (const height of [10, 18, 29, 20, 39, 26, 44, 34, 20, 37, 26, 16, 23, 11]) { const bar = node('i'); bar.style.height = height + 'px'; wave.append(bar); }
  return wave;
}
function renderCollections() {
  const names = [...new Set(library().map(item => item.collection).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const key = JSON.stringify([names, collection]); if (key === collectionsKey) return; collectionsKey = key;
  $('collection-hint').hidden = names.length > 0;
  $('collections').replaceChildren(...names.map(name => {
    const entry = button('', 'collection-nav' + (collection === name ? ' selected' : ''), () => { collection = collection === name ? '' : name; setView('library'); renderCollections(); });
    entry.append(node('span', '', name)); entry.setAttribute('aria-pressed', String(collection === name)); entry.title = name; return entry;
  }));
  $('collection-options').replaceChildren(...names.map(name => { const option = node('option'); option.value = name; return option; }));
}
function renderLibrary() {
  if (!state) return;
  const query = $('library-search').value.trim().toLocaleLowerCase();
  const all = library();
  const items = all.filter(item => (type === 'all' || mediaKind(item) === type) && (!collection || item.collection === collection) && (!query || [item.title, item.filename, item.sourceUrl, item.collection].filter(Boolean).join(' ').toLocaleLowerCase().includes(query)));
  const sort = $('sort-order').value;
  items.sort((a, b) => sort === 'title' ? (a.title || a.filename || '').localeCompare(b.title || b.filename || '') : sort === 'oldest' ? (a.finished || a.created || 0) - (b.finished || b.created || 0) : (b.finished || b.created || 0) - (a.finished || a.created || 0));
  text('library-title', collection || 'Library');
  text('library-subtitle', collection ? 'A collection from your saved library.' : 'A place for things worth coming back to.');
  text('visible-count', `${items.length} item${items.length === 1 ? '' : 's'}`);
  $('library-loading').hidden = true; $('library-empty').hidden = all.length > 0; $('library-no-results').hidden = all.length === 0 || items.length > 0; $('library-grid').hidden = !items.length;
  const key = JSON.stringify(items); if (key === libraryKey) return; libraryKey = key;
  $('library-grid').replaceChildren(...items.map(item => {
    const kind = mediaKind(item), card = button('', 'media-card', () => selectItem(item.id));
    card.dataset.itemId = item.id; card.setAttribute('aria-label', `Open ${item.title || item.filename}, ${kind}`);
    const preview = node('div', 'card-preview ' + kind);
    const url = safeUrl(item.thumbnailUrl || item.previewUrl);
    if (url && kind === 'image') {
      const image = node('img'); image.src = url; image.loading = 'lazy'; image.alt = ''; image.referrerPolicy = 'no-referrer';
      image.onerror = () => { image.remove(); preview.prepend(icon('image')); }; preview.append(image);
    } else if (url && kind === 'video') {
      const video = node('video'); video.src = url; video.preload = 'metadata'; video.muted = true; video.playsInline = true; video.tabIndex = -1; video.setAttribute('aria-hidden', 'true');
      video.onloadedmetadata = () => { if (Number.isFinite(video.duration) && video.duration > .2) video.currentTime = Math.min(.2, video.duration / 2); };
      video.onerror = () => { video.remove(); preview.prepend(icon('video')); }; preview.append(video);
    } else preview.append(kind === 'audio' ? waveform() : icon(kind));
    preview.append(node('span', 'card-kind', kind));
    if (Number.isFinite(item.duration)) preview.append(node('span', 'card-duration', duration(item.duration)));
    const copy = node('div', 'card-copy'), title = node('h2', 'card-title', item.title || item.filename || 'Saved media'); title.title = title.textContent;
    const meta = node('p', 'card-subtitle'); meta.append(node('span', '', sourceHost(item.sourceUrl) || formatBytes(item.bytes) || 'Saved locally'), node('span', '', dateLabel(item.finished || item.created)));
    copy.append(title, meta); if (item.collection) copy.append(node('p', 'card-collection', item.collection));
    card.append(preview, copy); return card;
  }));
}
function selectItem(id) {
  selectedId = id; workspaceKey = captionsKey = evidenceKey = null;
  $('caption-search').value = ''; text('collection-feedback', ''); pendingCollection = null;
  send('select-item', {id});
  setView('workspace');
  renderWorkspace(library().find(item => item.id === id));
}
function renderWorkspace(item) {
  if (!item || view !== 'workspace') return;
  text('item-title', item.title || item.filename || 'Saved media'); text('item-kind', `${mediaKind(item)} · saved locally`);
  text('item-meta', [formatBytes(item.bytes), dateLabel(item.finished || item.created)].filter(Boolean).join(' · ')); text('item-filename', item.filename || '');
  text('item-id', item.id || ''); text('item-source', item.sourceUrl || 'No source link was recorded for this local file.');
  $('open-source').disabled = !item.sourceUrl; $('open-source').title = item.sourceUrl || 'No source link was recorded';
  if (document.activeElement !== $('item-collection')) $('item-collection').value = item.collection || '';
  if (pendingCollection !== null && item.collection === pendingCollection) { text('collection-feedback', item.collection ? `Saved to ${item.collection}.` : 'Removed from collection.'); pendingCollection = null; }
  const key = JSON.stringify([item.id, item.previewUrl, item.kind]);
  if (key !== workspaceKey) {
    workspaceKey = key; $('preview-error').hidden = true;
    const kind = mediaKind(item), url = safeUrl(item.previewUrl);
    $('media-stage').replaceChildren();
    if (url) {
      const media = node(kind === 'image' ? 'img' : kind); media.src = url;
      if (kind === 'image') media.alt = item.title || item.filename || 'Saved image';
      else { media.controls = true; media.preload = 'metadata'; media.setAttribute('aria-label', `${kind === 'video' ? 'Video' : 'Audio'} player for ${item.title || item.filename}`); }
      media.onerror = () => { $('preview-error').hidden = false; };
      if (kind === 'audio') { const art = node('div', 'audio-stage'); art.append(waveform(), node('p', '', 'Original audio')); $('media-stage').append(art); }
      $('media-stage').append(media);
    } else { const placeholder = node('div', 'preview-placeholder'); placeholder.append(icon(kind), node('p', '', 'Preview is unavailable for this file. Open it with your Windows app.')); $('media-stage').append(placeholder); }
  }
  renderCaptions(item); renderEvidence(item);
}
function transcriptFor(item) { return item?.transcript || {status: 'idle'}; }
function renderCaptions(item) {
  const transcript = transcriptFor(item), ready = transcript.status === 'ready', cues = Array.isArray(transcript.cues) ? transcript.cues : [];
  const key = JSON.stringify([item.id, transcript, $('caption-search').value]); if (key === captionsKey) return; captionsKey = key;
  const labels = {'source-captions': 'Source captions', 'sidecar-captions': 'Saved sidecar captions', 'generated-transcription': 'Generated transcription'};
  const origin = labels[transcript.source] || 'Source captions';
  const hasLanguage = value => Boolean(value && String(value).toLowerCase() !== 'und');
  text('caption-provenance', ready ? `${origin}${transcript.automatic ? ' · automatically captioned by the source' : ''}${hasLanguage(transcript.language) ? ' · ' + transcript.language : ''}. Check against the original.` : 'Captions come from the source or a saved caption file. They are separate from generated transcription.');
  text('caption-message', ready ? '' : transcript.status === 'loading' ? 'Loading available captions…' : transcript.status === 'error' ? transcript.error || 'Captions could not be loaded. Check the source and try again.' : transcript.status === 'unavailable' ? 'No source captions are available for this item. You can still play and reopen the original media.' : mediaKind(item) === 'image' ? 'Images do not have a caption timeline.' : item.sourceUrl ? 'Check the original source for available captions.' : 'No captions or source link were recorded for this file.');
  $('caption-message').hidden = ready;
  $('load-captions').hidden = ready || transcript.status === 'loading' || mediaKind(item) === 'image' || !item.sourceUrl;
  text('load-captions', transcript.status === 'error' ? 'Retry source captions' : 'Check source captions');
  $('caption-tools').hidden = !ready;
  const tracks = transcript.tracks || item.tracks || [];
  const languages = tracks.length ? tracks : [{language: transcript.language || '', name: transcript.language || 'Available captions'}];
  $('caption-language').replaceChildren(...languages.map(track => { const option = node('option', '', hasLanguage(track.language) ? track.name || track.label || track.language : 'Language not specified'); option.value = track.language; return option; }));
  $('caption-language').value = transcript.language || ''; $('caption-language').disabled = languages.length < 2;
  const query = $('caption-search').value.trim().toLocaleLowerCase();
  const matches = cues.filter(cue => !query || String(cue.text || '').toLocaleLowerCase().includes(query));
  text('caption-count', `${matches.length} ${query ? 'match' + (matches.length === 1 ? '' : 'es') : 'segment' + (matches.length === 1 ? '' : 's')}`);
  $('caption-cues').replaceChildren(...matches.map(cue => {
    const row = node('div', 'caption-cue'); const stamp = button(duration(Number(cue.start) || 0), 'cue-time', () => {
      const media = $('media-stage').querySelector('video,audio');
      if (media) { media.currentTime = Number(cue.start) || 0; media.focus(); announce(`Moved to ${duration(Number(cue.start) || 0)}. Press play to continue.`); }
      else { announce('Open the media file to play this timestamp.'); }
    }); stamp.setAttribute('aria-label', `Seek to ${duration(Number(cue.start) || 0)}`); stamp.disabled = !item.previewUrl || mediaKind(item) === 'image';
    const copy = node('p'); const value = String(cue.text || '');
    if (query) { let offset = 0, index; const lower = value.toLocaleLowerCase(); while ((index = lower.indexOf(query, offset)) >= 0) { copy.append(document.createTextNode(value.slice(offset, index)), node('mark', '', value.slice(index, index + query.length))); offset = index + query.length; } copy.append(document.createTextNode(value.slice(offset))); }
    else copy.textContent = value;
    row.append(stamp, copy); return row;
  }));
  if (ready && !matches.length) $('caption-cues').append(node('p', 'caption-no-match', query ? 'No caption segments match this search.' : 'This caption file contains no readable segments.'));
}
function renderEvidence(item) {
  const capability = state?.capabilities?.study || {available: false};
  const study = (state?.study?.sourceItemId === item.id ? state.study : item.study) || {};
  const rawArtifacts = item.artifacts || study.artifacts || [];
  const artifacts = Array.isArray(rawArtifacts) ? rawArtifacts : Object.entries(rawArtifacts).map(([name, value]) => typeof value === 'object' ? {name, ...value} : {name, value});
  const key = JSON.stringify([item.id, capability, study, artifacts]); if (key === evidenceKey) return; evidenceKey = key;
  text('evidence-message', study.status === 'loading' ? 'Reading the prepared result…' : study.error ? study.error : artifacts.length ? 'Prepared artifacts available for this source. Review their limitations before using them.' : capability.available ? 'No prepared artifacts are attached to this item yet. You can prepare evidence using the installed study tools.' : capability.reason || 'Optional study tools are not connected. Capture, playback and source captions remain available.');
  $('artifact-list').replaceChildren(...artifacts.map((artifact, index) => {
    const row = node('article', 'artifact'); row.append(node('h3', '', artifact.name || artifact.title || artifact.kind || `Artifact ${index + 1}`));
    row.append(node('p', 'muted', artifact.description || artifact.status || 'Prepared · not independently reviewed'));
    if (artifact.mode) row.append(node('p', 'muted', 'Method: ' + artifact.mode));
    if (artifact.coverage) row.append(node('p', 'muted', 'Coverage: ' + (typeof artifact.coverage === 'string' ? artifact.coverage : JSON.stringify(artifact.coverage))));
    if (artifact.limitations) row.append(node('p', 'muted', Array.isArray(artifact.limitations) ? artifact.limitations.join(' ') : artifact.limitations));
    if (artifact.sourceUrl) row.append(node('p', 'muted', 'Source: ' + artifact.sourceUrl));
    if (artifact.text || artifact.content) row.append(node('pre', 'artifact-body', artifact.text || artifact.content));
    if (artifact.id) {
      const actions = node('div', 'artifact-navigation');
      actions.append(button('Read artifact', 'text-button', () => send('study-artifact', {id: item.id, artifactId: artifact.id})), button('Open file ↗', 'text-button', () => send('open-artifact', {id: item.id, artifactId: artifact.id})));
      row.append(actions);
    }
    return row;
  }));
  const studyId = study.jobId || study.id || item.studyJobId;
  if (studyId) {
    if (study.canReadTranscript) $('artifact-list').append(button('Read prepared text', 'text-button', () => send('study-read', {id: item.id, chunk: 1})));
    $('artifact-list').append(node('p', 'muted', `Study job ${studyId}`));
  }
  const reading = study.read || state?.study?.sourceItemId === item.id && state.study.read;
  if (reading) {
    const content = typeof reading === 'string' ? reading : reading.text || reading.content || reading.body;
    if (content) $('artifact-list').append(node('pre', 'artifact-body', content));
    if (Number(reading.total) > 1 && studyId) {
      const navigation = node('div', 'artifact-navigation');
      const previous = button('Previous', 'text-button', () => send('study-read', {id: item.id, chunk: Number(reading.chunk) - 1})); previous.disabled = Number(reading.chunk) <= 1;
      const next = button('Next', 'text-button', () => send('study-read', {id: item.id, chunk: Number(reading.chunk) + 1})); next.disabled = Number(reading.chunk) >= Number(reading.total);
      navigation.append(previous, node('span', 'muted', `${reading.chunk} / ${reading.total}`), next); $('artifact-list').append(navigation);
    }
    const references = reading.sourceRefs || reading.sourceReferences;
    if (references) $('artifact-list').append(node('p', 'muted', 'Source references: ' + (typeof references === 'string' ? references : JSON.stringify(references))));
    if (reading.limitations) $('artifact-list').append(node('p', 'muted', Array.isArray(reading.limitations) ? reading.limitations.join(' ') : reading.limitations));
  }
  if (study.artifact?.text) {
    $('artifact-list').append(node('h3', 'artifact-heading', study.artifact.title || study.artifact.name || 'Artifact contents'), node('pre', 'artifact-body', study.artifact.text));
    if (study.artifact.complete === false) $('artifact-list').append(node('p', 'muted', 'Preview is partial. Open the artifact file to read it in full.'));
  }
  $('study-actions').hidden = !capability.available;
  if (capability.available) {
    const allowed = ['visual', 'speech', 'general'];
    const names = {visual: 'Visual evidence', speech: 'Speech and transcript', general: 'General study'};
    const existing = $('study-operation').value;
    $('study-operation').replaceChildren(...allowed.map(recipe => { const option = node('option', '', names[recipe]); option.value = recipe; return option; }));
    if (existing) $('study-operation').value = existing; else $('study-operation').value = mediaKind(item) === 'audio' ? 'speech' : 'visual';
    $('prepare-study').disabled = ['loading', 'running', 'queued'].includes(study.status);
  }
}
function renderActivity() {
  const jobs = state?.jobs || [], active = jobs.filter(job => RUNNING.has(job.status));
  text('activity-count', active.length); $('activity-count').hidden = !active.length;
  $('activity-empty').hidden = !!jobs.length;
  const key = JSON.stringify(jobs); if (key === activityKey) return; activityKey = key;
  const focusId = document.activeElement?.closest('[data-job-id]')?.dataset.jobId;
  const focusAction = document.activeElement?.dataset.jobAction;
  const expanded = new Set([...$('activity-list').querySelectorAll('[data-job-id]:has(details[open])')].map(row => row.dataset.jobId));
  $('activity-list').replaceChildren(...jobs.map(job => {
    const row = node('article', 'activity-card'); row.dataset.jobId = job.id;
    const visual = node('div', 'activity-icon'); visual.append(icon(mediaKind(job))); const copy = node('div', 'activity-copy');
    const result = transferView(job);
    const statuses = {queued: 'Queued', starting: 'Starting', downloading: 'Downloading', running: 'Running', processing: 'Processing', cancelling: 'Cancelling', complete: 'Completed', evidence_ready: 'Prepared · review status unknown', error: 'Needs attention', 'needs-attention': 'Needs attention', interrupted: 'Interrupted', cancelled: 'Cancelled'};
    copy.append(node('h2', '', job.title || job.filename || job.action || 'Media job'));
    const origin = job.origin || job.client || job.startedBy;
    copy.append(node('p', 'activity-status ' + job.status, [statuses[job.status] || job.status, origin ? `Started by ${origin}` : '', dateLabel(job.created || job.finished)].filter(Boolean).join(' · ')));
    if (RUNNING.has(job.status)) { const progress = node('progress'); progress.max = 100; if (Number.isFinite(job.percent)) progress.value = Math.max(0, Math.min(100, job.percent)); progress.setAttribute('aria-label', `${job.title || 'Job'} progress`); copy.append(progress); }
    const details = job.error || [result.bytes, result.speed, result.eta].filter(Boolean).join(' · ') || (job.status === 'complete' ? job.filename || 'Saved result is available in Library.' : RUNNING.has(job.status) ? result.title : '');
    if (details) copy.append(node('p', 'activity-detail', details));
    const identity = node('details'); identity.append(node('summary', '', 'Job details'), node('code', '', `Job ID: ${job.id}`));
    identity.open = expanded.has(job.id);
    if (job.sourceUrl) identity.append(node('code', '', `Source: ${job.sourceUrl}`));
    if (job.studyJobId) identity.append(node('code', '', `Study job ID: ${job.studyJobId}`));
    copy.append(identity);
    const actions = node('div', 'activity-actions');
    if (job.canCancel === true || job.canCancel === undefined && ['starting', 'downloading', 'processing'].includes(job.status)) {
      const cancel = button(job.status === 'cancelling' ? 'Cancelling…' : 'Cancel', 'secondary', () => { cancel.disabled = true; send('cancel', {id: job.id}); }); cancel.disabled = job.status === 'cancelling'; cancel.dataset.jobAction = 'cancel'; cancel.setAttribute('aria-label', `Cancel ${job.title || 'job'}`); actions.append(cancel);
    }
    if (job.canResume === true) { const resume = button('Recover', 'secondary', () => { resume.disabled = true; send('resume-job', {id: job.id}); }); resume.dataset.jobAction = 'resume'; actions.append(resume); }
    const saved = library().find(item => item.id === job.id || item.jobId === job.id);
    if (saved) { const open = button('Open result', 'secondary', () => selectItem(saved.id)); open.dataset.jobAction = 'open'; actions.append(open); }
    row.append(visual, copy, actions); return row;
  }));
  if (focusId && focusAction) [...$('activity-list').querySelectorAll('[data-job-id]')].find(row => row.dataset.jobId === focusId)?.querySelector(`[data-job-action="${focusAction}"]`)?.focus({preventScroll: true});
}
function renderSettings() {
  const helper = state?.helper || {}, connected = helper.status === 'ready';
  $('connection-dot').className = 'status-dot ' + helper.status;
  text('connection-label', connected ? 'Local helper connected' : helper.status === 'checking' ? 'Connecting…' : 'Helper needs setup');
  text('save-directory', helper.directory || 'The save folder will appear when setup is complete.');
  $('save-folder').disabled = $('settings-folder').disabled = !connected;
  $('completion-sound').checked = state?.settings?.notifications !== false;
  $('tool-status').replaceChildren(node('strong', '', connected ? 'Ready for capture' : helper.status === 'checking' ? 'Checking local tools…' : 'Setup needs attention'), node('span', '', connected ? `Framekeep ${helper.version || state.workerVersion || ''}${helper.extractor ? ' · yt-dlp ' + helper.extractor : ''}` : helper.error || 'Run Install Framekeep.cmd, then check the connection.'));
  $('setup-help').hidden = connected;
  const study = state?.capabilities?.study;
  text('study-availability', study?.available ? 'The optional study adapter is connected. Available operations appear in each item’s Evidence tab.' : study?.reason || 'Optional study tools are not connected. Media capture, playback and source captions are available without them.');
  const app = state?.app || {}, version = app.version || state.workerVersion || helper.version || 'beta';
  text('sidebar-version', `Framekeep ${version}`);
  text('settings-version', `Framekeep ${version}`);
  text('settings-build', app.buildId ? `Build ${app.buildId.slice(0, 12)}` : 'Build receipt unavailable');
  text('app-install-directory', app.installDirectory || 'Unavailable outside the installed Desktop app');
  text('app-build-id', app.buildId || 'Unavailable');
  text('app-native-host', app.nativeHostName || 'Unavailable');
  text('app-extension-id', app.extensionId || 'Unavailable');
}
function captureChoices() {
  const info = state?.probe?.info; if (!info) return;
  const kind = $('capture-kind').value;
  const heights = (info.heights || []).filter(value => Number.isFinite(Number(value)));
  const choices = kind === 'audio' ? [['128', '128 kbps · smaller'], ['192', '192 kbps · balanced'], ['320', '320 kbps · highest']] : [['best', 'Best available'], ...heights.map(height => [String(height), `${height}p`])];
  const before = $('capture-quality').value;
  $('capture-quality').replaceChildren(...choices.map(([value, label]) => { const option = node('option', '', label); option.value = value; return option; }));
  const preferred = before || (kind === 'audio' ? state.settings?.audioQuality || '192' : state.settings?.quality || '1080');
  $('capture-quality').value = choices.some(([value]) => value === preferred) ? preferred : choices[0][0];
}
function openCapture() {
  captureRequested = true; error('');
  if (!$('capture-dialog').open) $('capture-dialog').showModal();
  $('capture-url').focus();
}
function renderCapture() {
  const probe = state?.probe || {status: 'idle'}, ready = probe.status === 'ready', loading = probe.status === 'loading';
  if (probe.status !== 'idle' && !captureRequested && probe.url) { captureRequested = true; $('capture-dialog').showModal(); }
  $('check-link').disabled = loading || pendingDownload || state?.helper?.status !== 'ready';
  text('check-link', loading ? 'Checking…' : 'Check link');
  $('capture-result').hidden = !ready;
  text('capture-message', probe.status === 'error' ? probe.error || 'This link could not be checked. Confirm the source is available and try again.' : loading ? 'Checking formats and source captions…' : ready ? '' : 'Paste a source link to check its available formats.');
  $('capture-message').hidden = ready;
  const key = JSON.stringify([probe.status, probe.url, probe.info]);
  if (key !== captureKey) {
    captureKey = key;
    if (probe.url && document.activeElement !== $('capture-url')) $('capture-url').value = probe.url;
    if (ready) {
      const info = probe.info || {}; text('capture-media-title', info.title || 'Source media'); text('capture-media-meta', [info.platform, info.channel, duration(info.duration)].filter(Boolean).join(' · '));
      const thumbnail = safeUrl(info.thumbnail); $('capture-thumbnail').hidden = !thumbnail; if (thumbnail) $('capture-thumbnail').src = thumbnail; else $('capture-thumbnail').removeAttribute('src');
      $('capture-kind').querySelector('option[value="video"]').disabled = info.audioOnly === true;
      if (info.audioOnly) $('capture-kind').value = 'audio'; captureChoices();
    }
  }
  $('start-download').disabled = !ready || pendingDownload || state?.helper?.status !== 'ready';
  text('start-download', pendingDownload ? 'Starting…' : 'Save to library ↓');
  if (pendingDownload && (state.jobs || []).some(job => !pendingJobIds.has(job.id))) {
    pendingDownload = false; $('capture-dialog').close(); setView('activity'); announce('Job started. Progress and the saved result appear here.');
  }
}
function render(next) {
  if (next.uiError) { pendingDownload = false; error(next.uiError); renderCapture(); if ($('capture-dialog').open) { text('capture-message', next.uiError); $('capture-message').hidden = false; } if (pendingCollection !== null) { text('collection-feedback', 'Collection was not saved. See the error above.'); pendingCollection = null; } return; }
  state = next;
  renderSettings(); renderCollections(); renderLibrary(); renderActivity(); renderCapture();
  if (selectedId && view === 'workspace') {
    const item = state.selectedItem?.id === selectedId ? state.selectedItem : library().find(entry => entry.id === selectedId);
    if (item) renderWorkspace(item);
    else { setView('library'); announce('This item is no longer in the library. Refresh or check the save folder.'); }
  }
}

for (const element of document.querySelectorAll('[data-view]')) element.onclick = () => setView(element.dataset.view);
document.querySelector('.brand').onclick = event => { event.preventDefault(); collection = ''; renderCollections(); setView('library'); };
for (const id of ['new-capture', 'empty-capture', 'activity-capture']) $(id).onclick = openCapture;
for (const id of ['refresh-library', 'refresh-activity', 'retry-helper']) $(id).onclick = () => send('check');
for (const id of ['save-folder', 'settings-folder']) $(id).onclick = () => send('folder');
$('empty-help').onclick = () => { setView('settings'); $('capture-help').scrollIntoView({block: 'start'}); };
$('dismiss-error').onclick = () => error('');
$('library-search').oninput = renderLibrary; $('sort-order').onchange = renderLibrary;
for (const filter of document.querySelectorAll('[data-kind]')) filter.onclick = () => { type = filter.dataset.kind; for (const peer of document.querySelectorAll('[data-kind]')) { const active = peer === filter; peer.classList.toggle('selected', active); peer.setAttribute('aria-pressed', String(active)); } renderLibrary(); };
$('reset-filters').onclick = () => { type = 'all'; collection = ''; $('library-search').value = ''; document.querySelector('[data-kind="all"]').click(); renderCollections(); };
$('back-library').onclick = () => setView('library');
$('open-item').onclick = () => send('open-item', {id: selectedId});
$('open-source').onclick = () => send('open-source', {id: selectedId});
$('collection-form').onsubmit = event => { event.preventDefault(); pendingCollection = $('item-collection').value.trim(); text('collection-feedback', 'Saving…'); send('organize-item', {id: selectedId, collection: pendingCollection}); };
$('load-captions').onclick = () => send('transcript', {id: selectedId});
$('caption-language').onchange = () => send('transcript', {id: selectedId, language: $('caption-language').value});
$('caption-search').oninput = () => renderCaptions(state?.selectedItem?.id === selectedId ? state.selectedItem : library().find(item => item.id === selectedId));
$('export-captions').onclick = () => send('export-transcript', {id: selectedId, timestamps: true});
$('completion-sound').onchange = () => send('settings', {notifications: $('completion-sound').checked});
function reviewTab(name, focus = false) {
  for (const tab of ['captions', 'evidence']) { const active = tab === name; $('review-' + tab).classList.toggle('selected', active); $('review-' + tab).setAttribute('aria-selected', String(active)); $('review-' + tab).tabIndex = active ? 0 : -1; $(tab + '-panel').hidden = !active; }
  if (focus) $('review-' + name).focus();
}
for (const name of ['captions', 'evidence']) {
  $('review-' + name).onclick = () => reviewTab(name);
  $('review-' + name).onkeydown = event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); reviewTab(event.key === 'Home' ? 'captions' : event.key === 'End' ? 'evidence' : name === 'captions' ? 'evidence' : 'captions', true); } };
}
$('prepare-study').onclick = () => { $('prepare-study').disabled = true; send('study-submit', {id: selectedId, recipe: $('study-operation').value}); announce('Evidence preparation requested. Check Activity for the job state.'); };
$('close-capture').onclick = () => $('capture-dialog').close();
$('capture-form').onsubmit = event => { event.preventDefault(); error(''); pendingDownload = false; send('analyze', {url: $('capture-url').value.trim()}); };
$('capture-kind').onchange = () => { $('capture-quality').value = ''; captureChoices(); };
$('capture-thumbnail').onerror = () => { $('capture-thumbnail').hidden = true; };
$('start-download').onclick = () => { pendingDownload = true; pendingJobIds = new Set((state?.jobs || []).map(job => job.id)); $('start-download').disabled = true; text('start-download', 'Starting…'); send('download', {kind: $('capture-kind').value, quality: $('capture-quality').value}); };
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !$('capture-dialog').open) { event.preventDefault(); setView('library', false); $('library-search').focus(); } if (event.key === 'Escape' && view === 'workspace' && !$('capture-dialog').open && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) setView('library'); });
port.onMessage.addListener(render);
port.onDisconnect.addListener(() => { error('The local app connection closed. Reopen Framekeep to reconnect. Saved files remain in your save folder.'); text('connection-label', 'Connection closed'); $('connection-dot').className = 'status-dot missing'; });
setView('library', false); send('init');
