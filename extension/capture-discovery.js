// Shared in the isolated content world and the worker. No page scripts or request history.
(() => {
  const extensions = {jpg:'image',jpeg:'image',png:'image',webp:'image',gif:'image',avif:'image',bmp:'image',svg:'image',mp4:'video',m4v:'video',webm:'video',mov:'video',mp3:'audio',m4a:'audio',aac:'audio',ogg:'audio',wav:'audio',flac:'audio',opus:'audio'};
  function address(value, base) {
    if (typeof value !== 'string' || !value || value.length > 8192) return null;
    try {
      const url = new URL(value, base || undefined);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      url.hash = ''; return url;
    } catch { return null; }
  }
  function item(value, base, type, properties = {}) {
    const url = address(value, base); if (!url) return null;
    const ext = url.pathname.split('.').pop().toLowerCase();
    const kind = type==='audio' ? 'audio' : extensions[ext] || type;
    if (!['image','audio','video'].includes(kind)) return null;
    let filename; try { filename = decodeURIComponent(url.pathname.split('/').pop()); } catch {}
    return {url:url.href, kind, filename:(filename || kind).slice(0,180), source:url.hostname,
      format:extensions[ext] ? ext.toUpperCase() : kind.toUpperCase(),
      sanitization:kind === 'image' ? (['jpg','jpeg','png'].includes(ext) ? 'automatic' : 'by-format') : 'original',
      width:Number(properties.width) || 0, height:Number(properties.height) || 0,
      title:String(properties.title || filename || kind).slice(0,160), thumbnail:kind === 'image' ? url.href : '',
      ...(['m3u8','mpd'].includes(ext) ? {stream:true,sourceType:'direct'} : {})};
  }
  function youtubePage(value, base) {
    const url=address(value,base); if(!url)return null;
    const host=url.hostname, parts=url.pathname.split('/').filter(Boolean);
    let id;
    if(host==='youtu.be' && parts.length===1)id=parts[0];
    else if(['youtube.com','youtube-nocookie.com'].some(h=>host===h||host.endsWith('.'+h))) {
      if(url.pathname==='/watch')id=url.searchParams.get('v');
      else if(['shorts','live','embed'].includes(parts[0])&&parts.length===2)id=parts[1];
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id||'') ? {url:`https://www.youtube.com/watch?v=${id}`,thumbnail:`https://i.ytimg.com/vi/${id}/hqdefault.jpg`} : null;
  }
  function spotifyEpisode(value, base) {
    const url=address(value,base);
    const match=url?.hostname==='open.spotify.com'&&/^\/(?:intl-[a-z-]+\/)?(?:embed\/)?episode\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname);
    return match ? {url:`https://open.spotify.com/episode/${match[1]}`} : null;
  }
  function player(value, base, properties={}) {
    const url=address(value,base);if(!url)return null;
    const youtube=youtubePage(url.href), title=String(properties.title||'Page video').trim().slice(0,160);
    const spotify=spotifyEpisode(url.href),kind=spotify||properties.kind==='audio'?'audio':'video';
    return {...item(youtube?.url||spotify?.url||url.href,base,kind,properties),kind,filename:title,title,
      format:youtube?'YouTube':spotify?'Spotify podcast':kind==='audio'?'Audio player':'Video player',stream:true,sourceType:properties.sourceType||'page',
      thumbnail:youtube?.thumbnail||properties.thumbnail||'',sanitization:'original'};
  }
  function poster(media, doc) {
    const url=address(media.poster,doc.baseURI);if(url)return url.href;
    // Preview only: never download a canvas or inspect player scripts.
    if(media.readyState>=2&&media.videoWidth&&!media.mediaKeys)try {
      const canvas=doc.createElement('canvas');canvas.width=480;canvas.height=Math.round(480*media.videoHeight/media.videoWidth);
      if(canvas.height>0&&canvas.height<=960){canvas.getContext('2d').drawImage(media,0,0,canvas.width,canvas.height);return canvas.toDataURL('image/jpeg',.76);}
    }catch{}
    return '';
  }
  function discover(doc = document) {
    const found = new Map(); let truncated = false, protectedMedia = false, unavailable = 0;
    const add = (value, base, kind, props) => {
      if (/^(blob:|data:)/.test(value || '')) { unavailable++; return; }
      const candidate = item(value, base, kind, props); if (!candidate) return;
      if (found.has(candidate.url)) return;
      if (found.size >= 200) { truncated = true; return; }
      found.set(candidate.url, candidate);
    };
    const addPlayer=(value,base,props)=>{
      const candidate=player(value,base,props);if(!candidate)return;
      // Lazy placeholder images can resolve to the watch URL. A real player wins
      // that identity, and cannot disappear behind a page's first 200 images.
      if(found.get(candidate.url)?.stream)return;
      if(!found.has(candidate.url)&&found.size>=200){
        truncated=true;const replace=[...found.values()].reverse().find(i=>!i.stream);
        if(!replace)return;found.delete(replace.url);
      }
      found.set(candidate.url,candidate);
    };
    const scan = (root, base, depth = 0) => {
      if (depth > 4) return;
      for (const img of root.querySelectorAll('img')) {
        // currentSrc is the rendition the browser selected from picture/srcset.
        const declared=img.getAttribute('data-src')||img.getAttribute('data-original')||img.getAttribute('src');
        if(!declared?.trim()&&!img.srcset&&!img.closest('picture'))continue;
        const src = img.currentSrc || declared;
        if (img.naturalWidth && img.naturalWidth <= 2 && img.naturalHeight <= 2) continue;
        add(src, base, 'image', {width:img.naturalWidth, height:img.naturalHeight, title:img.alt || img.title});
      }
      for (const media of root.querySelectorAll('video, audio')) {
        if (media.mediaKeys) { protectedMedia = true; continue; }
        const kind = media.tagName.toLowerCase();
        const owner=media.ownerDocument||doc, pageUrl=owner.location?.href||base;
        const props = {width:media.videoWidth,height:media.videoHeight,title:media.title||owner.title};
        const source=media.currentSrc || media.src, youtube=kind==='video'&&youtubePage(pageUrl);
        if(youtube || spotifyEpisode(pageUrl) || /^blob:/.test(source||'')) {
          addPlayer(pageUrl,base,{...props,kind,thumbnail:poster(media,owner)});
        } else {
          add(source, base, kind, props);
          const direct=address(source,base);if(direct&&found.has(direct.href)&&kind==='video')found.get(direct.href).thumbnail=poster(media,owner);
        }
        if (!media.currentSrc && !media.src) for (const source of media.querySelectorAll('source[src]')) add(source.src,base,kind,props);
        if (media.poster) add(media.poster,base,'image',{title:'Video poster'});
      }
      for (const link of root.querySelectorAll('a[href]')) {
        const url = address(link.href,base), ext = url?.pathname.split('.').pop().toLowerCase();
        if (extensions[ext]) add(url.href,base,extensions[ext],{title:link.getAttribute('download') || link.textContent?.trim()});
      }
      for (const element of root.querySelectorAll('*')) {
        if (element.id === 'framekeep-widget') continue;
        if (element.shadowRoot) scan(element.shadowRoot,base,depth+1);
        if (element.tagName === 'IFRAME') {
          const frame=address(element.src,base);
          if(frame&&(youtubePage(frame.href)||spotifyEpisode(frame.href)||(/^\/video\/\d+/.test(frame.pathname)&&frame.hostname==='player.vimeo.com')))
            addPlayer(frame.href,base,{title:element.title||'Embedded video',sourceType:'embed'});
          try { if (element.contentDocument) scan(element.contentDocument,element.contentDocument.baseURI,depth+1); } catch {}
        }
      }
    };
    scan(doc,doc.baseURI);
    // A watch/Short page is a video even before its lazy player exposes a source.
    if(!protectedMedia && youtubePage(doc.location?.href||doc.baseURI))addPlayer(doc.location?.href||doc.baseURI,doc.baseURI,{title:doc.title});
    // Podcast identity remains visible when Spotify renders no <audio>, or its
    // encrypted player has mediaKeys. The helper checks only public full files.
    if(spotifyEpisode(doc.location?.href||doc.baseURI))addPlayer(doc.location?.href||doc.baseURI,doc.baseURI,{kind:'audio',title:doc.title,thumbnail:address(doc.querySelector('meta[property="og:image"]')?.content,doc.baseURI)?.href});
    return {items:[...found.values()].sort((a,b)=>Number(!!b.stream)-Number(!!a.stream)),truncated,protectedMedia,unavailable};
  }
  function forFilter(items,filter) {
    if(filter!=='audio')return items.filter(i=>filter==='all'||i.kind===filter);
    return items.filter(i=>i.kind==='audio'||(i.kind==='video'&&(i.stream||/\.(mp4|m4v|webm|mov)$/i.test(new URL(i.url).pathname)))).map(i=>i.kind==='audio'?i:{...i,kind:'audio',stream:true,sourceType:i.sourceType||'direct',audioFromVideo:true});
  }
  globalThis.FramekeepCapture = {address,item,discover,youtubePage,spotifyEpisode,player,forFilter,poster};
})();
