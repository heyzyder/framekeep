"""Narrow local UI adapter. Shares the validated downloader with the extension."""
import copy
import io
import json
import os
from pathlib import Path
import re
import threading
import time
import uuid
import webbrowser
import host

ACTIVE = {'starting', 'downloading', 'processing', 'cancelling'}


class DesktopBridge:
    def __init__(self, config, directory):
        self._config, self._directory = config, Path(directory)
        self._lock = threading.RLock()
        self._revision, self._requests, self._last_scan = 0, {}, 0
        self._window = None
        self._server = host.Host(config, output=io.BytesIO())
        self._server.emit = self._receive
        self._store = self._server.library
        from study_adapter import StudyAdapter
        self._study = StudyAdapter(config,self._store)
        self._study_inflight = set()
        self._last_study_poll = 0
        self._preview = None
        self._state = {
            'protocol': 2, 'workerVersion': host.VERSION,
            'helper': {'status': 'checking'}, 'probe': {'status': 'idle'}, 'jobs': [],
            'settings': {'kind': 'video', 'quality': '1080', 'audioQuality': '192', 'notifications': True},
            'alerts': {'status': 'granted'}, 'transcript': {'status': 'idle'},
            'page': {'status': 'desktop', 'candidates': [], 'origins': []},
            'library': [], 'selectedItem': None, 'study': {'status':'idle'},
            'capabilities': {'library':True,'preview':True,'sharedJobs':True,'pause':False,'study':self._study.capabilities()},
            'saveDirectory': str(self._store.root)}
        preferences = self._directory / 'desktop-settings.json'
        try:
            saved = json.loads(preferences.read_text('utf-8'))
            self._state['settings'].update({key: saved[key] for key in self._state['settings'] if key in saved})
        except (OSError, ValueError): pass

    def snapshot(self, revision=-1):
        with self._lock:
            if time.monotonic() - self._last_scan > 5:
                self._library()
            if revision == self._revision: return None
            return {'revision': self._revision, 'state': copy.deepcopy(self._state)}

    def dispatch(self, message):
        if not isinstance(message, dict): return {'error': 'Invalid action.'}
        with self._lock:
            try:
                action = message.get('action')
                if action in ('init', 'check'):
                    self._request('status'); self._library()
                elif action == 'analyze': self._analyze(message)
                elif action == 'download': self._download(message)
                elif action == 'cancel':
                    job = next((j for j in self._state['jobs'] if j['id'] == message.get('id') and j['status'] in ACTIVE and j.get('canCancel') is not False), None)
                    if job: job['status'] = 'cancelling'; self._request('cancel', target=job['id'])
                    else: raise ValueError('This job is no longer running or does not support cancellation.')
                elif action == 'select-item': self._select(message.get('id'))
                elif action == 'organize-item':
                    item=self._store.item(message.get('id')); collection=message.get('collection','')
                    if not isinstance(collection,str) or len(collection)>80: raise ValueError('Use a collection name of up to 80 characters.')
                    self._store.item_meta(item['id'],collection=collection.strip()); self._library(); self._select(item['id'])
                elif action == 'open-item':
                    item=self._store.item(message.get('id')); os.startfile(str(self._store.path(item['filename'])))
                elif action == 'open-source':
                    item=self._store.item(message.get('id')); url=item.get('sourceUrl')
                    if not url: raise ValueError('The original source was not recorded for this file.')
                    webbrowser.open(host.public_url(url).geturl())
                elif action in ('study-submit','study-status','study-read','study-artifact','resume-job'): self._study_action(action,message)
                elif action=='open-artifact':
                    item=self._store.item(message.get('id')); current=self._study.status(item)
                    artifact=next((a for a in current['artifacts'] if a['id']==message.get('artifactId')),None)
                    if not artifact: raise ValueError('Choose an artifact attached to this study job.')
                    os.startfile(artifact['path'])
                elif action == 'folder': self._request('folder')
                elif action == 'trash': self._trash(message.get('id'))
                elif action == 'transcript':
                    if message.get('id'): self._item_captions(message['id'],message.get('language'))
                    else: self._captions(message.get('language'))
                elif action == 'acknowledge':
                    for job in self._state['jobs']: job['unread'] = False
                elif action == 'settings':
                    for key, allowed in [('kind', ['video', 'audio']), ('quality', ['best'] + [str(x) for x in range(144, 8641)]), ('audioQuality', ['128', '192', '320'])]:
                        if message.get(key) in allowed: self._state['settings'][key] = message[key]
                    if isinstance(message.get('notifications'), bool): self._state['settings']['notifications'] = message['notifications']
                    (self._directory / 'desktop-settings.json').write_text(json.dumps(self._state['settings']), encoding='utf-8')
                elif action == 'seek':
                    url = host.normalize_url(self._state['probe'].get('url'))
                    seconds = message.get('seconds')
                    if isinstance(seconds, (int, float)) and 0 <= seconds < 1000000:
                        if 'youtube.com/watch?' in url: webbrowser.open(url + '&t=' + str(int(seconds)) + 's')
                        elif 'vimeo.com/' in url: webbrowser.open(url + '#t=' + str(int(seconds)) + 's')
                elif action in ('export-transcript', 'copy-transcript'): self._export(action, message.get('timestamps', True),message.get('id'))
                else: raise ValueError('That action is not available in the desktop app.')
                self._revision += 1
            except (ValueError, OSError, KeyError) as error: return {'error': str(error)[:300]}
        return {'ok': True}

    def _request(self, action, **fields):
        identifier = fields.pop('id', str(uuid.uuid4()))
        self._requests[identifier] = {'action': action, **fields}
        threading.Thread(target=self._server.handle, args=({'id': identifier, 'action': action, **fields},), daemon=True).start()
        return identifier

    def _busy(self):
        return any(job['status'] in ACTIVE or job.get('fileState') == 'trashing' for job in self._state['jobs'])

    def _owns_work(self):
        return any(task.get('action') in ('download','capture','trash') for task in self._requests.values())

    def _analyze(self, message):
        if self._state['probe']['status'] == 'loading': raise ValueError('Wait for the current video check to finish.')
        received = {key: message[key] for key in ('url', 'source') if key in message}
        self._state['probe'] = {'status':'idle'}
        self._state['transcript'] = {'status':'idle'}
        try:
            url = host.source_request(received)[0] if received.get('source') else host.public_url(received.get('url')).geturl()
        except ValueError as error:
            self._state['probe'] = {'status':'error', 'error':str(error)}
            self._revision += 1
            raise
        self._state['probe'] = {'status': 'loading', 'url': url, 'source': received.get('source')}
        self._state['transcript'] = {'status': 'idle', 'url': url}
        self._request('probe', **received)

    def _download(self, message):
        probe = self._state['probe']
        if probe['status'] != 'ready': raise ValueError('Choose a video first.')
        active = [job for job in self._state['jobs'] if job['status'] in ACTIVE]
        if any(job.get('fileState') == 'trashing' for job in self._state['jobs']): raise ValueError('Wait for the file to reach the Recycle Bin.')
        kind, quality = message.get('kind'), str(message.get('quality'))
        data = {'url': probe['url'], 'source': probe.get('source'), 'kind': kind, 'quality': quality,'origin':'desktop','title':probe['info']['title']}
        host.download_command(self._config, data)
        key = json.dumps([(probe.get('source') or {}).get('pageUrl') or probe['url'],kind,quality], separators=(',',':'))
        if any(job.get('key') == key for job in active): raise ValueError('This video is already downloading in that format.')
        identifier = str(uuid.uuid4())
        self._state['jobs'].insert(0, {'id': identifier, 'key':key, 'status': 'starting', 'title': probe['info']['title'], 'kind': kind, 'quality': quality, 'created': int(time.time()*1000)})
        self._request('download', id=identifier, **data)

    def _captions(self, language=None):
        probe = self._state['probe']
        if probe['status'] != 'ready': return
        tracks = probe['info'].get('tracks', [])
        if not tracks: self._state['transcript'] = {'status': 'unavailable', 'url': probe['url']}; return
        if self._state['transcript']['status'] == 'loading': return
        track = next((t for t in tracks if t['language'] == language), tracks[0])
        self._state['transcript'] = {'status': 'loading', 'url': probe['url'], **track}
        self._request('transcript', url=probe['url'], source=probe.get('source'), language=track['language'])

    def _trash(self, identifier):
        if self._busy(): raise ValueError('Wait for the current operation before deleting a file.')
        job = next((j for j in self._state['jobs'] if j['id'] == identifier and j['status'] == 'complete'), None)
        if not job: return
        job['fileState'] = 'trashing'; job.pop('fileError', None)
        self._request('trash', filename=job['filename'])

    def _library(self):
        self._last_scan = time.monotonic()
        items,entries=self._store.scan()
        if items and self._preview is None:
            from media_preview import PreviewServer
            self._preview=PreviewServer(self._store)
        for item in items: item['previewUrl']=self._preview.url(item['filename'])
        known={j['id']:j for j in self._state['jobs']}
        by_id={i['id']:i for i in items}
        for job in entries:
            if job['id'] in by_id: job.update(by_id[job['id']])
            for key in ('fileState','fileError','unread'):
                if key in known.get(job['id'],{}): job[key]=known[job['id']][key]
        recorded={j['id'] for j in entries}
        # Preserve requests between dispatch and the host's durable start receipt.
        entries += [j for j in known.values() if j['id'] not in recorded and j['status'] in ACTIVE]
        entries += [i for i in items if not i.get('jobId')]
        if items != self._state['library'] or entries != self._state['jobs']:
            self._state['library']=items; self._state['jobs']=entries; self._revision+=1
        selected=self._state['selectedItem'] or {}
        attached=(by_id.get(selected.get('id')) or {}).get('study')
        visible=self._state['study']
        if (attached and selected['id'] not in self._study_inflight and visible.get('status')!='error'
                and time.monotonic()-self._last_study_poll >= 5):
            running=visible.get('state') in ('planned','submitted','queued','running')
            changed=attached.get('state')!=visible.get('state')
            missing_evidence=attached.get('state')=='evidence_ready' and not visible.get('artifacts')
            if running or changed or missing_evidence:
                self._study_action('study-status',{'id':selected['id']},background=True)

    def _select(self,identifier):
        self._library()
        item=next((i for i in self._state['library'] if i['id']==identifier),None)
        if not item: raise ValueError('This item is no longer in the save folder.')
        self._state['selectedItem']={**item,'transcript':self._store.captions(item),'artifacts':[]}
        self._state['study']={'status':'idle'}
        if item.get('study'):
            if identifier not in self._study_inflight: self._study_action('study-status',{'id':identifier})
            else: self._state['study']={'status':'loading','sourceItemId':identifier}

    def _item_captions(self,identifier,language=None):
        if (self._state['selectedItem'] or {}).get('id')!=identifier: self._select(identifier)
        item=self._store.item(identifier); transcript=self._store.captions(item)
        if transcript['status']=='ready':
            self._state['selectedItem']['transcript']=transcript; return
        if not item.get('sourceUrl'): raise ValueError('This item has no source captions. Place a matching .vtt or .srt beside the saved media.')
        self._state['selectedItem']['transcript']={'status':'loading','cues':[],'source':'source-captions'}
        self._request('probe',url=item['sourceUrl'],itemId=identifier,language=language)

    def _study_action(self,action,message,background=False):
        item_id=message.get('id')
        # Recovery may be addressed by the suite job ID from Activity.
        if action=='resume-job':
            item=next((i for i in self._store.scan()[0] if i['id']==item_id or (i.get('study') or {}).get('jobId')==item_id),None)
            if not item: raise ValueError('No attached study matches this job.')
        else: item=self._store.item(item_id)
        if item['id'] in self._study_inflight: raise ValueError('Wait for the current study request to finish.')
        self._study_inflight.add(item['id']); self._last_study_poll=time.monotonic()
        if not background: self._state['study']={'status':'loading','sourceItemId':item['id']}
        def run():
            try:
                if action=='study-submit': result=self._study.submit(item,message.get('recipe','visual'))
                elif action=='resume-job': result=self._study.resume(item)
                elif action=='study-read': result={**self._study.status(item),'read':self._study.read(item,message.get('chunk',1))}
                elif action=='study-artifact': result={**self._study.status(item),'artifact':self._study.read_artifact(item,message.get('artifactId'))}
                else: result=self._study.status(item)
                with self._lock:
                    if (self._state['selectedItem'] or {}).get('id')==item['id']:
                        self._state['study']=result
                        self._state['selectedItem'].update(study=result,artifacts=result.get('artifacts',[]))
                    self._last_scan=0; self._revision+=1
            except Exception as error:
                with self._lock:
                    if (self._state['selectedItem'] or {}).get('id')==item['id']:
                        self._state['study']={'status':'error','error':str(error)[:650],'sourceItemId':item['id']}
                    self._revision+=1
            finally:
                with self._lock: self._study_inflight.discard(item['id'])
        threading.Thread(target=run,daemon=True).start()

    def close(self):
        self._server.close()
        if self._preview: self._preview.close(); self._preview=None

    def _receive(self, message):
        with self._lock:
            task = self._requests.get(message['id'], {})
            action, event = task.get('action'), message.get('event')
            data = message.get('data', {})
            error = message.get('error', 'The operation could not finish. Try again.')
            if event in ('result', 'error', 'complete', 'cancelled'): self._requests.pop(message['id'], None)
            if action == 'status': self._state['helper'] = {'status': 'ready', **data} if event == 'result' else {'status': 'missing', 'error': error}
            elif action == 'probe':
                if task.get('itemId'):
                    selected=self._state['selectedItem'] or {}
                    if selected.get('id')==task['itemId']:
                        tracks=data.get('tracks',[])
                        track=next((v for v in tracks if v['language']==task.get('language')),tracks[0] if tracks else None)
                        if event=='result' and track:
                            self._request('transcript',url=task['url'],source=data.get('source'),language=track['language'],itemId=task['itemId'],automatic=track.get('automatic',False))
                        else: selected['transcript']={'status':'unavailable' if event=='result' else 'error','error':error if event!='result' else 'No source caption track is available.','cues':[]}
                    self._revision+=1; return
                probe = self._state['probe']
                if event == 'result':
                    if data.get('source'): probe.update(source=data.pop('source'), url=task.get('url'))
                    source = probe.get('source')
                    if source: probe['url'] = source['url']
                    if source and source.get('type') == 'direct':
                        data['title'] = source.get('title') or 'Page video'; data['platform'] = 'Page video'
                    probe.update(status='ready', info=data)
                    self._captions()
                    if not data.get('thumbnail') and source and source.get('type') == 'direct': self._request('preview', source=source)
                else: probe.update(status='error', error=error)
            elif action == 'preview':
                probe = self._state['probe']
                if (probe.get('source') or {}).get('url') == (task.get('source') or {}).get('url') and probe['status'] == 'ready' and data.get('thumbnail'): probe['info']['thumbnail'] = data['thumbnail']
            elif action == 'transcript':
                if task.get('itemId'):
                    transcript={'status':'ready' if event=='result' else 'error','source':'source-captions','automatic':task.get('automatic'),**data}
                    if event=='error': transcript['error']=error
                    else: self._store.item_meta(task['itemId'],transcript=transcript,captionSource='source-captions')
                    if (self._state['selectedItem'] or {}).get('id')==task['itemId']: self._state['selectedItem']['transcript']=transcript
                elif task.get('url') == self._state['probe'].get('url'):
                    self._state['transcript'].update(status='ready' if event == 'result' else 'error', **data)
                    if event == 'error': self._state['transcript']['error'] = error
            elif action == 'download':
                job = next((j for j in self._state['jobs'] if j['id'] == message['id']), None)
                if job:
                    if event == 'progress':
                        if job['status'] != 'cancelling': job['status'] = 'processing' if message.get('phase') == 'processing' else 'downloading'
                        job.update({key: message.get(key) for key in ('percent', 'downloaded', 'total', 'speed', 'eta', 'stage')})
                    else:
                        job.update(status='complete' if event == 'complete' else 'cancelled' if event == 'cancelled' else 'error', finished=int(time.time()*1000), unread=True)
                        if event == 'complete':
                            job.update(filename=message['filename'], bytes=message['bytes'], percent=100)
                            transcript=self._state['transcript']
                            if transcript.get('status')=='ready' and transcript.get('url')==task.get('url'):
                                self._store.item_meta(job['id'],transcript={**transcript,'source':'source-captions'},captionSource='source-captions')
                            self._last_scan=0
                            if self._state['settings'].get('notifications'):
                                import winsound
                                winsound.MessageBeep(winsound.MB_OK)
                        elif event == 'error': job['error'] = error
            elif action == 'trash':
                filename = task.get('filename')
                if event == 'result' and data.get('fileState') in ('trashed', 'missing'):
                    self._state['jobs'] = [j for j in self._state['jobs'] if j.get('filename') != filename]
                else:
                    for job in self._state['jobs']:
                        if job.get('filename') == filename: job.update(fileState='error', fileError=error)
            self._revision += 1

    def _export(self, action, timestamps,identifier=None):
        transcript = self._store.captions(self._store.item(identifier)) if identifier else self._state['transcript']
        if transcript['status'] != 'ready' or not self._window: return
        def stamp(value):
            value = int(value); return f'{value//60}:{value%60:02}'
        content = '\n'.join((f'[{stamp(cue["start"])}] ' if timestamps else '') + cue['text'] for cue in transcript['cues'])
        def perform():
            if action == 'copy-transcript':
                from System import Action
                from System.Windows.Forms import Clipboard
                self._window.native.Invoke(Action(lambda: Clipboard.SetText(content)))
            else:
                import webview
                result = self._window.create_file_dialog(webview.FileDialog.SAVE, save_filename='Framekeep transcript.txt', file_types=('Text files (*.txt)',))
                if result: Path(result[0] if isinstance(result, (tuple, list)) else result).write_text(content, encoding='utf-8')
        threading.Thread(target=perform, daemon=True).start()
