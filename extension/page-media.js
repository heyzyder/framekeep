// Runs when the user opens Framekeep on the current tab, or refreshes its video list.
// No cookies, request headers, page text or player scripts are collected.
export function inspectMedia() {
  const media = [], frames = [], seen = new Set();
  let blob = false, protectedMedia = false;
  const picture = video => {
    if (video?.poster?.startsWith('https://')) return video.poster;
    if (!video || video.mediaKeys || video.readyState < 2 || !video.videoWidth) return '';
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 480; canvas.height = Math.round(480 * video.videoHeight / video.videoWidth);
      if (canvas.height > 960) return '';
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const result = canvas.toDataURL('image/jpeg', .76);
      return result.length <= 180000 ? result : '';
    } catch { return ''; } // Cross-origin players can deny frame access; the helper has a bounded fallback.
  };
  const add = (value, type, title, base, thumbnail = '') => {
    try {
      const url = new URL(value, base);
      if (!value || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 8192 || seen.has(url.href)) return;
      seen.add(url.href); media.push({url: url.href, type, title: String(title || document.title).slice(0, 200), thumbnail});
    } catch {}
  };
  function scan(doc, win, depth = 0) {
    if (depth > 4) return;
    for (const video of doc.querySelectorAll('video, audio')) {
      if (video.mediaKeys) { protectedMedia = true; continue; }
      if (video.currentSrc?.startsWith('blob:')) blob = true;
      const thumbnail = picture(video);
      add(video.currentSrc || video.getAttribute('src'), 'direct', video.title, doc.baseURI, thumbnail);
      for (const source of video.querySelectorAll('source[src]')) add(source.src, 'direct', video.title, doc.baseURI, thumbnail);
    }
    for (const player of doc.querySelectorAll('presto-player[src]')) add(player.getAttribute('src'), 'direct', document.title, document.baseURI, picture(player.shadowRoot?.querySelector('video')) || player.getAttribute('poster') || '');
    // Presto and other web-component players keep their <video>/<source> in open shadow roots.
    for (const element of doc.querySelectorAll('*')) if (element.shadowRoot) scan(element.shadowRoot, win, depth + 1);
    for (const frame of doc.querySelectorAll('iframe')) {
      if (frame.src) { frames.push(frame.src); add(frame.src, 'embed', frame.title, doc.baseURI); }
      try { if (frame.contentDocument) scan(frame.contentDocument, frame.contentWindow, depth + 1); } catch {}
    }
  }
  scan(document, window);
  // Resource history includes old lessons and every resolution. Prefer the current player's source.
  if (!media.some(item => item.type === 'direct')) for (const entry of window.performance.getEntriesByType('resource')) {
    if (/\.(?:mp4|m4v|webm|mov|m3u8|mpd|mp3|m4a|aac|ogg|opus|wav|flac)(?:[?#]|$)/i.test(entry.name)) add(entry.name, 'direct', '', document.baseURI);
  }
  return {media: media.slice(0, 40), frames: frames.slice(0, 20), blob, protectedMedia, title: document.title.slice(0, 200)};
}

export function previewImage(value) {
  if (typeof value !== 'string') return '';
  if (value.length <= 180000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(value)) return value;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && value.length < 8192 ? url.href : ''; } catch { return ''; }
}

export function uniqueMedia(candidates) {
  const groups = new Map();
  for (const item of candidates) {
    const url = new URL(item.url);
    // Bunny identifies the video with a UUID; signed path tokens and quality playlists identify requests.
    const asset = /(?:^|\/)([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\/|$)/i.exec(url.pathname);
    const key = asset && /(?:^|\.)b-cdn\.net$/.test(url.hostname) ? url.hostname + '/' + asset[1] : item.url;
    const previous = groups.get(key);
    const master = /\/(?:playlist|master|manifest)\.m3u8$/i.test(url.pathname);
    if (!previous || (master && !/\/(?:playlist|master|manifest)\.m3u8(?:[?#]|$)/i.test(previous.url))) groups.set(key, {...item, thumbnail: item.thumbnail || previous?.thumbnail || ''});
  }
  return [...groups.values()];
}

const EMBEDS = ['youtube.com', 'youtube-nocookie.com', 'vimeo.com', 'wistia.com', 'wistia.net', 'mediadelivery.net', 'bunny.net', 'sproutvideo.com', 'vidyard.com'];
export function mediaSource(candidate, pageUrl) {
  const url = new URL(candidate.url), page = new URL(pageUrl);
  for (const value of [url, page]) {
    if (!['https:', 'http:'].includes(value.protocol) || value.username || value.password || value.port || value.href.length > 8192) throw new Error('Unsupported media address.');
    if (value.hostname === 'localhost' || !value.hostname.includes('.') || /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(value.hostname) || value.hostname.includes(':')) throw new Error('Use a video on a public website.');
  }
  const direct = candidate.type === 'direct' && /\.(?:mp4|m4v|webm|mov|m3u8|mpd|mp3|m4a|aac|ogg|opus|wav|flac)(?:$)/i.test(url.pathname);
  const embed = candidate.type === 'embed' && (EMBEDS.some(host => url.hostname === host || url.hostname.endsWith('.' + host)) || (url.hostname==='open.spotify.com' && /^\/(?:embed\/)?episode\/[A-Za-z0-9]{22}\/?$/.test(url.pathname)));
  if (!direct && !embed) throw new Error('This player does not expose a supported media link yet.');
  url.hash = ''; page.hash = '';
  return {url: url.href, pageUrl: page.href, type: direct ? 'direct' : 'embed', title: String(candidate.title || 'Page video').slice(0, 200)};
}
