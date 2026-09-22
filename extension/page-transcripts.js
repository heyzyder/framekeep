// Page caption requests have their own queue and native sessions. They never change
// the popup's selected video, download job, history, or preferences.
export function installPageTranscripts(chrome) {
  const queue = new Map(), active = new Map(), versions = new WeakMap();
  let cache = [], persistence = Promise.resolve();
  const ready = chrome.storage.session.get('pageTranscriptCache').then(saved => {
    cache = Array.isArray(saved.pageTranscriptCache) ? saved.pageTranscriptCache.slice(0, 5) : [];
  }).catch(() => { cache = []; });
  const post = (port, data) => { try { port.postMessage(data); } catch {} };
  function remember(entry) {
    cache = [entry, ...cache.filter(item => item.videoId !== entry.videoId)].slice(0, 5);
    const snapshot = cache;
    persistence = persistence.catch(() => {}).then(() => chrome.storage.session.set({pageTranscriptCache: snapshot}));
    persistence.catch(() => {});
  }
  function session() {
    const port = chrome.runtime.connectNative('com.framekeep.downloader');
    const pending = new Map();
    port.onMessage.addListener(message => {
      const task = pending.get(message.id);
      if (!task || !['result', 'error', 'cancelled'].includes(message.event)) return;
      pending.delete(message.id); clearTimeout(task.timer);
      if (message.event === 'result') task.resolve(message.data);
      else task.reject(new Error(message.error || 'Caption loading was interrupted. Try again.'));
    });
    const stop = () => {
      const error = chrome.runtime.lastError?.message || 'The local helper disconnected. Run Install Framekeep.cmd, then retry.';
      for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error(error)); }
      pending.clear();
    };
    port.onDisconnect.addListener(stop);
    return {
      close() { stop(); try { port.disconnect(); } catch {} },
      request(action, data) {
        return new Promise((resolve, reject) => {
          const id = crypto.randomUUID();
          const timer = setTimeout(() => { pending.delete(id); reject(new Error('Caption loading timed out. Please retry.')); try { port.disconnect(); } catch {} }, 130000);
          pending.set(id, {resolve, reject, timer});
          try { port.postMessage({id, action, ...data}); }
          catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
        });
      },
    };
  }
  async function load(port, task) {
    const {videoId, language, retry, version} = task;
    const current = () => versions.get(port) === version;
    const emit = data => { if (current()) post(port, {videoId, ...data}); };
    let native, info, selectedLanguage = language;
    try {
      await ready;
      if (!current()) return;
      const cached = cache.find(item => item.videoId === videoId && item.transcript?.cues?.length);
      if (!retry && cached && (!language || cached.transcript?.language === language)) {
        emit({status: 'ready', ...cached}); return;
      }
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      emit({status: 'loading', message: 'Finding available captions…'});
      native = session(); task.native = native;
      info = (!retry && cached?.info) || await native.request('probe', {url});
      if (!current()) return;
      const tracks = info.tracks || [];
      if (!tracks.length) { emit({status: 'unavailable', info}); return; }
      const track = language ? tracks.find(item => item.language === language) : tracks[0];
      if (!track) throw new Error('That caption language is unavailable. Refresh the transcript and try again.');
      selectedLanguage = track.language;
      emit({status: 'loading', info, language: track.language, message: 'Loading the video’s captions…'});
      const data = await native.request('transcript', {url, language: track.language});
      if (!current()) return;
      if (!data?.cues?.length) throw new Error('This caption track is empty. Try another language.');
      const entry = {videoId, info, transcript: {...data, name: track.name, automatic: track.automatic}};
      remember(entry); emit({status: 'ready', ...entry});
    } catch (error) { emit({status: 'error', info, language: selectedLanguage, error: error.message}); }
    finally {
      native?.close();
      if (active.get(port) === task) active.delete(port);
      pump();
    }
  }
  function pump() {
    while (active.size < 2 && queue.size) {
      const [port, task] = queue.entries().next().value;
      queue.delete(port); active.set(port, task); load(port, task).catch(() => {});
    }
  }
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'framekeep-page-transcript') return;
    let sender;
    try { sender = new URL(port.sender?.url || ''); } catch { return; }
    if (port.sender?.id !== chrome.runtime.id || !Number.isInteger(port.sender?.tab?.id) || port.sender.frameId !== 0 || sender.origin !== 'https://www.youtube.com') return;
    versions.set(port, 0);
    const cancel = () => {
      versions.set(port, (versions.get(port) || 0) + 1);
      queue.delete(port); active.get(port)?.native?.close(); active.delete(port);
    };
    port.onDisconnect.addListener(() => { cancel(); pump(); });
    port.onMessage.addListener(message => {
      if (message.action !== 'load' || !/^[\w-]{11}$/.test(message.videoId || '') || (message.language !== undefined && !/^[\w-]{1,35}$/.test(message.language))) return;
      cancel();
      const task = {videoId: message.videoId, language: message.language, retry: message.retry === true, version: versions.get(port)};
      queue.set(port, task); post(port, {videoId: task.videoId, status: 'loading', message: active.size >= 2 ? 'Waiting for another transcript to finish…' : 'Finding available captions…'}); pump();
    });
  });
}
