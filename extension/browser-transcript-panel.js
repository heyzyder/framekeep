const $=id=>document.getElementById(id);
let live={status:'idle'},whole={status:'idle'},captions=null,view='live',rows=[];
const panelPort=chrome.runtime.connect({name:'framekeep-browser-panel'});
panelPort.onDisconnect.addListener(()=>{$('error').textContent='The extension connection ended. Capture will stop; reopen Framekeep.';$('error').hidden=false;});
const active=new Set(['preparing','recording','stopping']);
const time=seconds=>{const s=Math.floor(Math.max(0,seconds));return s>=3600?`${Math.floor(s/3600)}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`:`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;};
async function call(action,data={}){
  $('error').hidden=true;
  try{
    const result=await chrome.runtime.sendMessage({target:'framekeep-browser',action,...data});
    if(!result||result.error)throw new Error(result?.error||'The extension connection closed. Reopen the Framekeep toolbar.');
    if(result.live)live=result.live;if(result.whole)whole=result.whole;if(result.captions)captions=result.captions;
    render();return result;
  }catch(error){$('error').textContent=error.message;$('error').hidden=false;throw error;}
}
function render(){
  const recording=active.has(live.status);
  $('startLive').disabled=recording||['saving','processing'].includes(whole.status);$('language').disabled=recording;$('stopLive').hidden=!recording;
  $('continueHidden').checked=!!live.keepOnPanelClose;$('continueHidden').disabled=!recording||live.status==='stopping';
  $('stopLive').disabled=live.status==='stopping';$('stopLive').textContent=live.status==='stopping'?'Saving partial transcript…':'Stop capture';
  $('liveStatus').textContent=live.status==='recording'?`● Recording ${live.title||'selected tab'} · ${time(live.seconds||0)} captured`:live.status==='preparing'?'Loading your local speech model before capture…':live.reason||'Ready. Choose Start to capture only the selected tab.';
  if(live.coverage)$('coverage').textContent=live.coverage;
  $('wholeMedia').disabled=['saving','processing'].includes(whole.status)||recording;
  $('resultTitle').textContent=view==='captions'?'Site captions':view==='whole'?'Generated media transcript':'Live transcript';
  const wholeTrack=whole.tracks?.[0];
  rows=view==='captions'?(captions?.cues||[]):view==='whole'?(wholeTrack?.cues?.length?wholeTrack.cues:wholeTrack?.text?[{text:wholeTrack.text}]:[]):live.cues||[];
  $('resultStatus').textContent=view==='captions'?(rows.length?`${captions.language||'Source'} · original site captions`:'This source did not provide a usable caption track.'):view==='whole'?(whole.reason||whole.state||''):(rows.length?'Settled text · saved incrementally to Desktop':recording?'Listening for speech. First text appears after a short audio window is processed.':'Start capture to see incremental text here.');
  const query=$('search').value.trim().toLocaleLowerCase(),fragment=document.createDocumentFragment();
  for(const row of rows.filter(r=>!query||r.text.toLocaleLowerCase().includes(query))){
    const li=document.createElement('li'),stamp=document.createElement('time');
    if(Number.isFinite(row.start)){stamp.textContent=time(row.start);li.append(stamp);}
    li.append(document.createTextNode(row.text));fragment.append(li);
  }
  $('cues').replaceChildren(fragment);
  $('provisional').textContent=view==='live'&&live.provisional?.length?'Provisional: '+live.provisional.map(c=>c.text).join(' '):'';
  const m=live.metrics||{};
  $('metrics').textContent=`First settled text: ${m.firstTextSeconds==null?'not observed':m.firstTextSeconds+' s'}. Last / longest inference: ${m.processingSeconds||0} / ${m.maxProcessingSeconds||0} s. Queued audio now / maximum: ${live.queuedSeconds||0} / ${m.maxQueuedSeconds||0} s. Dropped chunks: ${m.droppedChunks||0}. Failed chunks: ${m.failedChunks||0}. Times are measured, not a promised delay.`;
  $('copy').disabled=$('export').disabled=!rows.length;
}
$('startLive').onclick=()=>{view='live';call('start',{language:$('language').value}).catch(()=>{});};
$('stopLive').onclick=()=>call('stop').catch(()=>{});
$('continueHidden').onchange=()=>call('continue-hidden',{enabled:$('continueHidden').checked}).catch(()=>{});
$('siteCaptions').onclick=()=>{view='captions';$('resultStatus').textContent='Loading available site captions…';call('captions').catch(()=>{});};
$('wholeMedia').onclick=()=>{view='whole';call('generate').catch(()=>{});};
$('openDesktop').onclick=()=>call('desktop').catch(()=>{});
$('search').oninput=render;
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText(rows.map(r=>r.text).join('\n'));$('resultStatus').textContent='Transcript copied.';}catch{$('error').textContent='Chrome could not copy. Use Export TXT.';$('error').hidden=false;}};
$('export').onclick=()=>{const text=rows.map(r=>(Number.isFinite(r.start)?time(r.start)+'  ':'')+r.text).join('\n');const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='framekeep-'+view+'-transcript.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
chrome.runtime.onMessage.addListener((message,sender)=>{if(sender.id===chrome.runtime.id&&message.target==='framekeep-browser-ui'){live=message.live;whole=message.whole;render();}});
call('state').catch(()=>{});
