import './capture-discovery.js';
import {HOST} from './shared.js';
import {mediaSource,previewImage} from './page-media.js';

// A separate, narrow channel: webpages never receive transcripts, history or other tabs' URLs.
export function installCapture(chrome) {
  const runs = new Map();
  const subscribers = new Set();
  const summary = run => ({id:run.id, tabId:run.tabId, status:run.status, count:run.count, completed:run.completed || 0, detail:run.detail || '', error:run.error, folder:run.folder, files:run.files});
  const broadcast = run => { for (const p of subscribers) if (p.sender.tab.id === run.tabId) try { p.postMessage({run:summary(run)}); } catch {} };
  const persist = () => chrome.storage.session.set({captureRuns:[...runs.values()].map(summary).slice(-20)}).catch(() => {});
  const ready = chrome.storage.session.get('captureRuns').then(saved => {
    for (const r of saved.captureRuns || []) runs.set(r.id,{...r,status:r.status === 'working' ? 'error' : r.status,error:r.status === 'working' ? 'The helper connection ended. Check the save folder before retrying.' : r.error});
  });
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'framekeep-capture' || port.sender?.id !== chrome.runtime.id || !port.sender.tab?.id || port.sender.frameId !== 0 || !FramekeepCapture.address(port.sender.url)) return;
    subscribers.add(port); port.onDisconnect.addListener(() => subscribers.delete(port));
    let scannedFrames=[],scanGeneration=0;
    port.onMessage.addListener(message => {
      (async () => {
        await ready;
        if (message.action === 'init') { for (const run of runs.values()) if (run.tabId === port.sender.tab.id) port.postMessage({run:summary(run)}); return; }
        if(message.action==='discover-frames'){
          const generation=++scanGeneration,tabId=port.sender.tab.id;
          const top=await chrome.webNavigation.getFrame({tabId,frameId:0});
          if(top?.url!==message.pageUrl||new URL(top.url).origin!==new URL(port.sender.url).origin)return;
          const frames=(await chrome.webNavigation.getAllFrames({tabId})||[]).filter(f=>f.frameId!==0&&FramekeepCapture.address(f.url)).slice(0,20);
          const results=await Promise.allSettled(frames.map(async frame=>{
            const result=await chrome.tabs.sendMessage(tabId,{action:'framekeep-frame-scan'},{frameId:frame.frameId});
            if(result?.pageUrl!==frame.url||!Array.isArray(result.items))return [];
            return result.items.slice(0,20).flatMap(raw=>{
              try {
                const source=mediaSource({url:raw.url,type:'direct',title:raw.title},frame.url);
                const item=FramekeepCapture.item(source.url,frame.url,raw.kind,raw);
                return item?[{...item,thumbnail:previewImage(raw.thumbnail),stream:!!raw.stream,sourceType:'direct',frameId:frame.frameId,frameUrl:frame.url,frameDocumentId:frame.documentId,title:source.title,filename:raw.stream?source.title:item.filename}]:[];
              }catch{return [];}
            });
          }));
          const current=await chrome.webNavigation.getFrame({tabId,frameId:0});
          if(generation!==scanGeneration||current?.url!==top.url||current?.documentId!==top.documentId)return;
          scannedFrames=results.flatMap(r=>r.status==='fulfilled'?r.value:[]).slice(0,40);
          port.postMessage({frameItems:scannedFrames,pageUrl:top.url});return;
        }
        if (message.action === 'video-tools') {
          const frame=await chrome.webNavigation.getFrame({tabId:port.sender.tab.id,frameId:0});
          if(!frame || frame.url!==(message.pageUrl||port.sender.url) || new URL(frame.url).origin!==new URL(port.sender.url).origin || (frame.documentId&&port.sender.documentId&&frame.documentId!==port.sender.documentId)) throw Error('Refresh this page before opening Video tools.');
          let url=frame.url,source;
          if(Number.isInteger(message.frameId)&&message.frameId>0){
            const selected=scannedFrames.find(i=>i.frameId===message.frameId&&i.url===message.url);
            const current=await chrome.webNavigation.getFrame({tabId:port.sender.tab.id,frameId:message.frameId});
            if(!selected||current?.url!==selected.frameUrl||(selected.frameDocumentId&&current.documentId!==selected.frameDocumentId))throw Error('This embedded player changed. Refresh the media list.');
            source=mediaSource({url:selected.url,type:'direct',title:selected.title},current.url);url=source.url;
          }else if(message.url){
            if(message.sourceType==='embed'||message.sourceType==='direct'){
              source=mediaSource({url:message.url,type:message.sourceType,title:message.title},frame.url);url=source.url;
            }else{
              const current=FramekeepCapture.youtubePage(frame.url)||FramekeepCapture.spotifyEpisode(frame.url),requested=FramekeepCapture.youtubePage(message.url)||FramekeepCapture.spotifyEpisode(message.url);
              if(message.url!==frame.url && (!current||requested?.url!==current.url))throw Error('This video belongs to a different page. Refresh the media list.');
              url=current?.url||frame.url;
            }
          }
          await chrome.storage.session.set({captureVideoContext:{tabId:port.sender.tab.id,pageUrl:frame.url,url,source,kind:message.kind==='audio'?'audio':'video'}});
          await chrome.action.openPopup(); return;
        }
        if (message.action === 'folder') {
          const p=chrome.runtime.connectNative(HOST), timer=setTimeout(()=>p.disconnect(),10000);
          p.onMessage.addListener(()=>{clearTimeout(timer);p.disconnect();});
          p.onDisconnect.addListener(()=>{clearTimeout(timer);void chrome.runtime.lastError;});
          p.postMessage({id:crypto.randomUUID(),action:'folder'}); return;
        }
        if (message.action !== 'capture') return;
        const currentFrame = await chrome.webNavigation.getFrame({tabId:port.sender.tab.id,frameId:0});
        if (!currentFrame || currentFrame.url !== (message.pageUrl || port.sender.url) || new URL(currentFrame.url).origin !== new URL(port.sender.url).origin || (currentFrame.documentId && port.sender.documentId && currentFrame.documentId !== port.sender.documentId)) throw Error('This page changed. Refresh the media list before downloading.');
        if ([...runs.values()].some(r=>r.tabId===port.sender.tab.id && r.status==='working')) throw Error('This tab already has a batch running.');
        if (!Array.isArray(message.items) || !message.items.length || message.items.length > 100) throw Error('Choose between 1 and 100 items per batch.');
        const items = message.items.map(raw => {
          const item=FramekeepCapture.item(raw.url,currentFrame.url,raw.kind);
          if (!item || item.stream) throw Error('Use Video tools for streaming players.');
          return {url:item.url,kind:item.kind};
        });
        if (new Set(items.map(i=>i.url)).size !== items.length) throw Error('The selection contains duplicates. Refresh the page media.');
        const imageMode=message.imageMode==='original'?'original':'sanitize';
        const id=crypto.randomUUID(), payload={id,action:'capture',items,imageMode,pageUrl:currentFrame.url};
        if (new TextEncoder().encode(JSON.stringify(payload)).length > 60000) throw Error('These media links are long. Select a smaller batch.');
        const run={id,tabId:port.sender.tab.id,count:items.length,status:'working',detail:'Connecting to your local helper…'};
        runs.set(id,run); broadcast(run); persist();
        const native=chrome.runtime.connectNative(HOST); run.native=native;
        const finish = () => {clearTimeout(run.timer);delete run.native;broadcast(run);persist();};
        run.timer=setTimeout(()=>{run.status='error';run.error='The batch timed out. Originals are retained; no failed files are presented as clean.';native.disconnect();finish();},30*60*1000);
        native.onMessage.addListener(m=>{
          if (m.id !== id) return;
          if (m.event === 'progress') {run.detail=m.detail;run.completed=m.completed;broadcast(run);}
          if (m.event === 'complete') {Object.assign(run,{status:'complete',folder:m.folder,files:m.files,completed:run.count,detail:'Saved to your Framekeep folder'});finish();native.disconnect();}
          if (m.event === 'error' || m.event === 'cancelled') {run.status='error';run.error=m.error || 'Batch stopped. Originals are retained.';finish();native.disconnect();}
        });
        native.onDisconnect.addListener(()=>{const error=chrome.runtime.lastError?.message;if(run.status==='working'){run.status='error';run.error=error || 'The local helper disconnected. Check your save folder before retrying.';finish();}});
        native.postMessage(payload);
      })().catch(error=>{try{port.postMessage({error:error.message});}catch{}});
    });
  });
}
