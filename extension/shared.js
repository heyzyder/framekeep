export const PLATFORMS = [
  {name: 'YouTube', domains: ['youtube.com', 'youtu.be', 'youtube-nocookie.com']},
  {name: 'Vimeo', domains: ['vimeo.com']},
  {name: 'TikTok', domains: ['tiktok.com']},
  {name: 'Instagram', domains: ['instagram.com', 'instagr.am']},
  {name: 'Reddit', domains: ['reddit.com', 'redd.it']},
  {name: 'X / Twitter', domains: ['x.com', 'twitter.com', 't.co']},
  {name: 'Facebook', domains: ['facebook.com', 'fb.watch']},
  {name: 'Twitch', domains: ['twitch.tv']},
  {name: 'Dailymotion', domains: ['dailymotion.com', 'dai.ly']},
  {name: 'Bilibili', domains: ['bilibili.com', 'b23.tv']},
  {name: 'Pinterest', domains: ['pinterest.com', 'pin.it']},
  {name: 'Tumblr', domains: ['tumblr.com']},
  {name: 'Streamable', domains: ['streamable.com']},
  {name: 'Rumble', domains: ['rumble.com']},
  {name: 'VK', domains: ['vk.com', 'vkvideo.ru']},
  {name: 'Bluesky', domains: ['bsky.app']},
];

export function platformFor(host) {
  return PLATFORMS.find(platform => platform.domains.some(domain => host === domain || host.endsWith('.' + domain)));
}

export function normalizeUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Paste a video link from a supported platform.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Paste a full video link, starting with https://.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('Use a standard public video link.');
  const host = url.hostname.toLowerCase();
  const platform = platformFor(host);
  if (!platform) throw new Error('This site is not supported yet. See the supported platforms below.');
  if (platform.name !== 'YouTube') {
    if (url.pathname === '/' && !url.search) throw new Error('Paste a specific video or post link, rather than a homepage.');
    url.protocol = 'https:';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (key.startsWith('utm_') || ['fbclid', 'igsh', 'igshid'].includes(key)) url.searchParams.delete(key);
    return url.href;
  }
  const parts = url.pathname.split('/').filter(Boolean);
  let id;
  if (host === 'youtu.be' && parts.length === 1) id = parts[0];
  else if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else if (['shorts', 'live', 'embed'].includes(parts[0]) && parts.length === 2) id = parts[1];
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id || '')) throw new Error('Use a single YouTube video or Short, rather than a channel or playlist.');
  return `https://www.youtube.com/watch?v=${id}`;
}

export function duration(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const n = Math.max(0, Math.floor(seconds));
  return n >= 3600 ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}` : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

export const ACTIVE = new Set(['starting', 'downloading', 'processing', 'cancelling']);
export const downloadKey = (url, kind, quality) => JSON.stringify([url, kind, String(quality)]);
export const recentJobs = jobs => { let finished = 0; return jobs.filter(job => ACTIVE.has(job.status) || ++finished <= 12); };
export const HOST = 'com.framekeep.downloader';

// Finished jobs live in Downloads; only fresh results briefly appear beside the form.
export function transferPresentation(job, now = Date.now(), dismissed = false) {
  if (!job || dismissed) return 'hidden';
  if (ACTIVE.has(job.status)) return 'progress';
  if (['trashed', 'missing'].includes(job.fileState)) return 'hidden';
  if (['error', 'interrupted'].includes(job.status)) return job.unread ? 'result' : 'hidden';
  return Number.isFinite(job.finished) && now - job.finished < 8000 ? 'result' : 'hidden';
}

export function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024, i = 0;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[i]}`;
}

export function transferView(job) {
  if (!job) return {status: 'idle', title: 'Ready when you are', detail: 'Your download progress will appear here.', percent: null, metric: '', bytes: '', speed: '', eta: ''};
  const percent = Number.isFinite(job.percent) ? Math.max(0, Math.min(100, job.percent)) : null;
  const titles = {starting: 'Preparing your download', downloading: job.stage === 'audio' ? 'Downloading audio' : job.stage === 'video' ? 'Downloading video' : 'Downloading your file', processing: job.kind === 'audio' ? 'Converting to MP3' : 'Putting your video together', cancelling: 'Cancelling download', complete: 'Download finished', error: 'Download couldn’t finish', interrupted: 'Download interrupted', cancelled: 'Download cancelled'};
  const details = {starting: 'Getting the media link. Your download will start shortly.', downloading: 'You can close this popup. Keep Chrome open.', processing: 'Finishing the file on your computer. Almost ready.', cancelling: 'Stopping the current download…', complete: job.filename || 'Your file is ready in the save folder.', error: job.error, interrupted: job.error, cancelled: 'Partial files may remain. You can try the download again.'};
  const bytes = Number.isFinite(job.downloaded) ? `${formatBytes(job.downloaded)}${job.total > 0 ? ' of ' + formatBytes(job.total) : ''}` : '';
  return {status: job.status, title: titles[job.status] || job.status, detail: details[job.status] || '',
    percent: job.status === 'complete' ? 100 : job.status === 'downloading' ? percent : null,
    metric: job.status === 'complete' ? '✓ Saved' : job.status === 'downloading' && percent !== null ? `${Math.floor(percent)}%` : '',
    bytes: job.status === 'complete' ? formatBytes(job.bytes) : bytes,
    speed: job.status === 'downloading' && job.speed > 0 ? `${formatBytes(job.speed)}/s` : '',
    eta: job.status === 'downloading' && Number.isFinite(job.eta) && job.eta >= 0 ? `${duration(job.eta)} left` : ''};
}
