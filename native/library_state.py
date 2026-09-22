"""Durable acquisition receipts shared by existing Framekeep host processes.

This is metadata beside the user's saved media, not a second study-job database.
The original host still executes and owns every transfer and cancellation.
"""
from __future__ import annotations
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from recycle import operation_lock

ACTIVE = {'starting', 'downloading', 'processing', 'cancelling'}
MEDIA = {'.mp4':'video','.webm':'video','.mkv':'video','.mov':'video','.m4v':'video',
         '.mp3':'audio','.m4a':'audio','.aac':'audio','.ogg':'audio','.opus':'audio','.wav':'audio','.flac':'audio',
         '.png':'image','.jpg':'image','.jpeg':'image','.gif':'image','.webp':'image','.avif':'image','.bmp':'image','.svg':'image'}

def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value):
        raise ValueError('Invalid item or job ID.')
    return value

def source_url(message):
    source = message.get('source') or {}
    value = source.get('pageUrl') or message.get('pageUrl') or message.get('url') or ''
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ('http','https') or parsed.username or parsed.password: return ''
        query = [(k,v) for k,v in parse_qsl(parsed.query) if not re.search(r'token|auth|signature|secret|password|credential|key|expires', k, re.I)]
        return urlunsplit(parsed._replace(query=urlencode(query),fragment=''))
    except (ValueError, TypeError): return ''

def process_alive(pid):
    if not isinstance(pid, int) or pid < 1: return False
    if pid == os.getpid(): return True
    if os.name == 'nt':
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD,wintypes.BOOL,wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE,ctypes.POINTER(wintypes.DWORD)]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x1000,False,pid)
        if not handle: return ctypes.get_last_error() == 5
        try:
            code = wintypes.DWORD()
            return bool(kernel.GetExitCodeProcess(handle,ctypes.byref(code))) and code.value == 259
        finally: kernel.CloseHandle(handle)
    try: os.kill(pid,0); return True
    except ProcessLookupError: return False
    except PermissionError: return True

class Library:
    def __init__(self, directory):
        self.root = Path(directory).resolve()
        self.meta = self.root / '.framekeep'

    def _safe(self, path):
        path = Path(path).absolute()
        if not path.resolve().is_relative_to(self.root): raise ValueError('File is outside the Framekeep save folder.')
        for part in [path,*path.parents]:
            if part.exists():
                info = part.lstat()
                if stat.S_ISLNK(info.st_mode) or getattr(part,'is_junction',lambda:False)():
                    raise ValueError('Linked or unavailable cloud files cannot be opened.')
            if part.resolve() == self.root: break
        return path.resolve()

    def path(self, relative):
        if not isinstance(relative,str) or not relative or '\\' in relative or ':' in relative or '..' in Path(relative).parts:
            raise ValueError('Invalid saved file.')
        path = self._safe(self.root / relative)
        if not path.is_file() or path.suffix.lower() not in MEDIA: raise ValueError('The saved media file is unavailable.')
        return path

    def _read(self, path):
        try:
            self._safe(path)
            if path.stat().st_size > 8*1024*1024: return {}
            data=json.loads(path.read_text('utf-8'))
            return data if isinstance(data,dict) else {}
        except (OSError,ValueError): return {}

    def _write(self, path, value):
        self._safe(path); path.parent.mkdir(parents=True,exist_ok=True)
        temp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
        try:
            with temp.open('x',encoding='utf-8') as stream: json.dump(value,stream,ensure_ascii=False,allow_nan=False)
            os.replace(temp,path)
        finally: temp.unlink(missing_ok=True)

    def get_job(self, job_id):
        record=self._read(self.meta/'jobs'/(identifier(job_id)+'.json'))
        if record.get('status') in ACTIVE and not process_alive(record.get('ownerPid')):
            record.update(status='needs-attention',error='The transfer stopped when its owning process closed. Start a new capture or download to retry.',canCancel=False,canResume=False)
        return record

    def begin(self, message):
        job_id=identifier(message['id'])
        fingerprint=hashlib.sha256(json.dumps({k:v for k,v in message.items() if k not in ('id','origin','title')},sort_keys=True).encode()).hexdigest()
        with operation_lock(self.root):
            existing=self.get_job(job_id)
            if existing:
                if existing.get('fingerprint') != fingerprint: raise ValueError('This job ID belongs to a different request.')
                if existing.get('status')=='complete':
                    outputs=existing.get('outputs',[])
                    if not outputs: raise ValueError('This completed receipt has no verified outputs. Inspect the existing result before retrying.')
                    for output in outputs:
                        path=self.path(output['filename'])
                        with path.open('rb') as stream: digest=hashlib.file_digest(stream,'sha256').hexdigest()
                        if path.stat().st_size!=output.get('bytes') or digest!=output.get('sha256'):
                            raise ValueError('This completed output changed or lacks a verification hash. Inspect it before starting a new request.')
                    return existing
                raise ValueError('This job ID already exists. Inspect it before explicitly starting a new request.')
            record={'id':job_id,'action':message['action'],'status':'starting','title':str(message.get('title') or (message.get('source') or {}).get('title') or ('Media capture' if message['action']=='capture' else 'Media download'))[:300],
                    'kind':message.get('kind','batch' if message['action']=='capture' else 'video'),'quality':message.get('quality'),
                    'sourceUrl':source_url(message),'origin':message.get('origin','extension'),'created':int(time.time()*1000),
                    'ownerPid':os.getpid(),'fingerprint':fingerprint,'canCancel':True,'canResume':False}
            self._write(self.meta/'jobs'/(job_id+'.json'),record)
        return None

    def event(self,message):
        job_id=identifier(message['id']); path=self.meta/'jobs'/(job_id+'.json')
        with operation_lock(self.root):
            job=self._read(path)
            if not job: return
            event=message.get('event')
            if event=='progress':
                job['status']='processing' if message.get('phase')=='processing' else 'downloading'
                for key in ('percent','downloaded','total','speed','eta','stage','detail','completed'):
                    if key in message: job[key]=message[key]
            elif event in ('complete','error','cancelled'):
                job.update(status=event if event!='error' else 'error',finished=int(time.time()*1000),canCancel=False)
                if event=='error': job['error']=message.get('error','Operation failed.')
                if event=='complete':
                    outputs=[]
                    if message.get('filename'): outputs=[{'filename':message['filename'],'bytes':message['bytes'],'id':job_id}]
                    for index,file in enumerate(message.get('files',[])):
                        outputs.append({**file,'filename':str(message['folder'])+'/'+file['filename'],'id':job_id+'_'+str(index+1)})
                    for output in outputs:
                        saved=self.path(output['filename'])
                        if saved.stat().st_size != output['bytes']: raise ValueError('Saved file verification failed.')
                        with saved.open('rb') as stream: digest=hashlib.file_digest(stream,'sha256').hexdigest()
                        if output.get('sha256') and output['sha256']!=digest: raise ValueError('Saved file hash verification failed.')
                        output['sha256']=digest
                        output['mtimeNs']=saved.stat().st_mtime_ns
                    job.update(outputs=outputs,percent=100,terminal={k:v for k,v in message.items() if k!='id'})
                    if job.get('action')=='capture':
                        job.update(completed=len(outputs),detail='Saved to your Framekeep folder')
            job['updated']=int(time.time()*1000)
            self._write(path,job)

    def cancel(self, job_id):
        job=self.get_job(job_id)
        if job.get('status') not in ACTIVE: raise ValueError('This job is no longer running.')
        self._write(self.meta/'cancel'/(identifier(job_id)+'.json'),{'id':job_id,'requested':time.time()})

    def cancelled(self, job_id):
        return self._safe(self.meta/'cancel'/(identifier(job_id)+'.json')).is_file()

    def item_meta(self, item_id, **changes):
        path=self.meta/'items'/(identifier(item_id)+'.json')
        with operation_lock(self.root):
            data=self._read(path)
            if changes: data.update(changes); self._write(path,data)
        return data

    def scan(self):
        jobs=[]; output_map={}
        job_dir=self._safe(self.meta/'jobs')
        if job_dir.is_dir():
            for file in job_dir.glob('*.json'):
                job=self.get_job(file.stem)
                if not job: continue
                for output in job.get('outputs',[]): output_map[output['filename']]=(job,output)
                jobs.append(job)
        files=[]
        if self.root.is_dir():
            for file in self.root.iterdir():
                if file.name.startswith('Capture-') and file.is_dir() and not file.is_symlink():
                    try: self._safe(file); files.extend(p for p in file.iterdir() if p.suffix.lower() in MEDIA)
                    except (ValueError,OSError): pass
                elif file.suffix.lower() in MEDIA: files.append(file)
        items=[]
        for file in files:
            try:
                relative=file.relative_to(self.root).as_posix(); self.path(relative); details=file.stat()
                job,output=output_map.get(relative,({},{}))
                item_id=output.get('id') or str(uuid.uuid5(uuid.NAMESPACE_URL,relative))
                meta=self.item_meta(item_id)
                study=meta.get('study')
                if study:
                    expected=self.meta/'study'/item_id
                    if Path(study.get('folder','')).resolve()==expected.resolve():
                        saved_study=self._read(expected/'job.json')
                        if saved_study:
                            study={**study,'jobId':saved_study.get('id'),'state':saved_study.get('state')}
                            suite_state=saved_study.get('state')
                            jobs.append({'id':saved_study['id'],'sourceItemId':item_id,'action':'study','kind':MEDIA[file.suffix.lower()],
                                         'title':file.stem+' — '+study.get('recipe','study')+' preparation','status':suite_state,
                                         'created':int(saved_study.get('created_at',0)*1000),'canCancel':False,
                                         'canResume':suite_state in ('partial','failed','worker_failed','interrupted'),
                                         'error':saved_study.get('worker_error'),'stages':[{k:s.get(k) for k in ('id','state','error')} for s in saved_study.get('stages',[])],
                                         'sourceUrl':job.get('sourceUrl','')})
                title=job.get('title') if job.get('action')=='download' and job.get('title')!='Media download' else re.sub(r'\s*\[[^\]]*\]','',file.stem)
                items.append({'id':item_id,'jobId':job.get('id'), 'title':title,'filename':relative,'kind':MEDIA[file.suffix.lower()],
                              'bytes':details.st_size,'finished':int(details.st_mtime*1000),'status':'complete','sourceUrl':job.get('sourceUrl',''),
                              'collection':meta.get('collection',''),'study':study,'captionSource':meta.get('captionSource')})
            except (OSError,ValueError): continue
        items.sort(key=lambda v:v['finished'],reverse=True); jobs.sort(key=lambda v:v.get('created',0),reverse=True)
        return items,jobs

    def item(self, item_id):
        item=next((v for v in self.scan()[0] if v['id']==item_id),None)
        if not item: raise ValueError('This item is no longer in the save folder.')
        return item

    def captions(self,item):
        stored=self.item_meta(item['id']).get('transcript')
        if stored: return stored
        media=self.path(item['filename'])
        for suffix in ('.vtt','.srt','.json3'):
            sidecar=self._safe(media.with_suffix(suffix))
            if sidecar.is_file() and sidecar.stat().st_size <= 8*1024*1024:
                import host
                return {'status':'ready',**host.parse_captions(sidecar.read_text('utf-8-sig'),suffix),'source':'sidecar-captions','language':'und','automatic':None}
        return {'status':'unavailable','source':'source-captions','cues':[]}
