(() => {
  // An already-injected older client needs a page reload, not a second set of listeners.
  if (globalThis.__framekeepTranscript) return;
  globalThis.__framekeepTranscript = '1.6.0-intake.1';
  let host, shadow, port, videoId, data, mountedParent, layoutTimer, stopped = false;
  let reconnectTimer, attempts = 0, requestedLanguage;
  let intakeMode = false, observedUrl, permittedVideo;
  const $ = id => shadow.getElementById(id);
  const time = seconds => {
    const n = Math.max(0, Math.floor(seconds));
    return n >= 3600 ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}` : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
  };
  const currentVideo = () => {
    const url = new URL(location.href), id = url.searchParams.get('v');
    return url.pathname === '/watch' && /^[\w-]{11}$/.test(id || '') ? id : null;
  };
  const captionsAllowed = () => !!videoId && (!intakeMode || permittedVideo === videoId);
  function syncNavigation() {
    const url = new URL(location.href), next = currentVideo();
    const directives = new URLSearchParams(url.hash.slice(1)).getAll('framekeep');
    const freshUrl = observedUrl !== url.href;
    // Intake survives SPA links that drop the fragment. Only an explicit normal
    // directive or a new document without intake restores automatic captions.
    const nextIntake = freshUrl && directives.includes('intake') ? true
      : freshUrl && directives.length === 1 && directives[0] === 'normal' ? false : intakeMode;
    const reset = next !== videoId || nextIntake !== intakeMode ||
      (freshUrl && directives.includes('intake') && permittedVideo);
    observedUrl = url.href; intakeMode = nextIntake;
    if (!reset) return;
    videoId = next; data = null; permittedVideo = null; requestedLanguage = undefined; attempts = 0;
    clearTimeout(reconnectTimer);
    // Invalidate the callback identity before disconnect can deliver a final reply.
    const previous = port; port = null;
    try { previous?.disconnect(); } catch { /* An invalidated client still must clear its old captions. */ }
    if (!host) return;
    host.dataset.videoId = next || ''; host.dataset.captionMode = intakeMode ? 'intake' : 'normal';
    $('cues').replaceChildren(); $('search').value = ''; $('reader').scrollTop = 0;
    $('source').textContent = ''; $('source').title = ''; $('feedback').textContent = ''; $('count').textContent = '';
    $('language').replaceChildren();
    for (const id of ['language', 'copy', 'save', 'search']) $(id).disabled = true;
    if (!captionsAllowed()) showIntake();
  }
  function showIntake() {
    if (!host) return;
    data = {videoId, status: 'intake'};
    host.dataset.captionMode = 'intake'; host.dataset.captionState = 'paused';
    $('intake').hidden = false; $('caption-content').hidden = true;
    $('source').textContent = 'Intake preview · captions paused'; $('source').title = '';
    $('cues').replaceChildren();
  }
  function build() {
    document.getElementById('framekeep-transcript')?.remove();
    host = document.createElement('framekeep-transcript');
    host.id = 'framekeep-transcript';
    shadow = host.attachShadow({mode: 'open'});
    // This template contains only extension-owned markup; captions are inserted as text nodes.
    shadow.innerHTML = `
      <style>
        :host{display:block!important;box-sizing:border-box;min-width:0;width:100%;margin:0 0 18px;font:14px/1.5 "Segoe UI",Arial,sans-serif;--ink:#252d4c;--muted:#69738e;--paper:#fff;--soft:#f6f7fc;--line:#dfe3ef;--accent:#5965db;color:var(--ink);color-scheme:light}
        :host([theme=dark]){--ink:#eff1fa;--muted:#aeb6cd;--paper:#202127;--soft:#292b34;--line:#3c3f4e;--accent:#b4bbff;color-scheme:dark}
        *{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer}button:disabled{opacity:.55;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}[hidden]{display:none!important}
        .panel{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--paper)}header{height:54px;display:flex;align-items:center;padding:0 16px;gap:9px;border-bottom:1px solid var(--line);background:var(--soft)}h2{font-size:17px;font-weight:650;margin:0}.brand{color:var(--muted);font-size:11px;margin-left:auto}.collapse{color:var(--ink);width:29px;height:29px;border:0;border-radius:6px;background:transparent;font-size:20px}.collapse:hover{background:var(--line)}
        .body{padding:14px 14px 10px}.source{font-size:12px;line-height:1.5;color:var(--muted);margin:0 0 11px;min-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tools{display:flex;gap:7px}select{min-width:0;flex:1;width:0}.control{height:35px;border:1px solid var(--line);border-radius:7px;padding:0 10px;background:var(--paper);color:var(--ink);font-size:12px}.tools button{color:var(--accent);white-space:nowrap}.search{display:block;width:100%;margin-top:9px;height:36px}.meta{display:flex;align-items:center;justify-content:space-between;gap:8px;height:34px;color:var(--muted);font-size:11px}.meta label{white-space:nowrap}input[type=checkbox]{accent-color:var(--accent);vertical-align:middle;margin:0 4px 0 0}
        .reader{height:360px;max-height:55vh;min-height:200px;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;overflow-anchor:none}.message{padding:23px 6px;font-size:13px;color:var(--muted);line-height:1.8}.message p{margin:0 0 12px}.retry{color:var(--accent);border:1px solid var(--line);background:var(--soft);border-radius:7px;padding:7px 13px}.cue{display:flex;gap:11px;align-items:baseline;padding:10px 2px;border-bottom:1px solid var(--line);line-height:1.7}.stamp{flex:none;font-size:11px;font-variant-numeric:tabular-nums;border:0;border-radius:4px;background:var(--soft);color:var(--accent);padding:3px 5px}.cue p{font-size:14px;min-width:0;overflow-wrap:anywhere;margin:0}.no-times .stamp{display:none}.feedback{min-height:23px;margin:7px 0 0;font-size:11px;color:var(--muted)}
      </style>
      <section class="panel" aria-label="Framekeep video transcript"><header><h2>Transcript</h2><span class="brand">framekeep.</span><button id="collapse" class="collapse" aria-label="Collapse transcript" aria-expanded="true">−</button></header><div id="body" class="body"><p id="source" class="source">Captions load automatically</p><div id="intake" hidden><p>Captions stay paused during intake. Load them when you choose to study this video.</p><button id="load-captions" class="retry">Load captions</button></div><div id="caption-content"><div class="tools"><select id="language" class="control" aria-label="Caption language" disabled><option>Loading captions…</option></select><button id="copy" class="control" disabled>Copy</button><button id="save" class="control" disabled>Save .txt</button></div><input id="search" class="control search" type="search" placeholder="Search transcript…" aria-label="Search transcript" disabled><div class="meta"><span id="count" role="status">Finding captions…</span><label><input id="timestamps" type="checkbox" checked>Timestamps</label></div><div id="reader" class="reader"><div id="message" class="message" role="status"><p id="message-text">Finding available captions…</p><button id="retry" class="retry" hidden>Retry</button></div><div id="cues"></div></div><p id="feedback" class="feedback" role="status"></p></div></div></section>`;
    $('collapse').onclick = () => { const collapsed = !$('body').hidden; $('body').hidden = collapsed; $('collapse').textContent = collapsed ? '+' : '−'; $('collapse').setAttribute('aria-expanded', String(!collapsed)); $('collapse').setAttribute('aria-label', collapsed ? 'Expand transcript' : 'Collapse transcript'); };
    $('load-captions').onclick = () => { syncNavigation(); if (!videoId || stopped) return; permittedVideo = videoId; load(); };
    $('search').oninput = renderCues;
    $('timestamps').onchange = () => $('cues').classList.toggle('no-times', !$('timestamps').checked);
    $('language').onchange = () => load($('language').value);
    $('retry').onclick = () => { if (stopped) location.reload(); else { attempts = 0; load(requestedLanguage, true); } };
    $('copy').onclick = async () => { try { await navigator.clipboard.writeText(transcriptText()); $('feedback').textContent = 'Transcript copied.'; } catch { $('feedback').textContent = 'Copy was blocked. Use Save .txt instead.'; } };
    $('save').onclick = () => { const url = URL.createObjectURL(new Blob([transcriptText()], {type: 'text/plain;charset=utf-8'})); const link = document.createElement('a'); link.href = url; link.download = `Framekeep ${videoId} ${data.transcript.language}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); $('feedback').textContent = 'Transcript sent to Chrome’s downloads.'; };
  }
  function transcriptText() { syncNavigation(); return (captionsAllowed() ? data?.transcript?.cues || [] : []).map(cue => `${$('timestamps').checked ? '[' + time(cue.start) + '] ' : ''}${cue.text}`).join('\n'); }
  function renderCues() {
    syncNavigation();
    if (!captionsAllowed() || data?.status !== 'ready') return;
    const all = data?.transcript?.cues || [], query = $('search').value.trim().toLocaleLowerCase();
    const visible = all.filter(cue => !query || cue.text.toLocaleLowerCase().includes(query));
    $('cues').replaceChildren(...visible.map(cue => {
      const row = document.createElement('div'); row.className = 'cue';
      const stamp = document.createElement('button'); stamp.className = 'stamp'; stamp.textContent = time(cue.start); stamp.title = 'Jump to this point in the video';
      stamp.onclick = () => {
        if (currentVideo() !== videoId) return;
        if (document.querySelector('#movie_player.ad-showing')) { $('feedback').textContent = 'Wait until the ad finishes to jump to a timestamp.'; return; }
        const video = document.querySelector('#movie_player video') || document.querySelector('video');
        if (video) { video.currentTime = cue.start; video.play().catch(() => {}); $('feedback').textContent = `Jumped to ${time(cue.start)}.`; }
      };
      const text = document.createElement('p'); text.textContent = cue.text; row.append(stamp, text); return row;
    }));
    $('count').textContent = query ? `${visible.length} of ${all.length} segments` : `${all.length} segments`;
    $('message').hidden = visible.length > 0; $('message-text').textContent = 'No matching words. Try another search.'; $('retry').hidden = true;
  }
  function render(message) {
    syncNavigation();
    if (message.videoId !== videoId || !host || !captionsAllowed()) return;
    data = message;
    host.dataset.captionMode = intakeMode ? 'intake' : 'normal'; host.dataset.captionState = message.status;
    $('intake').hidden = true; $('caption-content').hidden = false;
    const ready = message.status === 'ready';
    for (const id of ['copy', 'save', 'search']) $(id).disabled = !ready;
    $('language').disabled = message.status === 'loading' || !message.info?.tracks?.length;
    if (message.info?.tracks?.length) {
      $('language').replaceChildren(...message.info.tracks.map(track => { const option = document.createElement('option'); option.value = track.language; option.textContent = `${track.name}${track.automatic ? ' · automatic' : ''}`; return option; }));
      $('language').value = message.transcript?.language || message.language || message.info.tracks[0].language;
    } else if (!ready) { const option = document.createElement('option'); option.textContent = message.status === 'loading' ? 'Loading captions…' : message.status === 'unavailable' ? 'No captions available' : 'Captions not loaded'; $('language').replaceChildren(option); }
    $('source').textContent = ready ? `${message.transcript.name || message.transcript.language} · ${message.transcript.automatic ? 'Automatic captions' : 'Creator-provided captions'}` : message.info?.title || 'Captions load automatically';
    $('source').title = message.info?.title || '';
    $('feedback').textContent = ready && message.transcript.truncated ? 'Long transcript limited to the first 5,000 segments / 700 KB.' : '';
    $('message').hidden = ready; $('retry').hidden = !['error', 'unavailable'].includes(message.status);
    $('retry').textContent = message.status === 'unavailable' ? 'Check captions again' : 'Retry';
    if (ready) renderCues();
    else {
      $('cues').replaceChildren(); $('count').textContent = message.status === 'loading' ? 'Loading…' : message.status === 'error' ? 'Couldn’t load captions' : 'No captions';
      $('message-text').textContent = message.status === 'error' ? message.error : message.status === 'unavailable' ? 'This video has no accessible captions. A transcript is unavailable for this video.' : message.message || 'Loading captions…';
    }
  }
  function load(language, retry = false) {
    syncNavigation();
    if (!captionsAllowed() || stopped) return;
    clearTimeout(reconnectTimer); requestedLanguage = language;
    render({videoId, status: 'loading', info: data?.info, language});
    try {
      if (!port) {
        port = chrome.runtime.connect({name: 'framekeep-page-transcript'});
        const connected = port;
        port.onMessage.addListener(message => {
          syncNavigation();
          if (port !== connected || message.videoId !== videoId) return;
          if (['ready', 'unavailable', 'error'].includes(message.status)) attempts = 0;
          render(message);
        });
        port.onDisconnect.addListener(() => {
          const reason = chrome.runtime.lastError?.message;
          syncNavigation();
          if (port !== connected) return;
          port = null;
          // An idle service worker may close a port. Already loaded captions remain usable.
          if (data?.status === 'ready' || !videoId) return;
          recover(reason);
        });
      }
      port.postMessage({action: 'load', videoId, ...(language ? {language} : {}), retry});
    } catch (error) { port = null; recover(error.message); }
  }
  function recover(reason = '') {
    syncNavigation();
    if (!captionsAllowed()) return;
    clearTimeout(reconnectTimer);
    if (!chrome.runtime?.id || /context invalidated/i.test(reason)) {
      stopped = true; observer.disconnect(); themeObserver.disconnect();
      render({videoId, status: 'error', info: data?.info, error: 'Framekeep was updated. Reload this page to connect to the new version.'});
      $('retry').textContent = 'Reload page'; return;
    }
    if (attempts < 3) {
      const delay = [500, 1500, 3000][attempts++];
      render({videoId, status: 'loading', info: data?.info, message: `Reconnecting to Framekeep… (${attempts}/3)`});
      reconnectTimer = setTimeout(() => load(requestedLanguage), delay);
    } else render({videoId, status: 'error', info: data?.info, error: 'Could not connect to Framekeep. Open the extension to reconnect, then Retry.'});
  }
  function place() {
    syncNavigation();
    if (!videoId) { host?.remove(); mountedParent = null; return; }
    const watch = document.querySelector('ytd-watch-flexy'); if (!watch) return;
    const secondary = watch.querySelector('#secondary-inner');
    const beside = secondary && secondary.getBoundingClientRect().width >= 250;
    const parent = beside ? secondary : watch.querySelector('#below');
    if (!parent) return;
    if (!host) build();
    host.dataset.videoId = videoId; host.dataset.captionMode = intakeMode ? 'intake' : 'normal';
    if (!captionsAllowed()) showIntake();
    host.setAttribute('theme', document.documentElement.hasAttribute('dark') ? 'dark' : 'light');
    let before = beside ? null : parent.querySelector('#comments, ytd-comments');
    while (before && before.parentElement !== parent) before = before.parentElement;
    const afterComments = before && !!(host.compareDocumentPosition(before) & Node.DOCUMENT_POSITION_PRECEDING);
    if (!host.isConnected || mountedParent !== parent || afterComments) {
      if (beside) parent.prepend(host); else parent.insertBefore(host, before);
      mountedParent = parent;
    }
    if (captionsAllowed() && (!data || data.status === 'intake')) load();
  }
  const schedule = () => { if (!layoutTimer && !stopped) layoutTimer = setTimeout(() => { layoutTimer = null; place(); }, 180); };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {childList: true, subtree: true});
  const themeObserver = new MutationObserver(schedule);
  themeObserver.observe(document.documentElement, {attributes: true, attributeFilter: ['dark']});
  const navigate = () => { if (!stopped) place(); };
  document.addEventListener('yt-navigate-finish', navigate);
  document.addEventListener('yt-page-data-updated', navigate);
  addEventListener('popstate', navigate); addEventListener('hashchange', navigate); addEventListener('resize', schedule);
  place();
})();
