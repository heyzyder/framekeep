const paths = {
  video: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3Z"/>',
  audio: '<path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="17" cy="16" rx="3" ry="3"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  transcript: '<path d="M8 5h12M8 12h12M8 19h8M3 5h.01M3 12h.01M3 19h.01"/>',
  library: '<path d="M4 4h16v16H4zM4 9h16M9 9v11"/>',
  expand: '<path d="M14 4h6v6m0-6-9 9M4 8v12h12"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/>',
  settings: '<path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  refresh: '<path d="M20 6v5h-5M4 18v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 5M4 13l2 5a7 7 0 0 0 12-1"/>',
  folder: '<path d="M3 6h6l2 2h10v12H3Z"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
};
export function icon(name) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  element.setAttribute('viewBox', '0 0 24 24'); element.setAttribute('fill', 'none'); element.setAttribute('stroke', 'currentColor');
  element.setAttribute('width', '20'); element.setAttribute('height', '20');
  element.setAttribute('stroke-width', '1.7'); element.setAttribute('stroke-linecap', 'round'); element.setAttribute('stroke-linejoin', 'round'); element.setAttribute('aria-hidden', 'true');
  element.innerHTML = paths[name] || paths.video; return element;
}
export function decorateIcons() {
  for (const [id, name] of [['sidebar', 'panel'], ['expand', 'expand'], ['help-toggle', 'settings'], ['dialog-close', 'close'], ['completion-dismiss', 'close']]) document.getElementById(id).replaceChildren(icon(name));
  for (const [id, name] of [['save-tab', 'download'], ['transcript-tab', 'transcript'], ['history-tab', 'library']]) document.getElementById(id).prepend(icon(name));
  document.querySelector('#download>span:last-child').replaceChildren(icon('download'));
  for (const element of document.querySelectorAll('.format-picker b')) element.replaceChildren(icon(element.closest('label').querySelector('input').value));
  document.querySelector('.empty-icon').replaceChildren(icon('video'));
  document.getElementById('find-page').replaceChildren(icon('refresh'), document.createTextNode('Refresh'));
}
