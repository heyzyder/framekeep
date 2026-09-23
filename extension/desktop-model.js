// Presentation helpers keep timing and identity decisions explicit and testable.
export function mediaKind(item) {
  const kind = item?.capabilities?.kind || item?.kind;
  return ['image', 'video', 'audio'].includes(kind) ? kind : 'unknown';
}
export function timestamp(seconds, milliseconds = false, separator = '.') {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.round(seconds * 1000), whole = Math.floor(total / 1000);
  const hours = Math.floor(whole / 3600), minutes = Math.floor(whole / 60) % 60, secs = whole % 60;
  const prefix = hours || milliseconds ? String(hours).padStart(2, '0') + ':' : '';
  return prefix + String(minutes).padStart(2, '0') + ':' + String(secs).padStart(2, '0') + (milliseconds ? separator + String(total % 1000).padStart(3, '0') : '');
}
export function validTiming(cue) {
  return typeof cue?.start === 'number' && Number.isFinite(cue.start) && cue.start >= 0 && typeof cue.end === 'number' && Number.isFinite(cue.end) && cue.end > cue.start;
}
export function transcriptTracks(item) {
  const tracks = (item?.transcriptTracks || []).filter(track => track && (track.cues?.length || track.text));
  if (tracks.length) return tracks;
  const transcript = item?.transcript;
  return transcript?.status === 'ready' ? [{...transcript, id: transcript.id || 'source'}] : [];
}
export function activeCueIndex(cues, seconds) {
  return cues.findIndex(cue => validTiming(cue) && seconds >= cue.start && seconds < cue.end);
}
export function orderedItems(items, selectedCollection, sort = 'recent') {
  const positions = new Map((selectedCollection?.itemIds || []).map((id, index) => [id, index]));
  const result = selectedCollection ? items.filter(item => positions.has(item.id)) : [...items];
  return result.sort((a, b) => sort === 'collection' && selectedCollection ? positions.get(a.id) - positions.get(b.id) : sort === 'title' ? (a.title || a.filename || '').localeCompare(b.title || b.filename || '') : sort === 'oldest' ? (a.finished || a.created || 0) - (b.finished || b.created || 0) : (b.finished || b.created || 0) - (a.finished || a.created || 0));
}
export function playableItems(items) {
  return items.filter(item => ['audio', 'video'].includes(mediaKind(item)) && !['missing','trashed'].includes(item.fileState) && item.capabilities?.playback !== false && item.previewUrl);
}

export function safeMediaUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (url.username || url.password) return '';
    if (['http:', 'https:', 'blob:'].includes(url.protocol)) return url.href;
    if (url.protocol === 'data:' && /^data:(?:image|audio|video)\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*;base64,/i.test(value.trim())) return url.href;
  } catch {}
  return '';
}
