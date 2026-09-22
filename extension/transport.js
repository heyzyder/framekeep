export const desktop = document.documentElement.classList.contains('desktop');
export function createTransport() {
  if (!desktop) return chrome.runtime.connect({name: 'framekeep-popup'});
  const listeners = [], disconnects = [];
  let running = true, revision = -1;
  const api = new Promise(resolve => {
    if (window.pywebview?.api) resolve(window.pywebview.api);
    else addEventListener('pywebviewready', () => resolve(window.pywebview.api), {once: true});
  });
  const emit = value => listeners.forEach(listener => listener(value));
  const poll = async () => {
    try {
      const result = await (await api).snapshot(revision);
      if (result) { revision = result.revision; emit(result.state); }
    } catch { running = false; disconnects.forEach(listener => listener()); }
    if (running) setTimeout(poll, 350);
  };
  poll();
  return {
    postMessage: async message => { try { const result = await (await api).dispatch(message); if (result?.error) emit({uiError: result.error}); } catch { emit({uiError: 'The app could not finish that action. Try again.'}); } },
    onMessage: {addListener: listener => listeners.push(listener)},
    onDisconnect: {addListener: listener => disconnects.push(listener)},
  };
}
