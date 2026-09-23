// Only extension UI may start capture. Content scripts can stop their own tab.
export function installBrowserTranscription(chrome, {request, captions, generateSource}) {
  const root = chrome.runtime.getURL('');
  const active = new Set(['preparing','recording','stopping']);
  let live = {status:'idle', cues:[], provisional:[]}, whole = {status:'idle'}, sequence = 0;
  let busy = false, checking = false, source = null, stopping = null, creating, nativeInFlight=null;
  async function captureRequest(action,data,timeout){
    const operation=request(action,data,timeout);nativeInFlight=operation;
    try{return await operation;}finally{if(nativeInFlight===operation)nativeInFlight=null;}
  }
  const save = async () => {
    await chrome.storage.session.set({browserTranscript:live,browserWholeTranscript:whole});
    if (active.has(live.status)) {
      await chrome.action.setBadgeText({text:live.status==='recording'?'REC':'…'});
      await chrome.action.setBadgeBackgroundColor({color:'#b52c42'});
      await chrome.action.setTitle({title:'Framekeep is transcribing tab audio · Open toolbar → Stop'});
    }
    chrome.runtime.sendMessage({target:'framekeep-browser-ui', live, whole}).catch(()=>{});
  };
  const ready = chrome.storage.session.get(['browserTranscript','browserWholeTranscript']).then(async saved=> {
    if (saved.browserTranscript) live=saved.browserTranscript;
    if (saved.browserWholeTranscript) whole=saved.browserWholeTranscript;
    if (active.has(live.status)) {
      live={...live,status:'interrupted',reason:'The browser worker restarted. Capture stopped; settled text is saved in Desktop.'};
      await chrome.runtime.sendMessage({target:'framekeep-offscreen',action:'stop',sessionId:live.sessionId,discard:true}).catch(()=>({}));
      await save();
    }
  });
  function extensionUI(sender) {
    if (sender.id!==chrome.runtime.id || !sender.url?.startsWith(root)) return false;
    const path = new URL(sender.url).pathname;
    return ['/popup.html','/browser-transcript.html'].includes(path);
  }
  async function inspect(tabId) {
    const result=await chrome.scripting.executeScript({target:{tabId},func:()=> {
      const elements=[...document.querySelectorAll('video,audio')];
      const element=elements.find(e=>!e.paused&&!e.ended)||elements[0];
      return {src:element?.currentSrc||'',time:element?.currentTime,rate:element?.playbackRate,
        paused:element?.paused,protected:!!element?.mediaKeys,ad:!!document.querySelector('.ad-showing')};
    }});
    return result[0]?.result||{};
  }
  async function ensureOffscreen() {
    const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[root+'browser-audio.html']});
    if (contexts.length) return;
    if (!creating) creating=chrome.offscreen.createDocument({url:'browser-audio.html',reasons:['USER_MEDIA'],justification:'Transcribe audio from the tab explicitly selected by the user and keep it audible.'}).finally(()=>{creating=null;});
    await creating;
  }
  async function stop(reason='', interrupted=false, droppedChunks=0, disconnected=false) {
    if (stopping) return stopping;
    if (!active.has(live.status)) return live;
    stopping=(async()=> {
      live={...live,status:'stopping',reason};await save();
      // Stop browser tracks first, even if local inference is slow/disconnected.
      const stopped=await chrome.runtime.sendMessage({target:'framekeep-offscreen',action:'stop',sessionId:live.sessionId,discard:interrupted}).catch(()=>({}));
      // Wait on the actual bounded native request, including up to 120s model
      // loading, rather than racing a shorter independent stop timeout.
      if(nativeInFlight)await nativeInFlight.catch(()=>{});
      try {if(disconnected){live={...live,status:'interrupted',reason};}else{const result=await request('browser-stop',{reason,interrupted,droppedChunks:droppedChunks+(stopped?.droppedChunks||0)},110000);live={...live,...(result.data?.status==='idle'?{status:'interrupted',reason:reason||'Capture connection ended.'}:result.data)};}}
      catch(error){live={...live,status:'interrupted',reason:error.message};}
      await save();await chrome.action.setBadgeText({text:live.status==='interrupted'?'!':''});
      await chrome.action.setTitle({title:'Save with Framekeep'});
      stopping=null;return live;
    })();
    return stopping;
  }
  async function start(language) {
    if (active.has(live.status))throw new Error('Stop the current transcript before starting another.');
    if(['saving','processing'].includes(whole.status))throw new Error('Wait for whole-media generation to finish before starting live transcription.');
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if (!tab?.id || !/^https?:\/\//.test(tab.url||'')) throw new Error('Open the toolbar on the browser page you want to transcribe.');
    // Extension invocation/activeTab and tabCapture are enforced by Chrome.
    source=await inspect(tab.id);
    if(!source.src)throw new Error('Play audio or video in this page first. Embedded-only or hidden players cannot be verified for live capture; open the media directly or use accessible-media generation.');
    if(source.protected)throw new Error('This player uses protected media. Live capture is unavailable.');
    if(source.ad)throw new Error('Wait for the advertisement to finish, then start transcription.');
    const sid=crypto.randomUUID();sequence=0;
    live={status:'preparing',sessionId:sid,tabId:tab.id,pageUrl:tab.url,title:tab.title,cues:[],provisional:[],reason:'Loading the installed local speech model…'};await save();
    try {
      busy=true;
      let result;
      try{result=await captureRequest('browser-start',{sessionId:sid,url:tab.url,title:tab.title,language:language||'auto'},130000);}finally{busy=false;}
      if(live.status!=='preparing')throw new Error('Start was cancelled.');
      const currentTab=await chrome.tabs.get(tab.id),currentSource=await inspect(tab.id);
      if(currentTab.url!==tab.url||currentSource.src!==source.src||currentSource.protected||currentSource.ad)throw new Error('The source changed while the model loaded. Start again for the current media.');
      source=currentSource;
      await ensureOffscreen();
      const streamId=await chrome.tabCapture.getMediaStreamId({targetTabId:tab.id});
      const capture=await chrome.runtime.sendMessage({target:'framekeep-offscreen',action:'start',sessionId:sid,streamId});
      if(capture?.error||!capture?.started)throw new Error(capture?.error||'Chrome did not confirm audio capture.');
      source.checked=Date.now();live={...live,...result.data,status:'recording',reason:''};await save();
      return live;
    } catch(error) {await stop(error.message,true);throw error;}
  }
  async function chunk(message) {
    if(!['recording','stopping'].includes(live.status)||message.sessionId!==live.sessionId)throw new Error('Capture is no longer active.');
    if(busy||message.sequence!==sequence||typeof message.pcm!=='string'||message.pcm.length>43000)throw new Error('Audio transport lost continuity. Capture stopped.');
    busy=true;
    try {
      const currentTab=await chrome.tabs.get(live.tabId);
      if(currentTab.url!==live.pageUrl)throw new Error('The page changed. Start again to transcribe the new source.');
      const current=await inspect(live.tabId);
      const elapsed=(Date.now()-source.checked)/1000;
      if(current.protected||current.ad||current.src!==source.src||current.rate!==source.rate||
        (Number.isFinite(current.time)&&Number.isFinite(source.time)&&Math.abs(current.time-source.time-(source.paused?0:elapsed*source.rate))>2.5))
        throw new Error('Playback changed, sought, or entered an advertisement. Start a new transcript to keep coverage clear.');
      source={...current,checked:Date.now()};
      const result=await captureRequest('browser-chunk',{sessionId:live.sessionId,sequence,pcm:message.pcm,queuedSeconds:message.queuedSeconds||0},100000);
      sequence++;live={...live,...result.data,status:live.status,queuedSeconds:message.queuedSeconds||0};await save();
      return {sequence:message.sequence};
    } catch(error){setTimeout(()=>stop(error.message,true),0);throw error;}
    finally{busy=false;}
  }
  async function generate() {
    if(active.has(live.status))throw new Error('Stop live transcription before generating a whole-media transcript.');
    if(['saving','processing'].includes(whole.status))throw new Error('Whole-media transcription is already running.');
    const previous=whole;
    whole={status:'saving',reason:'Saving accessible audio to your library…'};await save();
    try{
      const {url,source:media,title}=await generateSource();
      const pageUrl=media?.pageUrl||url;
      if(previous.status==='ready'&&previous.sourceUrl===pageUrl&&previous.itemId){whole=previous;await save();return whole;}
      const saved=await request('download',{url,source:media,title,kind:'audio',quality:'192'},21610000);
      if(saved.event!=='complete')throw new Error('The audio was not saved.');
      whole={status:'processing',itemId:saved.id,sourceUrl:pageUrl,reason:'Generating a transcript from the saved audio…'};await save();
      const submitted=await request('browser-study',{itemId:saved.id},90000);
      whole={...whole,...submitted.data,status:'processing'};await save();
      pollWhole();
    }catch(error){whole={...whole,status:'error',reason:error.message};await save();}
    return whole;
  }
  async function pollWhole(){
    if(checking||whole.status!=='processing'||!whole.itemId)return;
    checking=true;
    try{
      const result=await request('browser-study-status',{itemId:whole.itemId},60000);
      // Study's status='ready' describes its response envelope, not completion
      // of the speech job. Keep polling until real tracks or a terminal state.
      whole={...whole,...result.data,status:'processing'};
      if(whole.tracks?.some(t=>t.cues?.length||t.text)){whole.status='ready';whole.reason='Generated transcript saved with its audio in Desktop.';}
      else if(['failed','worker_failed','interrupted','partial'].includes(whole.state)){whole.status='error';whole.reason=whole.error||'Open Desktop to inspect or resume this partial task.';}
      else if(['complete','evidence_ready'].includes(whole.state)){whole.status='ready';whole.reason='No speech text was returned for this audio.';}
      await save();
    }catch(error){whole={...whole,status:'error',reason:error.message};await save();}
    finally{checking=false;}
    if(whole.status==='processing')setTimeout(pollWhole,5000);
  }
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(message?.target!=='framekeep-browser')return;
    const offscreen=sender.id===chrome.runtime.id&&sender.url===root+'browser-audio.html';
    const ui=extensionUI(sender);
    const ownTab=sender.id===chrome.runtime.id&&sender.tab?.id===live.tabId;
    const contentStop=sender.id===chrome.runtime.id&&sender.tab&&message.action==='stop'&&(ownTab||!active.has(live.status));
    if(!ui&&!(offscreen&&['chunk','fault','heartbeat'].includes(message.action))&&!contentStop){respond({error:'Only the selected tab can stop this capture. Open the Framekeep toolbar for its recording tab.'});return;}
    (async()=>{
      await ready;
      if(message.action==='state'){pollWhole();return {live,whole};}
      if(message.action==='start')return {live:await start(message.language),whole};
      if(message.action==='stop')return {live:await stop(message.reason||'Stopped by you.'),whole};
      if(message.action==='continue-hidden'){live={...live,keepOnPanelClose:message.enabled===true};await save();return {live,whole};}
      if(message.action==='chunk')return await chunk(message);
      if(message.action==='heartbeat')return {active:['recording','stopping'].includes(live.status)&&live.sessionId===message.sessionId};
      if(message.action==='fault'){
        if(message.sessionId!==live.sessionId)return {ignored:true};
        return {live:await stop(message.reason||'Audio capture lost continuity.',true,message.droppedChunks||0)};
      }
      if(message.action==='generate')return {whole:await generate()};
      if(message.action==='captions')return {captions:await captions()};
      if(message.action==='desktop'){await request('desktop',{},10000);return {};}
      throw new Error('Unknown browser transcription action.');
    })().then(data=>respond({ok:true,...data})).catch(error=>respond({error:error.message}));
    return true;
  });
  chrome.runtime.onConnect.addListener(port=>{
    if(port.name!=='framekeep-browser-panel'||!extensionUI(port.sender))return;
    port.onDisconnect.addListener(()=>{if(active.has(live.status)&&!live.keepOnPanelClose)stop('Panel closed. Partial transcript saved.');});
  });
  chrome.tabs.onRemoved.addListener(id=>{if(live.tabId===id)stop('The captured tab closed.',true);});
  chrome.tabs.onUpdated.addListener((id,change)=>{if(id===live.tabId&&change.url&&change.url!==live.pageUrl)stop('The captured page changed. Start again for the new source.',true);});
  return {isActive:()=>active.has(live.status), disconnected:()=>stop('The local component disconnected. Capture stopped; partial text is preserved.',true,0,true)};
}
