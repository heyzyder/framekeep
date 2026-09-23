"""Bounded native transport and durable incremental browser speech results."""
from __future__ import annotations
import base64
import json
import math
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import time
import wave
from library_state import identifier, source_url

RATE = 16000
MAX_CHUNK = RATE * 2  # One second; base64 plus envelope remains below host 64 KiB.
WINDOW = 6 * MAX_CHUNK
OVERLAP = MAX_CHUNK
MAX_SECONDS = 3600


def runtime_path(config):
    suite = Path(config.get('studySuite') or Path(os.environ.get('LOCALAPPDATA', '')) / 'CodexTools/study-suite/study_cli.py')
    return suite.parent.parent / 'video-study/venv/Scripts/python.exe'


def capability(config):
    ready = runtime_path(config).is_file()
    return {'available':ready,'engine':'faster-whisper','model':'large-v3-turbo','localOnly':True,
            'reason': 'Uses your installed local speech model. Model availability is checked before audio capture.' if ready else 'Install the optional local Study Suite speech component to generate browser transcripts. Source captions work without it.'}


class WarmEngine:
    def __init__(self, config):
        python = runtime_path(config)
        if not python.is_file(): raise ValueError(capability(config)['reason'])
        self.process = subprocess.Popen([str(python), '-B', '-u', str(Path(__file__).with_name('streaming_engine.py'))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding='utf-8', creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        self.responses = queue.Queue(maxsize=2)
        def read():
            try:
                for line in self.process.stdout:
                    if len(line) > 512000: break
                    self.responses.put(json.loads(line), timeout=5)
            except (ValueError, queue.Full): pass
            try: self.responses.put({'error':'The local speech process stopped.'}, timeout=1)
            except queue.Full: pass
        threading.Thread(target=read, daemon=True).start()
        try:
            self.info = self.receive(120)
            if not self.info.get('ready'): raise ValueError('The local speech model did not become ready.')
        except Exception:
            self.close(); raise

    def receive(self, timeout):
        try: result = self.responses.get(timeout=timeout)
        except queue.Empty: raise ValueError('The local speech model took too long. Partial text is preserved.')
        if result.get('error'): raise ValueError(result['error'])
        return result

    def transcribe(self, pcm, language):
        self.process.stdin.write(json.dumps({'pcm':base64.b64encode(pcm).decode('ascii'),'language':language})+'\n')
        self.process.stdin.flush()
        return self.receive(90)

    def close(self):
        if self.process.poll() is None:
            try: self.process.stdin.write('{"stop":true}\n'); self.process.stdin.flush(); self.process.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired): self.process.kill(); self.process.wait(timeout=5)
        for stream in (self.process.stdin, self.process.stdout):
            if stream: stream.close()


def settle_segments(rows, offset, settled_until, cutoff, final=False, settled_text=''):
    """Use word times at overlapping boundaries; never append repeated context."""
    settled, provisional = [], []
    for row in rows:
        words = row.get('words') or []
        if words:
            words = [w for w in words if offset+(float(w['start'])+float(w['end']))/2 >= settled_until-0.02]
            # Word estimates can drift across the watermark. In actual overlap,
            # remove a matching settled suffix while retaining original word times.
            if words and offset+float(words[0]['start']) < settled_until-0.03 and settled_text:
                normalize=lambda value:re.sub(r'[^\w]','',value,flags=re.UNICODE).casefold()
                previous=[normalize(value) for value in settled_text.split()][-12:]
                upcoming=[normalize(w['text']) for w in words[:12]]
                for count in range(min(len(previous),len(upcoming)),0,-1):
                    if previous[-count:]==upcoming[:count] and any(upcoming[:count]):
                        words=words[count:];break
            groups = [([w for w in words if final or offset+float(w['end']) <= cutoff], settled),
                      ([w for w in words if not final and offset+float(w['end']) > cutoff], provisional)]
            for group, destination in groups:
                if group:
                    destination.append({'start':round(offset+float(group[0]['start']),3), 'end':round(offset+float(group[-1]['end']),3),
                                        'text':''.join(w['text'] for w in group).strip()})
        elif offset+float(row['start']) >= settled_until-0.02:
            cue = {'start':round(offset+float(row['start']),3),'end':round(offset+float(row['end']),3),'text':str(row['text']).strip()}
            (settled if final or cue['end'] <= cutoff else provisional).append(cue)
    return [c for c in settled if c['text']], [c for c in provisional if c['text']]


class BrowserTranscription:
    def __init__(self, config, library, engine_factory=WarmEngine):
        self.config, self.library, self.engine_factory = config, library, engine_factory
        self.lock = threading.Lock()
        self.session = None
        self.engine = None

    def start(self, message):
        with self.lock:
            if self.session: raise ValueError('Stop the current browser transcript first.')
            sid = identifier(message.get('sessionId'))
            language = message.get('language', 'auto')
            if not isinstance(language,str) or not re.fullmatch(r'auto|[a-z]{2,3}',language): raise ValueError('Choose Auto or a supported language.')
            url = source_url(message)
            if not url: raise ValueError('Choose a browser page before starting.')
            # Load first: no capture/receipt is started when the model is missing.
            self.engine = self.engine_factory(self.config)
            filename = 'Browser audio '+sid+'.wav'
            path = self.library._safe(self.library.root / filename)
            try:
                self.library.begin({'id':sid,'action':'live-transcript','kind':'audio','url':url,'title':str(message.get('title') or 'Browser transcription')[:200]})
                self.library.root.mkdir(parents=True,exist_ok=True)
                raw = path.open('xb')
                audio = wave.open(raw,'wb'); audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(RATE)
                self.session = {'id':sid,'filename':filename,'audio':audio,'raw':raw,'sequence':0,'samples':0,'window':bytearray(),
                    'offset':0,'settledUntil':0,'cues':[],'provisional':[],'language':None if language=='auto' else language,
                    'detectedLanguage':'und','started':time.monotonic(),'created':int(time.time()*1000),'firstTextSeconds':None,
                    'processingSeconds':0,'maxProcessingSeconds':0,'maxQueuedSeconds':0,'failedChunks':0,'droppedChunks':0,'status':'recording','sourceUrl':url,'title':str(message.get('title') or 'Browser transcription')[:200]}
                audio.writeframes(b'');raw.flush()
                job=self.library.get_job(sid)
                job.update(outputs=[{'id':sid,'filename':filename,'bytes':44}],sourceItemId=sid,resultItemId=sid,
                    detail='Live tab audio; partial transcript is saved incrementally.',status='processing')
                self.library._write(self.library.meta/'jobs'/(sid+'.json'),job)
                self.persist()
                return {**self.snapshot(), 'engine':self.engine.info}
            except Exception:
                self.engine.close(); self.engine=None; raise

    def snapshot(self):
        s = self.session
        if not s: return {'status':'idle'}
        return {'sessionId':s['id'],'status':s['status'],'cues':s['cues'][-1500:],'provisional':s['provisional'],
                'seconds':round(s['samples']/RATE,3),'language':s['detectedLanguage'],'sourceUrl':s['sourceUrl'],
                'timing':'capture-relative','coverage':'Only audio played in the selected tab after Start. Times refer to the saved browser audio, not the original page.',
                'metrics':{k:s[k] for k in ('firstTextSeconds','processingSeconds','maxProcessingSeconds','maxQueuedSeconds','failedChunks','droppedChunks')},'itemId':s['id']}

    def persist(self):
        s=self.session
        data=self.snapshot()
        self.library._write(self.library.meta/'live'/(s['id']+'.json'),data)
        tracks=[{
            'id':'live-'+s['id'],'name':'Generated live transcript','provenance':'generated-live','source':'generated-live',
            'language':s['detectedLanguage'],'cues':list(s['cues']),'timing':'capture-relative','coverage':data['coverage'],
            'partial':True,'status':'ready','timed':True,'sourceTiming':False,'originalPath':str(self.library.meta/'live'/(s['id']+'.json')),
            'provisionalCues':list(s['provisional'])}]
        if s['status']=='interrupted' and s['provisional']:
            tracks.append({**tracks[0],'id':'live-provisional-'+s['id'],'name':'Unsettled text from interrupted capture',
                           'cues':list(s['provisional']),'provisional':True,'coverage':'Provisional wording from the interrupted final audio window. It was never settled.'})
        self.library.item_meta(s['id'],displayName=s['title']+' — browser audio',transcriptTracks=tracks)

    def process(self, final=False):
        s=self.session
        if not s['window']: return
        result=self.engine.transcribe(bytes(s['window']),s['language'])
        end=s['samples']/RATE
        # Preserve every original inference response separately from display normalization.
        raw_path=self.library._safe(self.library.meta/'live'/(s['id']+'-windows.jsonl'))
        with raw_path.open('a',encoding='utf-8') as raw:
            raw.write(json.dumps({'offset':s['offset'],'end':end,'final':final,'result':result},ensure_ascii=False,allow_nan=False)+'\n')
        previous=' '.join(cue['text'] for cue in s['cues'][-4:])
        settled, provisional=settle_segments(result['segments'],s['offset'],s['settledUntil'],max(0,end-1),final,previous)
        s['cues'].extend(settled);s['provisional']=provisional
        if settled:
            s['settledUntil']=settled[-1]['end']
            if s['firstTextSeconds'] is None:s['firstTextSeconds']=round(time.monotonic()-s['started'],3)
        s['detectedLanguage']=result.get('language','und');s['processingSeconds']=result.get('processingSeconds',0)
        s['maxProcessingSeconds']=max(s['maxProcessingSeconds'],s['processingSeconds'])
        # Keep one second of context, plus any not-yet-settled phrase (bounded 2s).
        retain=min(len(s['window']),2*MAX_CHUNK)
        s['window']=s['window'][-retain:]
        s['offset']=end-len(s['window'])/MAX_CHUNK
        self.persist()

    def chunk(self, message):
        with self.lock:
            s=self.session
            if not s or message.get('sessionId') != s['id']: raise ValueError('This browser capture session is no longer active.')
            if type(message.get('sequence')) is not int or message['sequence'] != s['sequence']: raise ValueError('Audio arrived out of sequence. Stop and start a new transcript.')
            raw=message.get('pcm')
            if not isinstance(raw,str) or len(raw)>43000: raise ValueError('Audio chunk exceeds its transport bound.')
            pcm=base64.b64decode(raw,validate=True)
            if not pcm or len(pcm)>MAX_CHUNK or len(pcm)%2: raise ValueError('Invalid PCM audio chunk.')
            lag=message.get('queuedSeconds',0)
            if not isinstance(lag,(float,int)) or not math.isfinite(lag) or not 0<=lag<=20:raise ValueError('Invalid audio queue measurement.')
            s['maxQueuedSeconds']=max(s['maxQueuedSeconds'],lag)
            if s['samples']+len(pcm)//2>MAX_SECONDS*RATE:raise ValueError('The one-hour capture limit was reached. Start another transcript to continue.')
            s['audio'].writeframes(pcm);s['raw'].flush() # update WAV header for interrupted-process recovery
            s['samples']+=len(pcm)//2;s['sequence']+=1;s['window'].extend(pcm)
            if len(s['window']) >= WINDOW:
                try:self.process()
                except Exception:s['failedChunks']+=1;self.persist();raise
            return {**self.snapshot(),'sequence':message['sequence']}

    def stop(self, reason='', interrupted=False, dropped_chunks=0):
        with self.lock:
            if not self.session:return {'status':'idle'}
            s=self.session
            s['droppedChunks']+=max(0,min(100,int(dropped_chunks)))
            try:
                if not interrupted:self.process(final=True)
            except Exception as error:
                reason=str(error);interrupted=True;s['failedChunks']+=1
            s['status']='interrupted' if interrupted else 'stopped'
            # Provisional output is retained separately and is never mislabeled settled.
            self.persist()
            s['audio'].close();s['raw'].close()
            path=self.library._safe(self.library.root/s['filename'])
            self.library.event({'id':s['id'],'event':'complete','filename':s['filename'],'bytes':path.stat().st_size})
            job=self.library.get_job(s['id']);job.update(sourceItemId=s['id'],resultItemId=s['id'],
                detail=reason or 'Partial source coverage: recorded browser audio and live transcript saved.',
                transcriptState=s['status'],canCancel=False)
            self.library._write(self.library.meta/'jobs'/(s['id']+'.json'),job)
            result={**self.snapshot(),'reason':reason}
            self.session=None
            if self.engine:self.engine.close();self.engine=None
            return result
