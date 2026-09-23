let capture=null;
const send=message=>chrome.runtime.sendMessage({target:'framekeep-browser',...message});
function cleanup(){
  const previous=capture;capture=null;if(!previous)return;
  clearInterval(previous.heartbeat);
  previous.stream.getTracks().forEach(track=>track.stop());
  previous.input.disconnect();previous.node.disconnect();previous.context.close().catch(()=>{});
}
async function fault(reason,state=capture){
  if(!state||capture!==state)return;
  const sid=state.sessionId,droppedChunks=state.queue.length;cleanup();
  if(sid)await send({action:'fault',sessionId:sid,reason,droppedChunks}).catch(()=>{});
}
async function pump(state){
  if(state.busy||capture!==state)return;
  state.busy=true;
  try{
    while(state.queue.length&&capture===state){
      const bytes=new Uint8Array(state.queue.shift());
      let binary='';for(let i=0;i<bytes.length;i++)binary+=String.fromCharCode(bytes[i]);
      let timeout;
      let result;
      try{result=await Promise.race([send({action:'chunk',sessionId:state.sessionId,sequence:state.sequence,pcm:btoa(binary),queuedSeconds:state.queue.length}),
        new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Local transcription is not responding.')),105000);})]);}
      finally{clearTimeout(timeout);}
      if(result?.error||result?.sequence!==state.sequence)throw new Error(result?.error||'Audio transport disconnected.');
      state.sequence++;
    }
  }catch(error){await fault(error.message,state);}
  finally{state.busy=false;}
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message?.target!=='framekeep-offscreen'||sender.id!==chrome.runtime.id||(sender.url&&sender.url!==chrome.runtime.getURL('background.js')))return;
  (async()=>{
    if(message.action==='stop'){
      const state=capture;
      if(!state)return {stopped:true,droppedChunks:0};
      if(message.sessionId!==state.sessionId)return {stopped:false,ignored:true};
      state.stopping=true;
      state.stream.getTracks().forEach(track=>track.stop());
      if(message.discard){const droppedChunks=state.queue.length;cleanup();return {stopped:true,droppedChunks};}
      await new Promise(resolve=>{state.flushed=resolve;state.node.port.postMessage('flush');setTimeout(resolve,1000);});
      for(let i=0;capture===state&&(state.busy||state.queue.length)&&i<1100;i++)await new Promise(resolve=>setTimeout(resolve,100));
      const droppedChunks=state.queue.length;cleanup();return {stopped:true,droppedChunks};
    }
    if(message.action!=='start')throw new Error('Invalid audio action.');
    if(capture)throw new Error('A tab is already being captured.');
    const stream=await navigator.mediaDevices.getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:message.streamId}},video:false});
    const context=new AudioContext();
    try{
      await context.audioWorklet.addModule('browser-audio-worklet.js');
      const input=context.createMediaStreamSource(stream),node=new AudioWorkletNode(context,'framekeep-pcm');
      // Chrome suppresses tab output during capture. Route it back to keep it audible.
      input.connect(context.destination);input.connect(node);node.connect(context.destination);
      const state=capture={sessionId:message.sessionId,stream,context,input,node,queue:[],busy:false,sequence:0};
      node.port.onmessage=event=>{
        if(capture!==state)return;
        if(event.data?.flushed){state.flushed?.();return;}
        if(state.queue.length>=20){fault('Processing fell more than 20 seconds behind. Capture stopped; saved partial text remains available.',state);return;}
        state.queue.push(event.data);pump(state);
      };
      stream.getAudioTracks().forEach(track=>track.onended=()=>{if(capture===state&&!state.stopping)fault('Chrome ended tab-audio capture.',state);});
      state.heartbeat=setInterval(async()=>{
        try{const result=await send({action:'heartbeat',sessionId:state.sessionId});if(capture===state&&!result?.active)cleanup();}
        catch{if(capture===state)cleanup();}
      },3000);
      await context.resume();return {started:true};
    }catch(error){stream.getTracks().forEach(track=>track.stop());await context.close();throw error;}
  })().then(respond).catch(error=>respond({error:error.message}));
  return true;
});
