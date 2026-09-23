// Resampling happens in the audio rendering thread; messages are <= one second.
class FramekeepPCM extends AudioWorkletProcessor {
  constructor(){super();this.samples=new Int16Array(16000);this.index=0;this.phase=0;this.sum=0;this.count=0;this.stopped=false;this.port.onmessage=event=>{if(event.data==='flush'){this.stopped=true;if(this.index){const tail=this.samples.slice(0,this.index);this.port.postMessage(tail.buffer,[tail.buffer]);}this.port.postMessage({flushed:true});}};}
  process(inputs){
    const channels=inputs[0];if(this.stopped||!channels?.length)return true;
    for(let i=0;i<channels[0].length;i++){
      let sample=0;for(const channel of channels)sample+=channel[i]||0;sample/=channels.length;
      this.sum+=sample;this.count++;this.phase+=16000;
      if(this.phase>=sampleRate){
        const value=Math.max(-1,Math.min(1,this.sum/this.count));
        this.samples[this.index++]=Math.round(value*(value<0?32768:32767));
        this.phase-=sampleRate;this.sum=0;this.count=0;
        if(this.index===16000){this.port.postMessage(this.samples.buffer,[this.samples.buffer]);this.samples=new Int16Array(16000);this.index=0;}
      }
    }
    return true;
  }
}
registerProcessor('framekeep-pcm',FramekeepPCM);
