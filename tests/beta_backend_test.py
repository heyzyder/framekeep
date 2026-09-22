"""Focused beta contracts: durable IDs, process boundaries, local media, study scope."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from unittest.mock import patch

NATIVE=Path(__file__).resolve().parents[1]/'native'
sys.path.insert(0,str(NATIVE))
import host
from desktop_bridge import DesktopBridge
from library_state import Library
from media_preview import PreviewServer
from study_adapter import StudyAdapter
from framekeep_cli import invoke

class BetaBackendTests(unittest.TestCase):
    def config(self,root): return {'directory':str(root),'node':sys.executable,'ffmpeg':sys.executable,'studySuite':str(Path(root)/'not-installed.py')}

    def complete(self,store,job='capture_fixture'):
        request={'id':job,'action':'capture','pageUrl':'https://example.org/lesson?token=secret','items':[{'url':'https://example.org/figure.png','kind':'image'}]}
        self.assertIsNone(store.begin(request))
        folder=store.root/'Capture-fixture';folder.mkdir(exist_ok=True)
        (folder/'figure.png').write_bytes(b'synthetic-image')
        terminal={'id':job,'event':'complete','folder':folder.name,'files':[{'filename':'figure.png','bytes':15,'sanitized':False}],'bytes':15}
        store.event(terminal)
        return request,terminal

    def test_batch_ids_survive_restart_and_preserve_originals_boundary(self):
        with tempfile.TemporaryDirectory() as root:
            store=Library(root);self.complete(store)
            private=Path(root)/'Originals'/'Capture-private';private.mkdir(parents=True);(private/'hidden.png').write_bytes(b'not-a-library-item')
            (Path(root)/'root-audio.wav').write_bytes(b'audio')
            fresh=Library(root);items,jobs=fresh.scan()
            self.assertEqual(len(items),2);item=next(i for i in items if i['kind']=='image')
            self.assertEqual(item['id'],'capture_fixture_1');self.assertEqual(item['jobId'],jobs[0]['id'])
            self.assertEqual(item['sourceUrl'],'https://example.org/lesson')
            fresh.item_meta(item['id'],collection='Reference')
            self.assertEqual(Library(root).item(item['id'])['collection'],'Reference')

    def test_completed_replay_does_not_execute_or_corrupt_receipt(self):
        with tempfile.TemporaryDirectory() as root:
            store=Library(root);request,terminal=self.complete(store)
            output=io.BytesIO();server=host.Host(self.config(root),output)
            with patch('media_capture.run_capture') as engine:
                server.handle({**request,'origin':'cli'});engine.assert_not_called()
                output.seek(0);self.assertTrue(host.read_message(output)['reused'])
                server.handle({**request,'items':[]});engine.assert_not_called()
            self.assertEqual(store.get_job(request['id'])['status'],'complete')
            file=store.root/terminal['folder']/'figure.png';file.write_bytes(b'changed-content')
            self.assertEqual(file.stat().st_size,15)
            with self.assertRaisesRegex(ValueError,'changed'):store.begin(request)

    def test_capture_terminal_replaces_incomplete_progress_detail(self):
        with tempfile.TemporaryDirectory() as root:
            store=Library(root);request,terminal=self.complete(store)
            store.event({'id':request['id'],'event':'progress','detail':'Downloading 1 of 1…','completed':0})
            store.event(terminal)
            job=Library(root).get_job(request['id'])
            self.assertEqual(job['status'],'complete')
            self.assertEqual(job['completed'],len(job['outputs']))
            self.assertEqual(job['completed'],1)
            self.assertEqual(job['detail'],'Saved to your Framekeep folder')
            self.assertEqual(job['percent'],100)

    def test_orphan_is_needs_attention_without_automatic_retry(self):
        with tempfile.TemporaryDirectory() as root:
            store=Library(root);store.begin({'id':'orphan','action':'download','url':'https://youtu.be/BaW_jenozKc'})
            with patch('library_state.process_alive',return_value=False):
                job=store.get_job('orphan');self.assertEqual(job['status'],'needs-attention');self.assertFalse(job['canResume'])
                with self.assertRaisesRegex(ValueError,'already exists'):store.begin({'id':'orphan','action':'download','url':'https://youtu.be/BaW_jenozKc'})

    def test_cross_process_capture_visible_and_cancellable_by_cli(self):
        with tempfile.TemporaryDirectory() as root:
            script="""import io,json,sys,time
sys.path.insert(0,sys.argv[1])
import host,media_capture
def capture(config,message,task,emit):
 emit({'event':'progress','detail':'Waiting for external cancellation'})
 if not task['cancelled'].wait(12): raise ValueError('Cancellation never arrived')
 raise ValueError('Cancelled synthetic capture')
media_capture.run_capture=capture
server=host.Host(json.loads(sys.argv[2]),io.BytesIO())
server.handle({'id':'cross_process','action':'capture','items':[{'url':'https://example.org/test.png','kind':'image'}]})
while server.jobs:time.sleep(0.03)
server.close()
"""
            process=subprocess.Popen([sys.executable,'-c',script,str(NATIVE),json.dumps(self.config(root))],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            try:
                store=Library(root);deadline=time.monotonic()+5
                while time.monotonic()<deadline and store.get_job('cross_process').get('status')!='downloading':time.sleep(.03)
                self.assertEqual(store.get_job('cross_process')['status'],'downloading')
                bridge=DesktopBridge(self.config(root),root)
                self.assertEqual(bridge.snapshot()['state']['jobs'][0]['id'],'cross_process')
                result=invoke(self.config(root),{'action':'cancel','target':'cross_process'})
                self.assertEqual(result['event'],'result')
                stdout,stderr=process.communicate(timeout=6);self.assertEqual(process.returncode,0,stderr.decode())
                self.assertEqual(store.get_job('cross_process')['status'],'cancelled');bridge.close()
            finally:
                if process.poll() is None:process.kill();process.communicate()

    def test_preview_has_byte_ranges_and_token_path_boundaries(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root)/'media.mp4').write_bytes(b'0123456789');server=PreviewServer(Library(root))
            try:
                with urlopen(Request(server.url('media.mp4'),headers={'Range':'bytes=2-5'})) as response:
                    self.assertEqual(response.status,206);self.assertEqual(response.read(),b'2345');self.assertEqual(response.headers['Content-Range'],'bytes 2-5/10')
                for url in [server.base.replace(server.base.split('/')[-2],'wrong')+'media.mp4',server.base+'%2e%2e/private.mp4']:
                    with self.assertRaises(HTTPError) as caught:urlopen(url)
                    self.assertEqual(caught.exception.code,404)
                with self.assertRaises(HTTPError) as caught:urlopen(Request(server.url('media.mp4'),headers={'Range':'bytes=999-'}))
                self.assertEqual(caught.exception.code,416)
            finally:server.close()

    def test_saved_caption_selection_never_reprocesses_media(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root)/'clip.mp4').write_bytes(b'fixture');(Path(root)/'clip.vtt').write_text('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nA useful caption.\n',encoding='utf-8')
            bridge=DesktopBridge(self.config(root),root)
            try:
                item=bridge.snapshot()['state']['library'][0]
                with patch.object(bridge._server,'handle') as execute:
                    self.assertEqual(bridge.dispatch({'action':'select-item','id':item['id']}),{'ok':True});execute.assert_not_called()
                selected=bridge.snapshot()['state']['selectedItem']
                self.assertEqual(selected['transcript']['source'],'sidecar-captions');self.assertEqual(selected['transcript']['cues'][0]['start'],1)
                self.assertFalse(bridge._state['capabilities']['study']['available'])
            finally:bridge.close()

    def test_study_adapter_uses_selected_item_only_and_keeps_real_id(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root)/'clip.mp4').write_bytes(b'fixture');store=Library(root);item=store.scan()[0][0];adapter=StudyAdapter(self.config(root),store)
            folder=store.meta/'study'/item['id'];store.item_meta(item['id'],study={'folder':str(folder),'recipe':'visual'})
            with patch.object(adapter,'_call',return_value={'job_id':'existing_suite_id','state':'complete','stages':[]}) as call:
                result=adapter.submit(item,'visual')
                self.assertEqual(call.call_count,1);self.assertEqual(call.call_args.args,('status',{'job':str(folder)}))
                self.assertEqual(result['id'],'existing_suite_id');self.assertFalse(result['semanticReviewComplete'])
                self.assertEqual(adapter.resume(item)['id'],'existing_suite_id')
                self.assertTrue(all(c.args[0]=='status' for c in call.call_args_list))
            store.item_meta(item['id'],study={'folder':str(Path(root).parent/'unrelated'),'recipe':'visual'})
            with self.assertRaisesRegex(ValueError,'outside|Invalid'):adapter.status(item)

    def test_study_evidence_rejects_changed_source_and_artifact(self):
        import hashlib
        with tempfile.TemporaryDirectory() as root:
            media=Path(root)/'clip.mp4';media.write_bytes(b'original')
            store=Library(root);item=store.scan()[0][0];adapter=StudyAdapter(self.config(root),store)
            folder=store.meta/'study'/item['id'];folder.mkdir(parents=True)
            artifact=folder/'data.json';artifact.write_bytes(b'{}')
            source_hash=hashlib.sha256(media.read_bytes()).hexdigest();artifact_hash=hashlib.sha256(artifact.read_bytes()).hexdigest()
            store.item_meta(item['id'],study={'folder':str(folder),'recipe':'visual'})
            (folder/'evidence.json').write_text(json.dumps({'source':{'path':str(media),'sha256':source_hash},'artifacts':[{'id':'probe','path':str(artifact),'sha256':artifact_hash}]}))
            self.assertEqual(adapter.evidence(item)[0]['reviewStatus'],'unknown')
            media.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'saved media changed'):adapter.evidence(item)
            media.write_bytes(b'original');artifact.write_bytes(b'{"changed":true}')
            with self.assertRaisesRegex(ValueError,'integrity'):adapter.evidence(item)

    def test_real_cli_and_mcp_read_the_same_library(self):
        with tempfile.TemporaryDirectory() as root:
            store=Library(root);self.complete(store)
            config=Path(root)/'config.json';config.write_text(json.dumps(self.config(root)),encoding='utf-8')
            result=subprocess.run([sys.executable,str(NATIVE/'framekeep_cli.py'),'--config',str(config),'list'],capture_output=True,text=True,encoding='utf-8',timeout=10)
            self.assertEqual(result.returncode,0,result.stderr);cli=json.loads(result.stdout)['result']['data']
            messages=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05'}},
                      {'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'framekeep','arguments':{'action':'library'}}}]
            result=subprocess.run([sys.executable,str(NATIVE/'framekeep_mcp.py'),'--config',str(config)],input='\n'.join(json.dumps(m) for m in messages)+'\n',capture_output=True,text=True,encoding='utf-8',timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
            replies=[json.loads(line) for line in result.stdout.splitlines()]
            mcp=json.loads(replies[1]['result']['content'][0]['text'])['data']
            self.assertEqual(cli['library'][0]['id'],mcp['library'][0]['id'])
            self.assertEqual(cli['jobs'][0]['id'],mcp['jobs'][0]['id'])

    def test_snapshot_refreshes_running_study_without_resubmission(self):
        import threading
        with tempfile.TemporaryDirectory() as root:
            (Path(root)/'clip.mp4').write_bytes(b'fixture')
            bridge=DesktopBridge(self.config(root),root)
            try:
                item=bridge.snapshot()['state']['library'][0]
                bridge.dispatch({'action':'select-item','id':item['id']})
                folder=bridge._store.meta/'study'/item['id'];folder.mkdir(parents=True)
                bridge._store.item_meta(item['id'],study={'folder':str(folder),'jobId':'suite_live','state':'running'})
                (folder/'job.json').write_text(json.dumps({'id':'suite_live','state':'evidence_ready','stages':[],'created_at':0}))
                bridge._state['study']={'status':'ready','sourceItemId':item['id'],'state':'running','artifacts':[]}
                bridge._last_scan=0;bridge._last_study_poll=0
                result={'status':'ready','sourceItemId':item['id'],'jobId':'suite_live','state':'evidence_ready','artifacts':[{'id':'probe'}]}
                with patch.object(bridge._study,'status',return_value=result) as status,patch.object(bridge._study,'submit') as submit:
                    bridge.snapshot()
                    deadline=time.monotonic()+2
                    while bridge._study_inflight and time.monotonic()<deadline:time.sleep(.01)
                    snapshot=bridge.snapshot()['state']
                    self.assertEqual(snapshot['study']['state'],'evidence_ready')
                    self.assertEqual(snapshot['selectedItem']['artifacts'],[{'id':'probe'}])
                    self.assertEqual(status.call_count,1);submit.assert_not_called()
                    bridge._last_scan=0;bridge._last_study_poll=0;bridge.snapshot()
                    self.assertEqual(status.call_count,1)
            finally:bridge.close()

    def test_slow_study_response_does_not_replace_another_selected_item(self):
        import threading
        with tempfile.TemporaryDirectory() as root:
            for name in ('one.mp4','two.mp4'):(Path(root)/name).write_bytes(b'fixture')
            bridge=DesktopBridge(self.config(root),root);release=threading.Event();started=threading.Event()
            try:
                first,second=bridge.snapshot()['state']['library']
                bridge.dispatch({'action':'select-item','id':first['id']})
                def status(item):
                    started.set();release.wait(2)
                    return {'status':'ready','sourceItemId':item['id'],'state':'evidence_ready','artifacts':[]}
                with patch.object(bridge._study,'status',side_effect=status):
                    bridge.dispatch({'action':'study-status','id':first['id']});self.assertTrue(started.wait(1))
                    bridge.dispatch({'action':'select-item','id':second['id']});release.set()
                    deadline=time.monotonic()+2
                    while bridge._study_inflight and time.monotonic()<deadline:time.sleep(.01)
                    self.assertEqual(bridge._state['selectedItem']['id'],second['id'])
                    self.assertEqual(bridge._state['study']['status'],'idle')
            finally:release.set();bridge.close()

if __name__=='__main__':unittest.main()
