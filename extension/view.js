const view = new URLSearchParams(location.search).get('view');
if (view === 'desktop') document.documentElement.classList.add('desktop');
if (view === 'window') document.documentElement.classList.add('expanded');
if (view === 'panel') document.documentElement.classList.add('panel');
if (!['window', 'panel', 'desktop'].includes(view)) {
  // Give Chrome an intrinsic width first. Only height follows its available popup space.
  const fitHeight = () => {
    if (innerHeight >= 240) document.documentElement.style.setProperty('--popup-height', `${Math.min(600, innerHeight)}px`);
  };
  addEventListener('resize', fitHeight);
  addEventListener('DOMContentLoaded', fitHeight, {once: true});
}
