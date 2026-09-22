(() => {
  if (window !== top || document.getElementById('framekeep-widget')) return;
  const host=document.createElement('div'); host.id='framekeep-widget';
  // Isolate styling while keeping standard DOM controls accessible to assistive tools.
  const root=host.attachShadow({mode:'open'});
  const style=document.createElement('link'); style.rel='stylesheet';style.href=chrome.runtime.getURL('floating.css');root.append(style);
  const html=document.createElement('div');
  html.innerHTML=`<button class="bubble" aria-label="Open Framekeep" aria-expanded="false" title="Framekeep · Click to open, drag to move"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3M12 7v10m-4-4 4 4 4-4"/></svg><span class="badge" hidden></span></button>
  <section class="panel" role="dialog" aria-label="Framekeep media capture" hidden>
    <header><div class="brand"><div class="wordmark">framekeep<span>.</span></div><p class="page-name"></p></div><button class="refresh icon" data-action="refresh" title="Refresh media" aria-label="Refresh media">↻</button><button class="icon" data-action="expand" aria-label="Expand panel" title="Expand panel">⤢</button><button class="icon" data-action="settings" aria-label="Bubble settings" title="Bubble settings">⋯</button><button class="icon" data-action="close" aria-label="Close panel">×</button></header>
    <div class="settings" hidden><button data-action="compact">Use compact bubble</button><button data-action="hide">Hide until next visit</button><button data-action="disable">Disable on this site</button><p>Restore from Framekeep’s toolbar → Show page bubble.</p></div>
    <nav aria-label="Filter media"><button data-filter="all" class="selected">All <span></span></button><button data-filter="image">Images <span></span></button><button data-filter="video">Video <span></span></button><button data-filter="audio">Audio <span></span></button></nav>
    <div class="selection"><label><input type="checkbox" class="select-all"> <span>Select all</span></label><span class="count"></span></div>
    <div class="media-area"><div class="grid"></div><p class="empty" hidden>No media found yet.<br>Play audio or video, or scroll to load images.<br><button data-action="video-tools">Check a media player ↗</button></p></div>
    <div class="preview" hidden><button data-action="preview-close" class="icon" aria-label="Close preview">×</button><img alt="Media preview" referrerpolicy="no-referrer"><p></p></div>
    <div class="bottom"><div class="download-actions"><button class="primary" data-action="download"><b>Download selected</b> <span>0</span></button><button class="secondary" data-action="download-all">Download all</button></div><label class="clean-note">Image handling <select aria-label="Image handling"><option value="original">Original copies · metadata retained</option><option value="sanitize">Clean PNG/JPEG (optional local tool)</option></select></label><p class="status" role="status" aria-live="polite"></p><p class="limits" hidden></p><div class="links"><button data-action="video-tools">Media tools ↗</button><button data-action="folder">Open save folder ↗</button></div></div>
  </section>`;
  root.append(html);document.documentElement.append(host);
  const $=s=>root.querySelector(s), all=s=>[...root.querySelectorAll(s)], bubble=$('.bubble'), panel=$('.panel');
  const siteKey='framekeep.site.'+location.hostname, selected=new Set();
  let prefs={x:1,y:.66,compact:false,expanded:false}, items=[],pageItems=[],frameItems=[],framePage='',filter='all',opened=false,port,portUrl,drag,dragged=false,busy=false,lastRun,changed=false;
  function connect() {
    if(port&&portUrl===location.href)return port;
    if(port){const previous=port;port=null;previous.disconnect();}
    port=chrome.runtime.connect({name:'framekeep-capture'});
    portUrl=location.href;
    const connected=port;
    port.onMessage.addListener(message=>{
      if(message.error){$('.status').textContent=message.error;return;}
      if(message.frameItems&&message.pageUrl===location.href){if(framePage===location.href&&JSON.stringify(frameItems)===JSON.stringify(message.frameItems))return;frameItems=message.frameItems;framePage=location.href;mergeItems();render();return;}
      if(!message.run)return;
      lastRun=message.run;busy=lastRun.status==='working';
      $('.status').textContent=lastRun.status==='complete' ? `${lastRun.count} file${lastRun.count===1?'':'s'} saved · ${lastRun.files?.filter(f=>f.sanitized).length || 0} cleaned` : lastRun.error || lastRun.detail;
      bubble.classList.toggle('working',busy); updateSelection();
    });
    port.onDisconnect.addListener(()=>{void chrome.runtime.lastError;if(port!==connected)return;port=null;if(opened){$('.status').textContent='Framekeep reloaded. Refresh this page to reconnect.';}});
    port.postMessage({action:'init'});return port;
  }
  function send(message){try{connect().postMessage({...message,pageUrl:location.href});}catch{$('.status').textContent='Refresh this page to reconnect Framekeep.';}}
  function position() {
    const size=prefs.compact?32:48, margin=12;
    const x=margin+Math.max(0,innerWidth-size-margin*2)*prefs.x,y=margin+Math.max(0,innerHeight-size-margin*2)*prefs.y;
    host.style.cssText=`all:initial;display:${host.hidden?'none':'block'};position:fixed;left:${Math.round(x)}px;top:${Math.round(y)}px;width:${size}px;height:${size}px;z-index:2147483647;color-scheme:light;`;
    bubble.classList.toggle('compact',prefs.compact);
    const width=Math.min(prefs.expanded?720:480,innerWidth-24),height=Math.min(prefs.expanded?900:740,innerHeight-24);
    let left=Math.max(12,Math.min(innerWidth-width-12,prefs.x>.5?x+size-width:x));
    const above=y-height-10,below=y+size+10;
    const top=above>=12?above:below+height<=innerHeight-12?below:Math.max(12,Math.min(innerHeight-height-12,y-120));
    if(above<12&&below+height>innerHeight-12){if(x-width-12>=12)left=x-width-12;else if(x+size+12+width<=innerWidth-12)left=x+size+12;}
    panel.style.cssText=`position:fixed;left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
    panel.classList.toggle('expanded',prefs.expanded);
    $('[data-action="expand"]').setAttribute('aria-label',prefs.expanded?'Restore panel size':'Expand panel');
    $('[data-action="expand"]').title=prefs.expanded?'Restore panel size':'Expand panel';
    $('[data-action="expand"]').setAttribute('aria-pressed',String(prefs.expanded));
  }
  const save=()=>chrome.storage.local.set({framekeepBubble:prefs}).catch(()=>{});
  function visible(){return FramekeepCapture.forFilter(items,filter);}
  function updateSelection(){
    const list=visible().filter(i=>!i.stream),checked=list.filter(i=>selected.has(i.url));
    $('.select-all').checked=!!list.length&&checked.length===list.length;$('.select-all').indeterminate=!!checked.length&&checked.length!==list.length;
    const onlyPlayer=!list.length&&visible().filter(i=>i.stream).length===1;
    $('.select-all').disabled=!list.length;$('.count').textContent=onlyPlayer?(visible()[0].kind==='audio'?'Audio ready to check':'Video ready to check'):`${selected.size} selected`;
    $('[data-action="download"] b').textContent=onlyPlayer&&!selected.size?(visible()[0].kind==='audio'?'Download audio':'Download video'):'Download selected';
    $('[data-action="download"] span').textContent=onlyPlayer&&!selected.size?'':selected.size;
    $('[data-action="download"]').disabled=busy||(!selected.size&&!onlyPlayer);
    $('[data-action="download-all"]').disabled=busy||!list.length;
    $('[data-action="download-all"]').hidden=!list.length&&visible().some(i=>i.stream);
    for(const card of all('.card'))card.classList.toggle('checked',selected.has(card.dataset.url));
  }
  function render(){
    for(const button of all('[data-filter]')) {button.classList.toggle('selected',button.dataset.filter===filter);button.setAttribute('aria-pressed',String(button.dataset.filter===filter));button.querySelector('span').textContent=button.dataset.filter==='all'?items.length:FramekeepCapture.forFilter(items,button.dataset.filter).length;}
    const list=visible();$('.grid').replaceChildren();$('.empty').hidden=!!list.length;
    for(const item of list){
      const card=document.createElement('article');card.className='card';card.dataset.url=item.url;
      const label=document.createElement('label');label.className='pick';
      const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=!item.stream&&selected.has(item.url);checkbox.disabled=!!item.stream;checkbox.setAttribute('aria-label','Select '+item.filename);
      checkbox.addEventListener('change',e=>{if(!e.isTrusted)return;if(checkbox.checked)selected.add(item.url);else selected.delete(item.url);updateSelection();});
      label.append(checkbox);label.hidden=!!item.stream;card.append(label);
      const preview=document.createElement('button');preview.className='thumb';preview.title=item.kind==='image'?'Preview '+item.filename:item.filename;
      if(item.thumbnail){const img=document.createElement('img');img.src=item.thumbnail;img.alt='';img.loading='lazy';img.referrerPolicy='no-referrer';img.addEventListener('error',()=>{img.remove();preview.textContent='Preview unavailable';});preview.append(img);}
      else preview.textContent=item.kind==='audio'?'♫':'▶';
      preview.setAttribute('aria-label',item.stream?'Download '+item.kind+': '+item.filename:'Preview '+item.filename);
      preview.addEventListener('click',e=>{if(!e.isTrusted)return;if(item.kind==='image'){$('.preview img').src=item.thumbnail;$('.preview p').textContent=item.filename+' · '+item.source;$('.preview').hidden=false;$('[data-action="preview-close"]').focus();}else if(item.stream)videoTools(item);else{if(selected.has(item.url))selected.delete(item.url);else selected.add(item.url);checkbox.checked=!item.stream&&selected.has(item.url);updateSelection();}});
      card.append(preview);
      const title=document.createElement('p');title.className='filename';title.textContent=item.filename;title.title=item.url;
      const details=document.createElement('p');details.className='meta';details.textContent=[item.format,item.width&&item.height?`${item.width} × ${item.height}`:'',item.stream?(item.audioFromVideo?'Extract audio from video · MP3':item.format==='Spotify podcast'?'Check public full-episode audio':'Choose '+item.kind+' quality'):$('.clean-note select').value==='original'?'Original copy':item.sanitization==='automatic'?'Auto clean':item.kind==='image'?'Clean PNG/JPEG':'Original'].filter(Boolean).join(' · ');
      const source=document.createElement('p');source.className='source';source.textContent=item.source;
      card.append(title,details,source);
      if(item.stream){card.classList.add('player-card');const action=document.createElement('button');action.className='player-action';action.textContent='Download '+item.kind+' ↗';action.addEventListener('click',e=>{if(e.isTrusted)videoTools(item);});card.append(action);}
      $('.grid').append(card);
    }updateSelection();
  }
  function videoTools(item){$('.status').textContent='Checking '+item.kind+' and opening download options…';send({action:'video-tools',url:item.url,sourceType:item.sourceType,title:item.title,kind:item.kind,frameId:item.frameId});}
  function mergeItems(){
    if(framePage!==location.href)frameItems=[];
    items=[...new Map([...pageItems,...frameItems].map(i=>[i.url,i])).values()].sort((a,b)=>Number(!!b.stream)-Number(!!a.stream));
    $('.badge').textContent=items.length;$('.badge').hidden=!items.length;
    for(const url of selected)if(!items.some(i=>i.url===url&&!i.stream))selected.delete(url);
  }
  function scan(){
    const result=FramekeepCapture.discover();pageItems=result.items;mergeItems();
    send({action:'discover-frames'});
    for(const url of selected)if(!items.some(i=>i.url===url))selected.delete(url);
    $('.page-name').textContent=location.hostname;$('.badge').textContent=items.length;$('.badge').hidden=!items.length;
    const notes=[];if(result.truncated)notes.push('Showing the first 200 media links.');if(result.protectedMedia)notes.push('Protected players are excluded.');if(result.unavailable)notes.push('Some inline media has no downloadable file.');
    $('.limits').textContent=notes.join(' ');$('.limits').hidden=!notes.length;changed=false;render();
  }
  function open(value){opened=value;panel.hidden=!value;bubble.setAttribute('aria-expanded',String(value));if(value){position();scan();connect();$('[data-action="refresh"]').focus();}else{bubble.focus();$('.preview').hidden=true;}}
  bubble.addEventListener('pointerdown',e=>{if(!e.isTrusted||e.button!==0)return;drag={x:e.clientX,y:e.clientY,left:parseFloat(host.style.left),top:parseFloat(host.style.top)};dragged=false;bubble.setPointerCapture(e.pointerId);});
  bubble.addEventListener('pointermove',e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.hypot(dx,dy)>5)dragged=true;if(!dragged)return;const size=prefs.compact?32:48;prefs.x=Math.max(0,Math.min(1,(drag.left+dx-12)/Math.max(1,innerWidth-size-24)));prefs.y=Math.max(0,Math.min(1,(drag.top+dy-12)/Math.max(1,innerHeight-size-24)));position();});
  bubble.addEventListener('pointerup',()=>{if(dragged)save();drag=null;});bubble.addEventListener('pointercancel',()=>{drag=null;});
  bubble.addEventListener('click',e=>{if(!e.isTrusted||(dragged&&e.detail!==0))return;open(!opened);});
  bubble.addEventListener('keydown',e=>{if(!e.isTrusted)return;if(e.altKey&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();if(e.key==='ArrowLeft')prefs.x=Math.max(0,prefs.x-.05);if(e.key==='ArrowRight')prefs.x=Math.min(1,prefs.x+.05);if(e.key==='ArrowUp')prefs.y=Math.max(0,prefs.y-.05);if(e.key==='ArrowDown')prefs.y=Math.min(1,prefs.y+.05);position();save();}});
  root.addEventListener('keydown',e=>{if(e.key==='Escape'){if(!$('.preview').hidden){$('.preview').hidden=true;}else open(false);e.stopPropagation();}});
  root.addEventListener('click',async e=>{
    if(!e.isTrusted)return;const target=e.target.closest('button');if(!target)return;
    if(target.dataset.filter){filter=target.dataset.filter;render();return;}
    switch(target.dataset.action){
      case 'close':open(false);break;
      case 'settings':$('.settings').hidden=!$('.settings').hidden;break;
      case 'expand':prefs.expanded=!prefs.expanded;position();save();break;
      case 'compact':prefs.compact=!prefs.compact;target.textContent=prefs.compact?'Use full bubble':'Use compact bubble';position();save();break;
      case 'hide':host.hidden=true;opened=false;position();break;
      case 'disable':await chrome.storage.local.set({[siteKey]:{disabled:true}});host.hidden=true;opened=false;position();break;
      case 'refresh':scan();break;
      case 'preview-close':$('.preview').hidden=true;break;
      case 'download':case 'download-all':{
        if(target.dataset.action==='download'&&!selected.size&&visible().filter(i=>i.stream).length===1){videoTools(visible().find(i=>i.stream));break;}
        const chosen=(target.dataset.action==='download-all'?visible():items.filter(i=>selected.has(i.url))).filter(i=>!i.stream);
        if(chosen.length>100){$('.status').textContent='Select up to 100 items for each batch.';break;}
        if(!chosen.length||busy)break;
        $('.status').textContent='Starting your batch…';send({action:'capture',imageMode:$('.clean-note select').value,items:chosen.map(({url,kind})=>({url,kind}))});break;
      }
      case 'video-tools':case 'folder':send({action:target.dataset.action,kind:filter==='audio'?'audio':'video'});break;
    }
  });
  $('.select-all').addEventListener('change',e=>{if(!e.isTrusted)return;for(const item of visible().filter(i=>!i.stream)){if(e.target.checked)selected.add(item.url);else selected.delete(item.url);}render();});
  $('.clean-note select').addEventListener('change',render);
  document.addEventListener('pointerdown',e=>{if(opened&&!e.composedPath().includes(host))open(false);},true);
  window.addEventListener('resize',position);
  // Only rescan while the panel is visible. Mutation callbacks never fetch or download.
  let refreshTimer;new MutationObserver(records=>{if(!opened||!records.some(r=>!host.contains(r.target)))return;changed=true;clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{if(opened&&changed)scan();},700);}).observe(document.body||document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src','srcset','data-src','poster']});
  const playerChanged=()=>{if(opened){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{if(opened)scan();},150);}};
  for(const event of ['loadedmetadata','play','yt-navigate-finish'])document.addEventListener(event,playerChanged,true);
  window.addEventListener('popstate',playerChanged);window.addEventListener('hashchange',playerChanged);
  setInterval(()=>{if(opened&&!document.hidden)send({action:'discover-frames'});},2500);
  chrome.runtime.onMessage.addListener((m,sender,reply)=>{if(sender.id!==chrome.runtime.id)return;if(m.action==='show-framekeep'){chrome.storage.local.remove(siteKey).catch(()=>{});host.hidden=false;position();open(true);reply({shown:true});}});
  chrome.storage.local.get(['framekeepBubble',siteKey]).then(saved=>{const p=saved.framekeepBubble||{};prefs={x:Number.isFinite(p.x)?Math.max(0,Math.min(1,p.x)):1,y:Number.isFinite(p.y)?Math.max(0,Math.min(1,p.y)):.66,compact:!!p.compact,expanded:!!p.expanded};host.hidden=!!saved[siteKey]?.disabled;position();}).catch(position);
  position();
})();
