import {createTransport} from './transport.js';
import {duration, formatBytes, transferView} from './shared.js';
import {icon as baseIcon} from './ui-icons.js';
import {mediaKind, timestamp, validTiming, transcriptTracks, activeCueIndex, orderedItems, playableItems, safeMediaUrl} from './desktop-model.js';

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
const safeUrl = safeMediaUrl;
const dateLabel = value => { const date = new Date(value || 0); return Number.isFinite(date.valueOf()) && date.getFullYear() > 1970 ? date.toLocaleDateString(undefined, {month: 'short', day: 'numeric'}) : ''; };
let state, view = 'library', type = 'all', collection = '', selectedId = null;
let libraryKey, activityKey, collectionsKey, workspaceKey, captionsKey, evidenceKey, captureKey;
let pendingSelectionId = null, pendingResultTab = null;
let selection = new Set(), visibleItems = [], libraryScroll = 0, selectedTrackId = '', followCue = true, queueIds = [], queueCollectionId = '', queueOmissions = '', playOnLoad = false, lastCue = -1, actionHandler = null, tourStep = 0, guideOffered = false;
let pendingDownload = false, pendingJobIds = new Set(), pendingCollection = null, toastTimer, captureRequested = false;

function announce(message, actionLabel, action) {
  text('toast', message); if(actionLabel&&action) $('toast').append(button(actionLabel,'toast-action',action)); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500);
}
function error(message) { text('error-message', message); $('error-banner').hidden = !message; }
function library() { return Array.isArray(state?.library) ? state.library : (state?.jobs || []).filter(job => job.status === 'complete' && !['missing', 'trashed'].includes(job.fileState)); }
function setView(next, focus = true) {
  if (view === 'workspace' && next !== 'workspace') $('media-stage').querySelectorAll('video,audio').forEach(media => media.pause());
  if (view === 'library' && next !== 'library') libraryScroll = $('main').scrollTop;
  if (next !== 'workspace') document.body.classList.remove('theater');
  view = next;
  for (const name of ['library', 'activity', 'settings', 'help', 'workspace']) $(name + '-view').hidden = name !== next;
  for (const name of ['library', 'activity', 'settings', 'help']) {
    const active = name === next || name === 'library' && next === 'workspace';
    $('nav-' + name).classList.toggle('selected', active);
    if (active) $('nav-' + name).setAttribute('aria-current', 'page'); else $('nav-' + name).removeAttribute('aria-current');
  }
  $('main').scrollTop = next === 'library' ? libraryScroll : 0;
  if (focus) $('main').focus({preventScroll: true});
  if (next === 'activity') send('acknowledge');
  if (next === 'library') renderLibrary();
}
function audioSymbol() { return icon('audio'); }
function currentCollection() { return (state?.collections || []).find(entry => entry.id === collection); }
function currentItem() { return state?.selectedItem?.id === selectedId ? state.selectedItem : library().find(item => item.id === selectedId); }
function modal(title, body, confirm, handler) {
  text('action-title', title); $('action-body').replaceChildren(body); text('confirm-action', confirm); $('confirm-action').hidden = !handler;
  actionHandler = handler; $('action-dialog').showModal();
  requestAnimationFrame(() => $('action-body').querySelector('input,select,button')?.focus());
}
function renameItem(item) {
  const box = node('div'), label = node('label', '', 'Display title'), input = node('input'); input.id = 'rename-title'; input.value = item.title || item.filename || ''; input.maxLength = 240; input.required = true; label.htmlFor = input.id;
  box.append(label, input, node('p', 'muted', 'The original filename and media file stay unchanged.'));
  modal('Rename item', box, 'Save name', () => { if (input.value.trim()) send('rename-item', {id: item.id, title: input.value.trim()}); }); input.select();
}
function editCollection(entry) {
  const box = node('div'), label = node('label', '', 'Collection name'), input = node('input'); input.id = 'collection-name'; input.value = entry?.name || ''; input.maxLength = 80; input.required = true; label.htmlFor = input.id; box.append(label, input);
  modal(entry ? 'Rename collection' : 'Create collection', box, entry ? 'Save name' : 'Create', () => send(entry ? 'collection-rename' : 'collection-create', {...(entry ? {id:entry.id} : {}), name: input.value.trim()}));
}
function organizeItems(ids) {
  const body = node('div', 'membership-list'), groups = state?.collections || [], inputs = [];
  body.append(node('p', 'muted', `${ids.length} selected item${ids.length === 1 ? '' : 's'}. Check to add all; uncheck to remove all. Mixed collections stay unchanged until selected.`));
  for (const group of groups) {
    const label = node('label', 'toggle-label'), input = node('input'); input.type = 'checkbox'; const count = ids.filter(id => group.itemIds.includes(id)).length; input.checked = count === ids.length; input.indeterminate = count > 0 && count < ids.length; input.dataset.changed = 'false'; input.onchange = () => {input.dataset.changed = 'true';}; label.append(input, node('span', '', group.name)); body.append(label); inputs.push([group,input]);
  }
  if (!groups.length) body.append(node('p', '', 'Create a collection using ＋ in the sidebar, then organize your items.'));
  modal('Organize items', body, 'Save memberships', () => { for (const [group,input] of inputs) if (input.dataset.changed === 'true') send('collection-membership', {collectionId:group.id,itemIds:ids,remove:!input.checked}); });
}
function confirmRemoval(item, disk) {
  const message = node('p', '', disk ? 'Move this original file to the Windows Recycle Bin? You can restore it from the Recycle Bin. Other collection items stay in place.' : 'Remove this item from Framekeep Library? The original file stays on disk.');
  modal(disk ? 'Move file to Recycle Bin?' : 'Remove from library?', message, disk ? 'Move to Recycle Bin' : 'Remove from library', () => { send(disk ? 'trash-item' : 'remove-item', {id:item.id,...(disk ? {confirmed:true} : {})}); selection.delete(item.id); if(!disk)announce('Library removal requested. The original file stays on disk.','Undo',()=>{send('restore-item',{id:item.id});announce('Restoring library item…');}); if (selectedId === item.id) setView('library'); });
}
function itemMenu(item) {
  const body = node('div', 'action-menu');
  const act = (label, action, disabled=false) => { const control = button(label, 'menu-action', () => { $('action-dialog').close(); action(); }); control.disabled = disabled; body.append(control); };
  act('Rename display title', () => renameItem(item)); act('Add or remove collections', () => organizeItems([item.id]));
  act('Open file', () => send('open-item',{id:item.id}), item.fileState === 'missing'); act('Open source', () => send('open-source',{id:item.id}), !item.sourceUrl); act('Open containing folder', () => send('open-folder',{id:item.id}));
  if (collection) act('Remove from this collection', () => send('collection-membership',{collectionId:collection,itemIds:[item.id],remove:true}));
  body.append(node('hr')); act('Remove from library…', () => confirmRemoval(item,false)); act('Move file to Recycle Bin…', () => confirmRemoval(item,true));
  modal(item.title || 'Item actions', body, '', null);
}
function collectionMenu(entry) {
  const body = node('div','action-menu');
  body.append(button('Rename collection','menu-action',() => {$('action-dialog').close(); editCollection(entry);}),button('Delete collection…','menu-action',() => {$('action-dialog').close(); modal('Delete collection?',node('p','',`Delete “${entry.name}”? Its media files and library items will be kept.`),'Delete collection',() => {send('collection-delete',{id:entry.id}); if(collection === entry.id) {collection='';setView('library');}});}));
  modal(entry.name,body,'',null);
}
function renderCollections() {
  const groups = state?.collections || [];
  const key = JSON.stringify([groups, collection]); if (key === collectionsKey) return; collectionsKey = key;
  $('collection-hint').hidden = groups.length > 0;
  $('collections').replaceChildren(...groups.map(group => {
    const row = node('div','collection-row');
    const entry = button('', 'collection-nav' + (collection === group.id ? ' selected' : ''), () => { collection = collection === group.id ? '' : group.id; $('sort-order').value = collection ? 'collection' : 'recent'; libraryScroll=0; setView('library'); renderCollections(); });
    entry.append(node('span','',group.name)); entry.setAttribute('aria-pressed',String(collection === group.id)); entry.title=group.name;
    const menu=button('⋯','icon-button collection-menu',()=>collectionMenu(group)); menu.setAttribute('aria-label',`Actions for ${group.name}`); row.oncontextmenu=event=>{event.preventDefault();collectionMenu(group);}; row.append(entry,menu);return row;
  }));
  $('collection-options').replaceChildren(...groups.map(group => {const option=node('option');option.value=group.name;return option;}));
}
function renderSelection() {
  text('selection-count',selection.size ? `${selection.size} selected` : ''); $('organize-selection').hidden=$('clear-selection').hidden=!selection.size;
  for(const card of $('library-grid').children) {const checked=selection.has(card.dataset.itemId);card.classList.toggle('is-selected',checked);card.querySelector('input[type=checkbox]').checked=checked;}
}
function previewFor(item, className = 'card-preview') {
  const kind=mediaKind(item), preview=node('div',className+' '+kind), thumbnail=safeUrl(item.thumbnailUrl || item.artworkUrl), url=safeUrl(item.previewUrl);
  if(thumbnail || kind === 'image' && url) {const img=node('img');img.src=thumbnail || url;img.alt='';img.loading='lazy';img.referrerPolicy='no-referrer';img.onerror=()=>{img.remove();preview.prepend(icon(kind));};preview.append(img);}
  else if(kind === 'video' && url) {const video=node('video');video.src=url;video.preload='metadata';video.muted=true;video.playsInline=true;video.tabIndex=-1;video.setAttribute('aria-hidden','true');video.onloadedmetadata=()=>{if(video.duration>.2)video.currentTime=.2;};video.onerror=()=>{video.remove();preview.prepend(icon('video'));};preview.append(video);}
  else preview.append(icon(kind === 'unknown' ? 'folder' : kind));
  return preview;
}
function renderLibrary() {
  if(!state)return;
  const query=$('library-search').value.trim().toLocaleLowerCase(), all=library(), group=currentCollection();
  const items=orderedItems(all,group,$('sort-order').value).filter(item=>(type==='all'||mediaKind(item)===type)&&(!query||[item.title,item.filename,item.sourceUrl].filter(Boolean).join(' ').toLocaleLowerCase().includes(query))); visibleItems=items;
  text('library-title',group?.name || 'Library');text('library-subtitle',group ? 'Your collection · media files stay in Library when removed from this collection.' : 'A place for things worth coming back to.'); text('visible-count',`${items.length} item${items.length===1?'':'s'}`);
  $('library-loading').hidden=true;$('library-empty').hidden=all.length>0||Boolean(group);$('library-no-results').hidden=items.length>0||(!all.length&&!group);$('library-grid').hidden=!items.length;
  $('play-collection').hidden=!group||!playableItems(orderedItems(all,group,'collection')).some(item=>mediaKind(item)==='video');$('select-all').hidden=!items.length;
  const key=JSON.stringify([items,collection,$('sort-order').value]); if(key===libraryKey){renderSelection();return;}libraryKey=key;
  $('library-grid').replaceChildren(...items.map(item=>{
    const kind=mediaKind(item), card=node('article','media-card');card.dataset.itemId=item.id;card.tabIndex=0;card.setAttribute('aria-label',`${item.title||item.filename}, ${kind}`);
    const open=button('','card-open',()=>selectItem(item.id));open.setAttribute('aria-label',`Open ${item.title||item.filename}`);const preview=previewFor(item);preview.append(node('span','card-kind',kind));if(Number.isFinite(item.duration))preview.append(node('span','card-duration',timestamp(item.duration)));open.append(preview);
    const copy=node('div','card-copy'), title=node('h2','card-title',item.title||item.filename||'Saved media');title.title='Double-click to rename';title.tabIndex=0;title.ondblclick=()=>renameItem(item);title.onkeydown=event=>{if(event.key==='F2'){event.preventDefault();event.stopPropagation();renameItem(item);}};
    const meta=node('p','card-subtitle');meta.append(node('span','',sourceHost(item.sourceUrl)||formatBytes(item.bytes)||'Saved locally'),node('span','',dateLabel(item.finished||item.created)));copy.append(title,meta);
    if(group&&$('sort-order').value==='collection'){const order=node('div','card-order');for(const [label,delta] of [['↑',-1],['↓',1]]){const move=button(label,'text-button',()=>moveCollectionItem(group,item.id,delta));move.setAttribute('aria-label',`Move ${item.title||item.filename} ${delta<0?'earlier':'later'} in collection`);const at=group.itemIds.indexOf(item.id);move.disabled=at+delta<0||at+delta>=group.itemIds.length;order.append(move);}copy.append(order);}
    const controls=node('div','card-controls'), choose=node('input');choose.type='checkbox';choose.setAttribute('aria-label',`Select ${item.title||item.filename}`);choose.onchange=()=>{choose.checked?selection.add(item.id):selection.delete(item.id);renderSelection();};
    const menu=button('⋯','icon-button',()=>itemMenu(item));menu.setAttribute('aria-label',`Actions for ${item.title||item.filename}`);controls.append(choose,button('Open','text-button',()=>selectItem(item.id)),menu);copy.append(controls);card.append(open,copy);
    card.oncontextmenu=event=>{event.preventDefault();itemMenu(item);};card.onkeydown=event=>{if(event.target!==card)return;if(event.key==='F2'){event.preventDefault();renameItem(item);}if(event.key==='Enter'){selectItem(item.id);}if(event.key===' '){event.preventDefault();selection.has(item.id)?selection.delete(item.id):selection.add(item.id);renderSelection();}};return card;
  }));renderSelection();
}
function moveCollectionItem(group,id,delta){const ids=[...group.itemIds],from=ids.indexOf(id),to=from+delta;if(from<0||to<0||to>=ids.length)return;ids.splice(from,1);ids.splice(to,0,id);send('collection-reorder',{id:group.id,itemIds:ids});}
function selectItem(id, resultTab = null) {
  pendingResultTab=resultTab;
  selectedTrackId = ''; followCue = true; lastCue = -1; reviewTab('captions');
  selectedId = id; pendingSelectionId=id; workspaceKey = captionsKey = evidenceKey = null;
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
  if (document.activeElement !== $('item-collection')) $('item-collection').value = (state.collections||[]).filter(group=>group.itemIds.includes(item.id)).map(group=>group.name).join(', ');
  if (pendingCollection !== null && item.collection === pendingCollection) { text('collection-feedback', item.collection ? `Saved to ${item.collection}.` : 'Removed from collection.'); pendingCollection = null; }
  $('image-zoom').hidden = mediaKind(item)!=='image';
  $('theater-mode').hidden = !['audio','video'].includes(mediaKind(item)); $('fullscreen-media').hidden = mediaKind(item) !== 'video';
  text('theater-mode', document.body.classList.contains('theater') ? 'Exit theater' : 'Theater');
  $('theater-mode').setAttribute('aria-pressed',String(document.body.classList.contains('theater')));
  const key = JSON.stringify([item.id, item.previewUrl, item.kind]);
  if (key !== workspaceKey) {
    workspaceKey = key; $('preview-error').hidden = true;
    const kind = mediaKind(item), url = safeUrl(item.previewUrl);
    $('media-stage').replaceChildren();
    if (url && kind !== 'unknown') {
      const media = node(kind === 'image' ? 'img' : kind); media.src = url;
      if (kind === 'image') { media.alt = item.title || item.filename || 'Saved image'; media.tabIndex=0; media.title='Click or press Enter to zoom'; const zoom=()=>{media.classList.toggle('zoomed');text('image-zoom',media.classList.contains('zoomed')?'Fit image':'Zoom image');}; media.onclick=zoom; media.onkeydown=e=>{if(e.key==='Enter')zoom();}; }
      else { media.controls = true; media.preload = 'metadata'; media.setAttribute('aria-label', `${kind === 'video' ? 'Video' : 'Audio'} player for ${item.title || item.filename}`); }
      media.onerror = () => { $('preview-error').hidden = false; };
      if (kind === 'audio') { const art = node('div', 'audio-stage'), artwork=safeUrl(item.artworkUrl||item.thumbnailUrl); if(artwork){const cover=node('img');cover.src=artwork;cover.alt='Audio artwork';cover.className='audio-artwork';cover.onerror=()=>cover.replaceWith(audioSymbol());art.append(cover);}else art.append(audioSymbol()); art.append(node('p', '', 'Original audio')); $('media-stage').append(art); }
      $('media-stage').append(media);
      if(kind !== 'image') {media.ontimeupdate=updateCurrentCue;media.onended=onMediaEnded;media.onloadedmetadata=()=>{if(playOnLoad){playOnLoad=false;media.play().catch(()=>announce('Press Play to start this item.'));}};}
    } else { const placeholder = node('div', 'preview-placeholder'); placeholder.append(icon(kind), node('p', '', 'Preview is unavailable for this file. Open it with your Windows app.')); $('media-stage').append(placeholder); }
  }
  renderCaptions(item); renderEvidence(item); renderFrames(item); renderQueue();
  if(pendingResultTab&&pendingSelectionId!==item.id){const processing=state?.study?.sourceItemId===item.id?state.study:item.study;if(pendingResultTab==='frames'&&$('review-frames').hidden&&processing?.status==='loading'){reviewTab('evidence');}else{const target=pendingResultTab==='frames'&&$('review-frames').hidden?'evidence':pendingResultTab;reviewTab(target);if(target==='evidence')$('processing-details').open=true;pendingResultTab=null;}}
  const transcriptApplicable=['audio','video'].includes(mediaKind(item))&&item.capabilities?.hasAudio!==false;
  $('review-captions').hidden=!transcriptApplicable;
  if(!transcriptApplicable&&$('review-captions').getAttribute('aria-selected')==='true')reviewTab($('review-frames').hidden?'evidence':'frames');
  document.querySelector('.review-panel').hidden=['image','unknown'].includes(mediaKind(item))&&!item.artifacts?.length&&$('review-frames').hidden;
  document.querySelector('.workspace-layout').classList.toggle('preview-only',document.querySelector('.review-panel').hidden);
}
function selectedTranscript(item) {
  const tracks=transcriptTracks(item);
  return tracks.find(track=>track.id===selectedTrackId)||tracks.find(track=>track.id===item?.transcript?.id)||tracks.find(track=>['generated-transcription','generated','generated-live','browser-live'].includes(track.source))||tracks[0]||item?.transcript||{status:'idle'};
}
function renderCaptions(item) {
  if(!item)return;
  if(pendingSelectionId===item.id){$('transcript-generation').hidden=true;$('caption-tools').hidden=true;$('load-captions').hidden=true;$('caption-cues').replaceChildren();$('caption-message').hidden=false;text('caption-message','Loading saved transcripts…');captionsKey=null;return;}
  const transcript=selectedTranscript(item), tracks=transcriptTracks(item), ready=Boolean(transcript.cues?.length||transcript.text), study=(state?.study?.sourceItemId===item.id?state.study:item.study)||{};
  const running=['loading','running','queued','starting'].includes(study.status)||['planned','submitted','queued','running'].includes(study.state);
  const hasGenerated=tracks.some(track=>['generated-transcription','generated','generated-live','browser-live'].includes(track.source));
  const compactTranscript=hasGenerated&&!running&&!study.canResume;
  $('transcript-generation').hidden=compactTranscript;
  if(compactTranscript){$('transcript-secondary').append($('generation-status'),$('load-captions'));}
  else {$('transcript-generation').append($('generation-status'));$('captions-panel').insertBefore($('load-captions'),$('caption-tools'));}
  $('media-stage').classList.toggle('audio-media-stage',mediaKind(item)==='audio');
  $('generate-transcript').hidden=hasGenerated||!['audio','video'].includes(mediaKind(item))||item.capabilities?.hasAudio===false;
  $('generate-transcript').disabled=running||item.capabilities?.speech!==true;
  $('transcription-setup').hidden=hasGenerated||running||$('generate-transcript').hidden||item.capabilities?.speech===true;
  $('cancel-transcript').hidden=!running||study.canCancel!==true;$('retry-transcript').hidden=!study.canResume;
  text('generation-status',running ? (study.canCancel===false ? 'Generating on this computer. This processor does not support cancellation; you can keep using Library.' : 'Generating on this computer…') : study.error || item.transcriptError || (hasGenerated ? 'Generated text may contain errors. Original outputs and review status are in Processing details.' : '') || (!hasGenerated && ['audio','video'].includes(mediaKind(item)) ? item.capabilities?.speech ? 'Uses the installed local speech engine. Existing results are reused.' : item.capabilities?.reason || 'Local transcription is unavailable. See Settings for connection and setup help.' : ''));
  const key=JSON.stringify([item.id,transcript,tracks,$('caption-search').value]);if(key===captionsKey)return;captionsKey=key;
  const labels={'source-captions':'Source captions','sidecar-captions':'Imported captions','generated-transcription':'Generated transcript','generated':'Generated transcript','imported':'Imported transcript','browser-live':'Live capture','generated-live':'Generated live transcript'};
  const origin=labels[transcript.source]||transcript.source||'Transcript', coverage=typeof transcript.coverage==='string'?transcript.coverage:transcript.coverage?.description || (transcript.sourceTiming===false?'Captured audio only · not a complete original-site timeline':'');
  text('caption-provenance',ready?[origin,transcript.language&&transcript.language!=='und'?transcript.language:'Language unspecified',coverage].filter(Boolean).join(' · '):'Source captions, imported captions and generated text appear here as separate tracks.');
  text('caption-message',ready?'':transcript.status==='loading'?'Loading transcript…':transcript.error||(['image','unknown'].includes(mediaKind(item))?'This item has no audio transcript.':'No transcript is available yet. Check source captions or generate one when local speech is available.'));
  $('caption-message').hidden=ready;$('load-captions').hidden=!item.sourceUrl||['image','unknown'].includes(mediaKind(item))||transcript.status==='loading';$('caption-tools').hidden=!ready;
  $('caption-language').replaceChildren(...tracks.map(track=>{const option=node('option','',[labels[track.source]||track.source||'Transcript',track.language&&track.language!=='und'?track.language:'Language unspecified',track.label].filter(Boolean).join(' · '));option.value=track.id;return option;}));$('caption-language').value=transcript.id||'';$('caption-language').disabled=tracks.length<2;
  const cues=transcript.cues?.length?transcript.cues:[{text:transcript.text||''}], query=$('caption-search').value.trim().toLocaleLowerCase(), matches=cues.map((cue,index)=>({cue,index})).filter(({cue})=>!query||String(cue.text||'').toLocaleLowerCase().includes(query));
  const timed=cues.length>0&&cues.every(validTiming)&&transcript.timed!==false;
  for(const option of $('export-format').options)option.disabled=option.value!=='txt'&&!timed;
  if(!timed)$('export-format').value='txt';$('export-format').title=timed?'Export timed or plain text':'Timed export needs original, valid start and end timestamps.';
  text('caption-count',`${matches.length} ${query?'matches':'segments'}`);
  $('caption-cues').replaceChildren(...matches.map(({cue,index})=>{
    const row=node('div','caption-cue');row.dataset.cueIndex=index;
    const timing=validTiming(cue)&&transcript.timed!==false;
    const stamp=button(timing?timestamp(cue.start):'—','cue-time',()=>{const media=$('media-stage').querySelector('video,audio');if(media){media.currentTime=cue.start;followCue=true;$('follow-cue').hidden=true;updateCurrentCue();}});stamp.disabled=!timing||!item.previewUrl;stamp.setAttribute('aria-label',timing?`Seek to ${timestamp(cue.start)}`:'No source timestamp');
    const copy=node('p'), value=String(cue.text||'');if(query){let offset=0,index;const lower=value.toLocaleLowerCase();while((index=lower.indexOf(query,offset))>=0){copy.append(document.createTextNode(value.slice(offset,index)),node('mark','',value.slice(index,index+query.length)));offset=index+query.length;}copy.append(document.createTextNode(value.slice(offset)));}else copy.textContent=value;
    row.append(stamp,copy);return row;
  }));
  if(ready&&!matches.length)$('caption-cues').append(node('p','caption-no-match','No transcript segments match this search.'));
  lastCue=-1;updateCurrentCue();
}
function updateCurrentCue() {
  const media=$('media-stage').querySelector('video,audio'),track=selectedTranscript(currentItem());if(!media||track.timed===false)return;
  const index=activeCueIndex(track.cues||[],media.currentTime);if(index===lastCue)return;lastCue=index;
  for(const row of $('caption-cues').children){const active=Number(row.dataset.cueIndex)===index;row.classList.toggle('current-cue',active);if(active){row.setAttribute('aria-current','true');if(followCue)row.scrollIntoView({block:'nearest',behavior:'instant'});}else row.removeAttribute('aria-current');}
}
function pauseFollowing() {followCue=false;$('follow-cue').hidden=false;}
function renderQueue() {
  const container=$('playback-queue');container.hidden=!queueIds.length;if(!queueIds.length)return;
  const items=queueIds.map(id=>library().find(item=>item.id===id)), index=queueIds.indexOf(selectedId),head=node('div','queue-heading');
  head.append(node('strong','',`Collection queue · ${index+1} / ${queueIds.length}`),button('Previous','text-button',()=>advanceQueue(-1)),button('Next','text-button',()=>advanceQueue(1)));head.children[1].disabled=index<=0&&state.settings?.repeat!=='all';head.children[2].disabled=index===queueIds.length-1&&state.settings?.repeat!=='all';
  const list=node('ol','queue-list');items.forEach((item,pos)=>{const row=node('li',item?.id===selectedId?'current':'');const open=button(item?.title||item?.filename||'Missing file','queue-item',()=>{if(item){playOnLoad=true;selectItem(item.id);}});open.disabled=!item||item.fileState==='missing';row.append(open);for(const [label,delta]of [['↑',-1],['↓',1]]){const move=button(label,'text-button',()=>moveQueue(pos,pos+delta));move.disabled=pos+delta<0||pos+delta>=items.length;move.setAttribute('aria-label',`Move ${item?.title||'item'} ${delta<0?'earlier':'later'}`);row.append(move);}row.draggable=true;row.ondragstart=event=>event.dataTransfer.setData('text/plain',String(pos));row.ondragover=event=>event.preventDefault();row.ondrop=event=>{event.preventDefault();const from=Number(event.dataTransfer.getData('text/plain'));if(Number.isInteger(from))moveQueue(from,pos);};list.append(row);});
  const preference=node('label','toggle-label'),toggle=node('input');toggle.type='checkbox';toggle.checked=state.settings?.autoplayNext===true;toggle.onchange=()=>send('settings',{autoplayNext:toggle.checked});preference.append(toggle,node('span','','Autoplay next'));container.replaceChildren(head,list,preference);if(queueOmissions)container.append(node('p','muted',queueOmissions));
}
function moveQueue(from,to){if(from<0||to<0||from>=queueIds.length||to>=queueIds.length)return;const [id]=queueIds.splice(from,1);queueIds.splice(to,0,id);const group=(state.collections||[]).find(entry=>entry.id===queueCollectionId);if(group){let next=0;const ordered=group.itemIds.map(id=>queueIds.includes(id)?queueIds[next++]:id);send('collection-reorder',{id:group.id,itemIds:ordered});}renderQueue();}
function advanceQueue(delta,autoplay=true){let index=queueIds.indexOf(selectedId)+delta;if(state.settings?.repeat==='all')index=(index+queueIds.length)%queueIds.length;const item=library().find(entry=>entry.id===queueIds[index]);if(item&&playableItems([item]).length){playOnLoad=autoplay;selectItem(item.id);}else if(index>=0&&index<queueIds.length)announce('This queued file is missing or cannot play. Choose another item.');}
function onMediaEnded(){const media=$('media-stage').querySelector('video,audio');if(state.settings?.repeat==='one'){media.currentTime=0;media.play().catch(()=>{});}else if(state.settings?.autoplayNext)advanceQueue(1);}
function renderFrames(item) {
  const study=state?.study?.sourceItemId===item.id?state.study:item.study;
  const frames=(item.frames||study?.frames||[]).filter(frame=>safeUrl(frame.previewUrl));
  $('review-frames').hidden=!frames.length;
  const running=['loading','running','queued'].includes(study?.status)||['planned','submitted','queued','running'].includes(study?.state);
  $('generate-frames').hidden=!item.capabilities?.visual||frames.length>0;$('generate-frames').disabled=running;
  text('frame-generation-status',item.capabilities?.visual&&running?'Processing locally. Available frames will appear beside playback.':'');
  if(!frames.length){if($('review-frames').getAttribute('aria-selected')==='true')reviewTab('captions');$('frames-list').replaceChildren();return;}
  const key=JSON.stringify(frames);if($('frames-list').dataset.key===key)return;$('frames-list').dataset.key=key;
  $('frames-list').replaceChildren(...frames.map((frame,index)=>{const figure=node('figure','frame-result'),img=node('img');img.src=safeUrl(frame.previewUrl);img.alt=`Saved frame ${index+1}`;img.loading='lazy';const zoom=button('','frame-preview',()=>{const large=node('img','frame-zoom');large.src=img.src;large.alt=img.alt;modal(`Frame ${index+1}`,large,'',null);});zoom.setAttribute('aria-label',`Enlarge frame ${index+1}`);zoom.append(img);figure.append(zoom);const time=timestamp(frame.time);if(time){const seek=button(`Seek to ${time}`,'text-button',()=>{const media=$('media-stage').querySelector('video');if(media)media.currentTime=frame.time;});seek.disabled=!$('media-stage').querySelector('video');figure.append(seek);}else figure.append(node('figcaption','muted',`Frame ${index+1} · timestamp unavailable`));return figure;}));
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
  $('study-actions').hidden = !capability.available || !item.capabilities?.visual;
  if (capability.available) {
    const allowed = item.capabilities?.visual ? ['visual'] : [];
    $('study-actions').hidden = !allowed.length;
    const names = {visual: 'Visual evidence', speech: 'Speech and transcript', general: 'General study'};
    const existing = $('study-operation').value;
    $('study-operation').replaceChildren(...allowed.map(recipe => { const option = node('option', '', names[recipe]); option.value = recipe; return option; }));
    if (existing) $('study-operation').value = existing; else $('study-operation').value = mediaKind(item) === 'audio' ? 'speech' : 'visual';
    $('prepare-study').disabled = ['loading', 'running', 'queued'].includes(study.status);
  }
}
function activityResultTarget(job,item) {
  // A recipe is trusted only when attached by the same durable job ID.
  const attached=item.study?.jobId===job.id||item.study?.jobId===job.studyJobId?item.study:null;
  const recipe=job.recipe||attached?.recipe;
  if(recipe==='visual'||item.frames?.length&&item.capabilities?.hasAudio===false)return {label:'Open frames',tab:'frames'};
  if(recipe==='speech'||job.action==='live-transcript'||transcriptTracks(item).length)return {label:'Open transcript',tab:'captions'};
  if(item.frames?.length)return {label:'Open frames',tab:'frames'};
  return {label:'Open result',tab:'evidence'};
}
function renderActivity() {
  const jobs = state?.jobs || [], active = jobs.filter(job => RUNNING.has(job.status));
  text('activity-count', active.length); $('activity-count').hidden = !active.length;
  $('activity-empty').hidden = !!jobs.length;
  const key = JSON.stringify([jobs,library()]); if (key === activityKey) return; activityKey = key;
  const focusId = document.activeElement?.closest('[data-job-id]')?.dataset.jobId;
  const focusAction = document.activeElement?.dataset.jobAction;
  const expanded = new Set([...$('activity-list').querySelectorAll('[data-job-id]:has(details[open])')].map(row => row.dataset.jobId));
  $('activity-list').replaceChildren(...jobs.map(job => {
    const row = node('article', 'activity-card'); row.dataset.jobId = job.id;
    const sourceItem = library().find(item => item.id === job.sourceItemId);
    const visual = previewFor(sourceItem || {...job,kind:job.sourceKind||job.kind,previewUrl:job.sourcePreviewUrl||job.previewUrl}, 'activity-icon'); const copy = node('div', 'activity-copy');
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
    if(!sourceItem&&job.sourceItemId){const unavailable=button('Open media','secondary',()=>{});unavailable.disabled=true;unavailable.title=job.sourceUnavailableReason||'The source media is no longer in Library.';actions.append(unavailable);copy.append(node('p','activity-detail',unavailable.title));}
    if (sourceItem) { const openSource=button('Open media','secondary',()=>selectItem(sourceItem.id));openSource.dataset.jobAction='source';actions.append(openSource); if(job.action==='study'||job.studyJobId||job.sourceItemId) {const target=activityResultTarget(job,sourceItem),openResult=button(target.label,'secondary',()=>selectItem(sourceItem.id,target.tab));openResult.dataset.jobAction='result';actions.append(openResult);} }
    const saved = library().find(item => item.id === job.id || item.jobId === job.id);
    if (saved && !sourceItem) { const open = button('Open result', 'secondary', () => selectItem(saved.id)); open.dataset.jobAction = 'open'; actions.append(open); }
    row.append(visual, copy, actions); return row;
  }));
  if (focusId && focusAction) [...$('activity-list').querySelectorAll('[data-job-id]')].find(row => row.dataset.jobId === focusId)?.querySelector(`[data-job-action="${focusAction}"]`)?.focus({preventScroll: true});
}
function renderSettings() {
  const helper = state?.helper || {}, connected = helper.status === 'ready';
  $('connection-dot').className = 'status-dot ' + helper.status;
  text('connection-label', connected ? 'Local component connected' : helper.status === 'checking' ? 'Connecting…' : 'Check local connection');
  text('save-directory', helper.directory || 'The save folder will appear when setup is complete.');
  $('save-folder').disabled = $('settings-folder').disabled = !connected;
  $('completion-sound').checked = state?.settings?.notifications !== false;
  $('tool-status').replaceChildren(node('strong', '', connected ? 'Ready for capture' : helper.status === 'checking' ? 'Checking local tools…' : 'Setup needs attention'), node('span', '', connected ? `Framekeep ${helper.version || state.workerVersion || ''}${helper.extractor ? ' · yt-dlp ' + helper.extractor : ''}` : helper.error || 'Run Install Framekeep.cmd, then check the connection.'));
  $('setup-help').hidden = connected;
  const study = state?.capabilities?.study;
  text('study-availability', study?.available ? 'Local processing is connected. Available transcript and frame actions appear with each compatible item.' : study?.reason || 'Optional study tools are not connected. Media capture, playback and source captions are available without them.');
  applyPreferences();
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
  if (next.uiError) { pendingSelectionId=null; if(view==='workspace')renderCaptions(currentItem()); pendingDownload = false; error(next.uiError); renderCapture(); if ($('capture-dialog').open) { text('capture-message', next.uiError); $('capture-message').hidden = false; } if (pendingCollection !== null) { text('collection-feedback', 'Collection was not saved. See the error above.'); pendingCollection = null; } return; }
  state = next;
  if(state.selectedItem?.id===pendingSelectionId)pendingSelectionId=null;
  const availableIds=new Set(library().map(item=>item.id));selection=new Set([...selection].filter(id=>availableIds.has(id)));
  renderSettings(); renderCollections(); renderLibrary(); renderActivity(); renderCapture(); offerGuide();
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
$('empty-help').onclick = () => setView('help');
$('dismiss-error').onclick = () => error('');
$('library-search').oninput = renderLibrary; $('sort-order').onchange = renderLibrary;
for (const filter of document.querySelectorAll('[data-kind]')) filter.onclick = () => { type = filter.dataset.kind; for (const peer of document.querySelectorAll('[data-kind]')) { const active = peer === filter; peer.classList.toggle('selected', active); peer.setAttribute('aria-pressed', String(active)); } renderLibrary(); };
$('reset-filters').onclick = () => { type = 'all'; collection = ''; $('library-search').value = ''; document.querySelector('[data-kind="all"]').click(); renderCollections(); };
$('back-library').onclick = () => setView('library');
$('open-item').onclick = () => send('open-item', {id: selectedId});
$('open-source').onclick = () => send('open-source', {id: selectedId});
$('collection-form').onsubmit = event => { event.preventDefault(); organizeItems([selectedId]); };
$('load-captions').onclick = () => send('transcript', {id: selectedId});
$('caption-language').onchange = () => {selectedTrackId=$('caption-language').value;send('transcript-select',{id:selectedId,trackId:selectedTrackId});captionsKey=null;renderCaptions(currentItem());};
$('caption-search').oninput = () => renderCaptions(state?.selectedItem?.id === selectedId ? state.selectedItem : library().find(item => item.id === selectedId));
$('export-captions').onclick = () => send('export-transcript', {id: selectedId, trackId:selectedTranscript(currentItem()).id, format:$('export-format').value, timestamps:true});
$('copy-captions').onclick=()=>send('copy-transcript',{id:selectedId,trackId:selectedTranscript(currentItem()).id,format:'txt',timestamps:true});
$('completion-sound').onchange = () => send('settings', {notifications: $('completion-sound').checked});
function reviewTab(name, focus = false) {
  for (const tab of ['captions', 'frames', 'evidence']) { const active = tab === name; $('review-' + tab).classList.toggle('selected', active); $('review-' + tab).setAttribute('aria-selected', String(active)); $('review-' + tab).tabIndex = active ? 0 : -1; $(tab + '-panel').hidden = !active; }
  if (focus) $('review-' + name).focus();
}
for (const name of ['captions', 'frames', 'evidence']) {
  $('review-' + name).onclick = () => reviewTab(name);
  $('review-' + name).onkeydown = event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault();const tabs=['captions','frames','evidence'].filter(tab=>!$('review-'+tab).hidden),index=tabs.indexOf(name);reviewTab(event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs[(index+(event.key==='ArrowLeft'?-1:1)+tabs.length)%tabs.length],true); } };
}
$('prepare-study').onclick = () => { $('prepare-study').disabled = true; send('study-submit', {id: selectedId, recipe: $('study-operation').value}); announce('Evidence preparation requested. Check Activity for the job state.'); };
$('close-capture').onclick = () => $('capture-dialog').close();
$('capture-form').onsubmit = event => { event.preventDefault(); error(''); pendingDownload = false; send('analyze', {url: $('capture-url').value.trim()}); };
$('capture-kind').onchange = () => { $('capture-quality').value = ''; captureChoices(); };
$('capture-thumbnail').onerror = () => { $('capture-thumbnail').hidden = true; };
$('start-download').onclick = () => { pendingDownload = true; pendingJobIds = new Set((state?.jobs || []).map(job => job.id)); $('start-download').disabled = true; text('start-download', 'Starting…'); send('download', {kind: $('capture-kind').value, quality: $('capture-quality').value}); };
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !$('capture-dialog').open) { event.preventDefault(); setView('library', false); $('library-search').focus(); } if (event.key === 'Escape' && view === 'workspace' && !document.querySelector('dialog[open]') && !document.fullscreenElement && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) setView('library'); });
function applyPreferences() {
  const prefs=state?.settings||{},appearance=prefs.appearance||'system';
  document.documentElement.dataset.theme=appearance==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):appearance;
  document.documentElement.style.setProperty('--transcript-size',`${prefs.transcriptTextSize||16}px`);
  $('appearance').value=appearance;$('text-size').value=$('reading-size').value=String(prefs.transcriptTextSize||16);$('autoplay-next').checked=prefs.autoplayNext===true;$('repeat-mode').value=prefs.repeat||'none';
}
const guide=[
  ['A home for media worth keeping','Save a video or audio link here, or capture page media with the Framekeep toolbar in Chrome. Already have a file? Open your save folder, add it, then Refresh Library.','No capture, recording or permission is required to finish this guide.'],
  ['Make room for your collections','Create even an empty collection with ＋. Select several library items and use Organize selected. Ellipsis menus hold rename, source and removal actions.','Deleting a collection keeps your original media. Double-click a title or use F2 to rename its display name.'],
  ['Read while you listen','Open an item to find Transcript beside the player. Pick a source, imported or generated track; search, seek and export from the same place.','Generating text is optional and uses the installed local speech engine. Original tracks are kept.'],
  ['Connected to your browser','The installed Framekeep component connects Chrome to local saving and processing. Pin the extension to restore its bubble, manage visibility or start supported transcription.','Setup or model downloads are optional. Settings explains connection health; Help keeps these instructions available.']
];
function showTour(){const [title,copy,note]=guide[tourStep];text('tour-step',`QUICK TOUR · ${tourStep+1} OF ${guide.length}`);text('tour-title',title);text('tour-copy',copy);text('tour-note',note);$('back-tour').disabled=tourStep===0;text('next-tour',tourStep===guide.length-1?'Finish':'Next');if(!$('tour-dialog').open)$('tour-dialog').showModal();}
function finishTour(skipped){send('settings',{tourState:skipped?'skipped':'complete',controlsIntroSeen:true});$('tour-dialog').close();}
function offerGuide(){if(guideOffered||!state)return;guideOffered=true;if(!state.settings?.tourState||state.settings.tourState==='new'){tourStep=0;showTour();}else if(!state.settings.controlsIntroSeen){const body=node('p','','Transcript now sits beside playback. Use ＋ to create collections and each item’s ellipsis for actions. Settings and Help live at the bottom of the sidebar.');modal('New controls, same library',body,'Got it',()=>send('settings',{controlsIntroSeen:true}));$('action-dialog').addEventListener('close',()=>send('settings',{controlsIntroSeen:true}),{once:true});}}
$('replay-tour').onclick=()=>{tourStep=0;showTour();};$('next-tour').onclick=()=>{if(tourStep===guide.length-1)finishTour(false);else{tourStep++;showTour();}};$('back-tour').onclick=()=>{tourStep--;showTour();};$('skip-tour').onclick=$('close-tour').onclick=()=>finishTour(true);$('tour-dialog').oncancel=event=>{event.preventDefault();finishTour(true);};
$('appearance').onchange=()=>send('settings',{appearance:$('appearance').value});for(const id of ['text-size','reading-size'])$(id).onchange=()=>send('settings',{transcriptTextSize:Number($(id).value)});$('autoplay-next').onchange=()=>send('settings',{autoplayNext:$('autoplay-next').checked});$('repeat-mode').onchange=()=>send('settings',{repeat:$('repeat-mode').value});matchMedia('(prefers-color-scheme: dark)').addEventListener('change',applyPreferences);
$('create-collection').onclick=()=>editCollection();$('select-all').onclick=()=>{visibleItems.forEach(item=>selection.add(item.id));renderSelection();};$('clear-selection').onclick=()=>{selection.clear();renderSelection();};$('organize-selection').onclick=()=>organizeItems([...selection]);
$('close-action').onclick=$('cancel-action').onclick=()=>{$('action-dialog').close();actionHandler=null;};$('action-form').onsubmit=event=>{event.preventDefault();const handler=actionHandler;$('action-dialog').close();actionHandler=null;handler?.();};
$('workspace-menu').onclick=()=>itemMenu(currentItem());$('item-title').ondblclick=()=>renameItem(currentItem());$('item-title').tabIndex=0;$('item-title').onkeydown=event=>{if(event.key==='F2'){event.preventDefault();renameItem(currentItem());}};
$('theater-mode').onclick=()=>{document.body.classList.toggle('theater');const active=document.body.classList.contains('theater');text('theater-mode',active?'Exit theater':'Theater');$('theater-mode').setAttribute('aria-pressed',String(active));};
$('image-zoom').onclick=()=>{$('media-stage').querySelector('img')?.click();};
$('transcription-setup').onclick=()=>setView('settings');
$('fullscreen-media').onclick=()=>{const media=$('media-stage').querySelector('video');if(document.fullscreenElement)document.exitFullscreen();else if(media?.requestFullscreen)media.requestFullscreen().catch(()=>announce('Fullscreen is not available in this viewer. Use Theater or Open file.'));};
$('play-collection').onclick=()=>{const group=currentCollection();if(!group)return;queueIds=playableItems(orderedItems(library(),group,'collection')).map(item=>item.id);queueCollectionId=group.id;const missing=group.itemIds.filter(id=>!library().some(item=>item.id===id&&!['missing','trashed'].includes(item.fileState))).length;queueOmissions=missing?`${missing} missing file${missing===1?' was':'s were'} skipped. Restore the files to include them.`:'';if(queueIds.length){playOnLoad=true;selectItem(queueIds[0]);}};
$('generate-frames').onclick=()=>{send('study-submit',{id:selectedId,recipe:'visual'});$('generate-frames').disabled=true;text('frame-generation-status','Requesting frame extraction…');};
$('generate-transcript').onclick=()=>{selectedTrackId='';captionsKey=null;send('study-submit',{id:selectedId,recipe:'speech'});$('generate-transcript').disabled=true;text('generation-status','Requesting local transcription…');};$('cancel-transcript').onclick=()=>send('cancel',{id:(state.study||{}).jobId});$('retry-transcript').onclick=()=>send('resume-job',{id:selectedId});
$('follow-cue').onclick=()=>{followCue=true;$('follow-cue').hidden=true;lastCue=-1;updateCurrentCue();};for(const event of ['wheel','touchmove','pointerdown'])$('caption-cues').addEventListener(event,pauseFollowing,{passive:true});$('caption-cues').tabIndex=0;$('caption-cues').addEventListener('keydown',event=>{if(['PageUp','PageDown','Home','End','ArrowUp','ArrowDown'].includes(event.key))pauseFollowing();});
port.onMessage.addListener(render);
port.onDisconnect.addListener(() => { error('The local app connection closed. Reopen Framekeep to reconnect. Saved files remain in your save folder.'); text('connection-label', 'Connection closed'); $('connection-dot').className = 'status-dot missing'; });
setView('library', false); send('init');
