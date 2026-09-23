"""Optional adapter to an independently installed Study Suite's supported CLI.

Only jobs explicitly attached to Framekeep library items are read. Never enumerate
the suite's database or import its private installation into the public product.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import shutil
from library_state import identifier

class StudyAdapter:
    def __init__(self, config, library):
        self.library=library
        self.config=config; self._media_cache={}
        configured=config.get('studySuite')
        self.script=Path(configured) if configured else Path(os.environ.get('LOCALAPPDATA',''))/'CodexTools'/'study-suite'/'study_cli.py'

    def capabilities(self):
        available=self.script.is_file()
        return {'available':available,'operations':['submit','status','read','evidence','resume'] if available else [],
                'reason':'Optional local Study Suite connected. Prepared evidence still needs human review.' if available else 'Optional Study Suite is not installed. Capture, playback and source captions work without it.',
                'automaticReview':False,'cancel':False,'pause':False,'modelRequiredForVisual':False}

    def media_capabilities(self,item):
        """Verify actual streams before offering or executing a media operation."""
        path=self.library.path(item['filename']); stat=path.stat()
        key=(str(path),stat.st_size,stat.st_mtime_ns)
        if key in self._media_cache: return dict(self._media_cache[key])
        sibling=Path(self.config.get('ffmpeg','ffmpeg')).with_name('ffprobe.exe' if os.name=='nt' else 'ffprobe')
        executable=self.config.get('ffprobe') or (str(sibling) if sibling.is_file() else shutil.which('ffprobe'))
        result={'verified':False,'kind':'unknown','hasAudio':False,'hasVideo':False,'playback':False,'speech':False,'visual':False,
                'mimeType':'application/octet-stream',
                'reason':'Media streams could not be verified. Open the file to inspect it.'}
        if executable:
            try:
                process=subprocess.run([executable,'-v','error','-show_streams','-show_format','-of','json',str(path)],capture_output=True,timeout=8,
                                       creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                data=json.loads(process.stdout) if process.returncode==0 and len(process.stdout)<2*1024*1024 else {}
                streams=data.get('streams',[]); audio=any(s.get('codec_type')=='audio' for s in streams)
                video=any(s.get('codec_type')=='video' and not s.get('disposition',{}).get('attached_pic') for s in streams)
                format_name=data.get('format',{}).get('format_name','')
                brand=str(data.get('format',{}).get('tags',{}).get('major_brand','')).strip()
                image=not audio and video and (format_name.endswith('_pipe') or format_name in ('image2','svg','gif','ico') or brand in ('avif','avis'))
                kind='image' if image else 'video' if video else 'audio' if audio else 'unknown'
                installed=self.capabilities()['available']
                if kind!='unknown':
                    from media_preview import verified_mime
                    with path.open('rb') as stream: header=stream.read(256)
                    mime_type=verified_mime(data,kind,header)
                    result.update(verified=True,kind=kind,hasAudio=audio,hasVideo=video and not image,playback=not image and mime_type!='application/octet-stream',
                                  mimeType=mime_type,
                                  speech=audio and installed,visual=video and not image and installed,
                                  reason='' if installed else 'Install the optional local Study Suite to generate transcripts or extract frames.')
                    if kind=='video' and not audio: result['speechReason']='This video has no audio stream.'
                    if kind=='image': result['reason']='Image preview is available. This installation has no image text extraction engine.'
            except (OSError,ValueError,subprocess.TimeoutExpired): pass
        self._media_cache={k:v for k,v in self._media_cache.items() if k[0]!=str(path)}
        self._media_cache[key]=result
        return dict(result)

    def _call(self, operation, arguments, timeout=45):
        if not self.capabilities()['available']: raise ValueError('Optional Study Suite is not installed. Ordinary capture and captions remain available.')
        if operation not in ('submit','status','read','resume'): raise ValueError('Unsupported study operation.')
        request={'operation':operation,'arguments':arguments}
        with tempfile.TemporaryDirectory(prefix='framekeep-study-call-') as folder:
            target=Path(folder)/'request.json'; target.write_text(json.dumps(request),encoding='utf-8')
            result=subprocess.run([sys.executable,'-B',str(self.script),'call',str(target)],capture_output=True,timeout=timeout,
                                  creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        try: data=json.loads(result.stdout.decode('utf-8-sig'))
        except (ValueError,UnicodeError): raise ValueError('The optional Study Suite returned an unreadable response. Check its installation.')
        if result.returncode or not data.get('ok'):
            error=data.get('error','Study operation failed.')
            raise ValueError(str(error.get('message') if isinstance(error,dict) else error)[-650:])
        return data.get('result',{})

    def _reference(self,item,reference=None):
        reference=reference or self.library.item_meta(item['id']).get('study')
        if not reference: raise ValueError('No study is attached to this saved item yet.')
        folder=self.library._safe(Path(reference['folder']))
        expected=self.library.meta/'study'/identifier(item['id'])
        if folder != expected.resolve() and not (folder.parent==expected.resolve() and folder.name in ('speech','visual','general')):
            raise ValueError('Invalid Framekeep study reference.')
        return folder,reference

    def submit(self,item,recipe='visual'):
        if recipe not in ('visual','speech','general'): raise ValueError('Choose visual, speech or general preparation.')
        meta=self.library.item_meta(item['id']); existing=meta.get('study')
        # Merely reading a prior result must not invoke media processing again.
        if existing and (existing.get('recipe')==recipe or (recipe=='speech' and existing.get('recipe')=='general')): return self.status(item)
        capabilities=self.media_capabilities(item)
        if not capabilities['verified']: raise ValueError(capabilities['reason'])
        if capabilities['kind']=='image': raise ValueError('This installation supports image preview, but has no image extraction engine.')
        if recipe in ('speech','general') and not capabilities['hasAudio']: raise ValueError('This media has no audio stream; transcription is not applicable.')
        if recipe in ('visual','general') and not capabilities['hasVideo']: raise ValueError('This media has no video stream; choose speech preparation.')
        folder=self.library._safe(self.library.meta/'study'/identifier(item['id']))
        if existing:
            folder=folder/recipe
            previous=next((r for r in meta.get('studyHistory',[]) if r.get('recipe')==recipe),None)
            if previous:
                self.library.item_meta(item['id'],study=previous,studyHistory=[r for r in meta.get('studyHistory',[]) if r!=previous]+[existing])
                return self.status(item)
        result=self._call('submit',{'source':str(self.library.path(item['filename'])),'out':str(folder),'recipe':recipe,'frames':12,'max_output_mb':128})
        reference={'folder':str(folder),'recipe':recipe,'state':result.get('state','submitted')}
        self.library.item_meta(item['id'],study=reference,studyHistory=meta.get('studyHistory',[])+([existing] if existing else []))
        return self.status(item)

    def evidence(self,item,job_id=None,reference=None):
        folder,_=self._reference(item,reference); path=self.library._safe(folder/'evidence.json')
        if not path.is_file(): return []
        data=self.library._read(path); artifacts=[]
        if job_id is not None and data.get('job_id')!=job_id: raise ValueError('The prepared evidence belongs to a different study job.')
        source=data.get('source',{}); current=self.library.path(item['filename'])
        if Path(source.get('path','')).resolve() != current.resolve():
            raise ValueError('The prepared evidence belongs to a different source.')
        with current.open('rb') as stream: source_hash=hashlib.file_digest(stream,'sha256').hexdigest()
        if source_hash!=source.get('sha256'): raise ValueError('The saved media changed after study preparation. Its old evidence cannot be attached to this file.')
        for record in data.get('artifacts',[]):
            artifact=self.library._safe(Path(record['path']))
            if not artifact.is_relative_to(folder) or not artifact.is_file() or artifact.stat().st_size>32*1024*1024:
                raise ValueError('A prepared artifact is unavailable or outside the study folder.')
            with artifact.open('rb') as stream: digest=hashlib.file_digest(stream,'sha256').hexdigest()
            if digest!=record.get('sha256'): raise ValueError('Prepared artifact integrity check failed.')
            artifacts.append({'id':record['id'],'title':record['id'].replace('-',' ').title(),'name':record['id'].replace('-',' ').title(),'mode':record.get('mode'),'kind':record.get('mode'),
                              'coverage':record.get('coverage'),'limitations':record.get('limitations',[]),'sha256':digest,
                              'sourceItemId':item['id'],'sourceUrl':item.get('sourceUrl'),'reviewStatus':'unknown','path':str(artifact)})
        return artifacts

    def transcript_tracks(self,item):
        """Read verified original model outputs without launching a study or rewriting them."""
        meta=self.library.item_meta(item['id']); tracks=[]
        for reference in meta.get('studyHistory',[])+([meta['study']] if meta.get('study') else []):
            folder,_=self._reference(item,reference)
            for artifact in self.evidence(item,reference=reference):
                if artifact.get('mode')!='transcribe': continue
                data=json.loads(Path(artifact['path']).read_text('utf-8'))
                cues=[]; untimed=[]
                for segment in data.get('segments',[]):
                    text=segment.get('text','')
                    if not isinstance(text,str) or not text.strip(): continue
                    start,end=segment.get('start'),segment.get('end')
                    if (type(start) in (int,float) and type(end) in (int,float) and math.isfinite(start) and math.isfinite(end)
                            and 0<=start<end and (not cues or start>=cues[-1]['start'])):
                        cues.append({'start':start,'end':end,'text':text.strip()})
                    else: untimed.append(text.strip())
                text='\n'.join(str(s.get('text','')).strip() for s in data.get('segments',[]) if s.get('text')) or str(data.get('text',''))
                tracks.append({'id':'generated-'+hashlib.sha256(str(folder).encode()).hexdigest()[:12]+'-'+artifact['id'],
                               'name':'Generated transcript','status':'ready','source':'generated','sourceItemId':item['id'],
                               'language':data.get('language') or data.get('metadata',{}).get('language') or 'und',
                               'cues':cues if not untimed else [],'text':text,'timed':bool(cues) and not untimed,
                               'coverage':artifact.get('coverage'),'sourceTiming':True,'originalArtifactId':artifact['id'],
                               'originalSha256':artifact['sha256'],'reviewStatus':'unknown'})
        return tracks

    def frames(self,item,artifacts):
        """Expose only original sampled images with matching manifest hashes."""
        frames=[]
        for artifact in artifacts:
            if artifact.get('mode')!='frames': continue
            manifest=Path(artifact['path']); data=json.loads(manifest.read_text('utf-8'))
            for index,record in enumerate(data.get('frames',[])[:1000]):
                filename=record.get('file'); time_s=record.get('time_s')
                if not isinstance(filename,str) or type(time_s) not in (int,float) or not math.isfinite(time_s) or time_s<0:
                    raise ValueError('A sampled frame has invalid source timing or identity.')
                path=self.library._safe(manifest.parent/filename)
                if not path.is_relative_to(manifest.parent) or path.suffix.lower() not in ('.png','.jpg','.jpeg','.webp') or not path.is_file() or path.stat().st_size>32*1024*1024:
                    raise ValueError('A sampled frame is unavailable or outside its verified artifact folder.')
                with path.open('rb') as stream: digest=hashlib.file_digest(stream,'sha256').hexdigest()
                if digest!=record.get('sha256'): raise ValueError('Sampled frame integrity check failed.')
                frames.append({'id':hashlib.sha256(str(manifest).encode()).hexdigest()[:12]+'-'+artifact['id']+'-'+str(index),'time':time_s,'sourceItemId':item['id'],
                               'filename':path.relative_to(self.library.root).as_posix(),'sha256':digest})
        return frames

    def status(self,item,reference=None):
        folder,reference=self._reference(item,reference); result=self._call('status',{'job':str(folder)})
        # The ID is the suite's real ID; only an item-to-job reference lives here.
        summary={'status':'ready','id':result['job_id'],'jobId':result['job_id'],'sourceItemId':item['id'],
                 'state':result.get('state'),'stages':result.get('stages',[]),'error':result.get('worker_error'),
                 'canResume':result.get('state') in ('partial','failed','worker_failed','interrupted'),
                 'canCancel':False,'semanticReviewComplete':False,'reviewStatus':'unknown','artifacts':self.evidence(item,result['job_id'],reference),
                 'limitation':'Prepared artifacts are algorithmic evidence, not reviewed findings. Sampled frames do not prove continuous motion coverage.'}
        evidence=self.library._read(folder/'evidence.json')
        summary['transcriptChunks']=len(evidence.get('transcript_chunks',[]))
        summary['canReadTranscript']=summary['transcriptChunks']>0
        frame_artifacts=list(summary['artifacts'])
        for historical in self.library.item_meta(item['id']).get('studyHistory',[]):
            if historical.get('folder')!=reference.get('folder'):
                frame_artifacts.extend(a for a in self.evidence(item,reference=historical) if a.get('mode')=='frames')
        summary['frames']=self.frames(item,frame_artifacts)
        updated={**reference,'jobId':result['job_id'],'state':result.get('state')}
        meta=self.library.item_meta(item['id'])
        if meta.get('study',{}).get('folder')==reference.get('folder'): self.library.item_meta(item['id'],study=updated)
        else: self.library.item_meta(item['id'],studyHistory=[updated if r.get('folder')==reference.get('folder') else r for r in meta.get('studyHistory',[])])
        return summary

    def read(self,item,chunk):
        if not isinstance(chunk,int) or chunk<1: raise ValueError('Choose a valid transcript chunk.')
        folder,_=self._reference(item)
        return self._call('read',{'job':str(folder),'chunk':chunk})

    def read_artifact(self,item,artifact_id):
        current=self.status(item)
        record=next((a for a in current['artifacts'] if a['id']==artifact_id),None)
        if not record: raise ValueError('Choose an artifact attached to this study job.')
        path=Path(record['path']);raw=path.read_bytes();limit=128*1024
        return {'id':artifact_id,'jobId':current['jobId'],'sourceItemId':item['id'],'text':raw[:limit].decode('utf-8','replace'),
                'bytes':len(raw),'previewBytes':min(len(raw),limit),'complete':len(raw)<=limit,'truncated':len(raw)>limit,
                'reviewStatus':'unknown','sha256':record['sha256']}

    def resume(self,item,job_id=None):
        meta=self.library.item_meta(item['id']); reference=None
        if job_id and job_id!=item['id']:
            for candidate in meta.get('studyHistory',[])+([meta['study']] if meta.get('study') else []):
                folder,_=self._reference(item,candidate)
                if candidate.get('jobId')==job_id or self.library._read(folder/'job.json').get('id')==job_id:
                    reference=candidate; break
            if reference is None: raise ValueError('No attached study matches this job.')
        current=self.status(item,reference)
        if current['state'] in ('complete','evidence_ready'): return current
        if not current['canResume']: raise ValueError('This study job does not support recovery in its current state.')
        folder,_=self._reference(item,reference)
        self._call('resume',{'job':str(folder),'retry_failed':True},timeout=21600)
        return self.status(item,reference)
