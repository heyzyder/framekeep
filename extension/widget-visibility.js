// Tab-scoped presentation preferences. No native access or page content.
export function registerWidgetVisibility(api = chrome) {
  const key = id => `framekeep.widget.hidden.${id}`;
  api.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.target !== 'framekeep-widget-state') return;
    const page = sender.id === api.runtime.id && Number.isInteger(sender.tab?.id) && sender.frameId === 0;
    const own = sender.id === api.runtime.id && !sender.tab && sender.url?.startsWith(api.runtime.getURL(''));
    if ((!page && !own) || !['get','hide','restore'].includes(message.action)) { reply({ok:false}); return; }
    (async () => {
      const tabId = page ? sender.tab.id : message.tabId;
      if (!Number.isInteger(tabId)) throw Error('Invalid tab');
      if (message.action === 'hide') await api.storage.session.set({[key(tabId)]: true});
      if (message.action === 'restore') await api.storage.session.remove(key(tabId));
      reply({ok:true,hidden:!!(await api.storage.session.get(key(tabId)))[key(tabId)]});
    })().catch(() => reply({ok:false}));
    return true;
  });
  api.tabs.onRemoved.addListener(id => { api.storage.session.remove(key(id)).catch(() => {}); });
}
