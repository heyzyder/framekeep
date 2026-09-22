// Isolated-world responder. Only the extension can request a scan; no background
// capture, account APIs, page script state, or native downloads run in frames.
(() => {
  if(window===top)return;
  const previews=new Map();
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(sender.id!==chrome.runtime.id||message.action!=='framekeep-frame-scan')return;
    const items=new Map();let protectedMedia=false,blobKind,blobProps;
    const add=(value,kind,props={})=>{
      const item=FramekeepCapture.item(value,document.baseURI,kind,props);
      if(!item||item.kind==='image'||items.size>=20)return;
      items.set(item.url,{...item,sourceType:'direct',stream:item.stream||item.kind==='video',thumbnail:props.thumbnail||'',title:document.title.slice(0,160)});
    };
    function scan(root,depth=0){
      if(depth>4)return;
      for(const media of root.querySelectorAll('video,audio')){
        if(media.mediaKeys){protectedMedia=true;continue;}
        const kind=media.tagName.toLowerCase(),src=media.currentSrc||media.getAttribute('src');
        const props={title:document.title,width:media.videoWidth,height:media.videoHeight};
        if(kind==='video'){
          props.thumbnail=previews.get(src)||FramekeepCapture.poster(media,document);
          if(props.thumbnail){previews.set(src,props.thumbnail);if(previews.size>20)previews.delete(previews.keys().next().value);}
        }
        if(/^blob:/.test(src||'')){blobKind=kind;blobProps=props;}
        else if(src)add(src,kind,props);
        if(!src)for(const source of media.querySelectorAll('source[src]'))add(source.src,kind,props);
      }
      for(const element of root.querySelectorAll('*'))if(element.shadowRoot)scan(element.shadowRoot,depth+1);
    }
    scan(document);
    // MSE players expose a blob URL in the DOM. Their bounded current-document
    // resource timings identify manifests, never fragments, keys or credentials.
    if(blobKind&&!protectedMedia&&!items.size){
      const manifests=[...new Set(performance.getEntriesByType('resource').filter(e=>/\.(m3u8|mpd)(?:[?#]|$)/i.test(e.name)).slice(-20).map(e=>e.name))];
      for(const url of manifests.filter(url=>!manifests.some(master=>master!==url&&/\/(master|playlist|manifest)\.(m3u8|mpd)(?:[?#]|$)/i.test(master)&&new URL(url).href.startsWith(new URL('.',master).href))).slice(-8))add(url,blobKind,blobProps);
    }
    reply({pageUrl:location.href,items:[...items.values()],protectedMedia});
  });
})();
