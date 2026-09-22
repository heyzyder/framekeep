"""Optional adapter to an independently installed Study Suite's supported CLI.

Only jobs explicitly attached to Framekeep library items are read. Never enumerate
the suite's database or import its private installation into the public product.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from library_state import identifier

class StudyAdapter:
    def __init__(self, config, library):
        self.library=library
        configured=config.get('studySuite')
        self.script=Path(configured) if configured else Path(os.environ.get('LOCALAPPDATA',''))/'CodexTools'/'study-suite'/'study_cli.py'

    def capabilities(self):
        available=self.script.is_file()
        return {'available':available,'operations':['submit','status','read','evidence','resume'] if available else [],
                'reason':'Optional local Study Suite connected. Prepared evidence still needs human review.' if available else 'Optional Study Suite is not installed. Capture, playback and source captions work without it.',
                'automaticReview':False,'cancel':False,'pause':False,'modelRequiredForVisual':False}

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

    def _reference(self,item):
        reference=self.library.item_meta(item['id']).get('study')
        if not reference: raise ValueError('No study is attached to this saved item yet.')
        folder=self.library._safe(Path(reference['folder']))
        expected=self.library.meta/'study'/identifier(item['id'])
        if folder != expected.resolve(): raise ValueError('Invalid Framekeep study reference.')
        return folder,reference

    def submit(self,item,recipe='visual'):
        if recipe not in ('visual','speech','general'): raise ValueError('Choose visual, speech or general preparation.')
        if item['kind']=='image': raise ValueError('Study preparation currently supports video and audio. Open images directly for review.')
        if item['kind']=='audio' and recipe=='visual': raise ValueError('Choose speech preparation for an audio item.')
        existing=self.library.item_meta(item['id']).get('study')
        if existing: return self.status(item)
        folder=self.library._safe(self.library.meta/'study'/identifier(item['id']))
        result=self._call('submit',{'source':str(self.library.path(item['filename'])),'out':str(folder),'recipe':recipe,'frames':12,'max_output_mb':128})
        reference={'folder':str(folder),'recipe':recipe,'state':result.get('state','submitted')}
        self.library.item_meta(item['id'],study=reference)
        return self.status(item)

    def evidence(self,item,job_id=None):
        folder,_=self._reference(item); path=self.library._safe(folder/'evidence.json')
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
                              'sourceItemId':item['id'],'sourceUrl':item.get('sourceUrl'),'reviewed':False,'reviewStatus':'unknown','path':str(artifact)})
        return artifacts

    def status(self,item):
        folder,reference=self._reference(item); result=self._call('status',{'job':str(folder)})
        # The ID is the suite's real ID; only an item-to-job reference lives here.
        summary={'status':'ready','id':result['job_id'],'jobId':result['job_id'],'sourceItemId':item['id'],
                 'state':result.get('state'),'stages':result.get('stages',[]),'error':result.get('worker_error'),
                 'canResume':result.get('state') in ('partial','failed','worker_failed','interrupted'),
                 'canCancel':False,'semanticReviewComplete':False,'reviewStatus':'unknown','artifacts':self.evidence(item,result['job_id']),
                 'limitation':'Prepared artifacts are algorithmic evidence, not reviewed findings. Sampled frames do not prove continuous motion coverage.'}
        evidence=self.library._read(folder/'evidence.json')
        summary['transcriptChunks']=len(evidence.get('transcript_chunks',[]))
        summary['canReadTranscript']=summary['transcriptChunks']>0
        self.library.item_meta(item['id'],study={**reference,'jobId':result['job_id'],'state':result.get('state')})
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

    def resume(self,item):
        current=self.status(item)
        if current['state'] in ('complete','evidence_ready'): return current
        if not current['canResume']: raise ValueError('This study job does not support recovery in its current state.')
        folder,_=self._reference(item)
        self._call('resume',{'job':str(folder),'retry_failed':True},timeout=21600)
        return self.status(item)
