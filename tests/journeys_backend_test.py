"""Synthetic end-to-end metadata and transcript journeys; never opens owner media."""
import hashlib
import json
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import wave
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'native'))
from library_state import Library
from study_adapter import StudyAdapter
from desktop_bridge import DesktopBridge, transcript_export
from media_preview import PreviewServer, verified_mime


class JourneyBackendTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.root=Path(self.temp.name)
        self.store=Library(self.root)
        self.config={'directory':str(self.root),'node':sys.executable,'ffmpeg':sys.executable,
                     'ffprobe':sys.executable,'studySuite':str(self.root/'study.py')}
        (self.root/'study.py').write_text('# synthetic adapter marker')
    def tearDown(self): self.temp.cleanup()
    def media(self,name='sample.mp4'):
        (self.root/name).write_bytes(b'authored synthetic media')
        return next(i for i in self.store.scan()[0] if i['filename']==name)
    def probe(self,streams,format='mov,mp4,m4a,3gp,3g2,mj2'):
        return patch('study_adapter.subprocess.run',return_value=subprocess.CompletedProcess([],0,json.dumps({'streams':streams,'format':{'format_name':format}}).encode(),b''))
    def evidence(self,item,segments,recipe='speech'):
        folder=self.store.meta/'study'/item['id']; folder.mkdir(parents=True,exist_ok=True)
        artifact=folder/'original.json'; artifact.write_text(json.dumps({'language':'vi','segments':segments}),encoding='utf-8')
        digest=hashlib.sha256(artifact.read_bytes()).hexdigest()
        source=self.root/item['filename']
        (folder/'evidence.json').write_text(json.dumps({'job_id':'study-one','source':{'path':str(source),'sha256':hashlib.sha256(source.read_bytes()).hexdigest()},
            'artifacts':[{'id':'speech-1','mode':'transcribe','path':str(artifact),'sha256':digest,'coverage':{'start_s':0,'end_s':12}}]}))
        (folder/'job.json').write_text(json.dumps({'id':'study-one','state':'evidence_ready','created_at':0}))
        self.store.item_meta(item['id'],study={'folder':str(folder),'recipe':recipe,'jobId':'study-one'})
        return artifact

    def test_legacy_label_migrates_to_durable_identity_and_empty_collection_survives_restart(self):
        a=self.media('one.mp4'); b=self.media('two.mp4')
        for item in (a,b): self.store.item_meta(item['id'],collection='Lessons')
        rows=self.store.collections(); self.assertEqual(len(rows),1); original=rows[0]['id']
        self.assertEqual(set(rows[0]['itemIds']),{a['id'],b['id']})
        self.store.collection_action('collection-rename',{'id':original,'name':'My lessons'})
        self.store.collection_action('collection-reorder',{'id':original,'itemIds':[a['id'],b['id']]})
        fresh=Library(self.root); self.assertEqual(fresh.collections()[0],{'id':original,'name':'My lessons','itemIds':[a['id'],b['id']]})
        fresh.collection_action('collection-membership',{'collectionId':original,'itemIds':[a['id'],b['id']],'remove':True})
        self.assertEqual(Library(self.root).collections()[0]['itemIds'],[])
        fresh.collection_action('collection-delete',{'id':original})
        self.assertEqual(Library(self.root).collections(),[])
        self.assertTrue((self.root/'one.mp4').exists()); self.assertTrue((self.root/'two.mp4').exists())
        self.assertEqual(Library(self.root).item(a['id'])['collection'],'')

    def test_collection_multi_membership_rename_and_missing_playlist_member_preserved(self):
        item=self.media(); original=(self.root/item['filename']).read_bytes()
        ids=[]
        for name in ('A','B'):
            row=self.store.collection_action('collection-create',{'name':name}); ids.append(row['id'])
            self.store.collection_action('collection-membership',{'collectionId':row['id'],'itemIds':[item['id']]})
        self.store.rename(item['id'],'A display title')
        fresh=Library(self.root).item(item['id']); self.assertEqual(fresh['title'],'A display title'); self.assertEqual(fresh['collectionIds'],ids)
        self.assertEqual((self.root/item['filename']).read_bytes(),original)
        with self.assertRaises(ValueError): self.store.collection_action('collection-reorder',{'id':ids[0],'itemIds':[]})
        (self.root/item['filename']).unlink() # exclusively synthetic fixture
        self.assertEqual(Library(self.root).collections()[0]['itemIds'],[item['id']])

    def test_actual_streams_gate_speech_images_and_silent_video(self):
        item=self.media(); adapter=StudyAdapter(self.config,self.store)
        with self.probe([{'codec_type':'video'}]),patch.object(adapter,'_call') as call:
            self.assertFalse(adapter.media_capabilities(item)['speech'])
            with self.assertRaisesRegex(ValueError,'no audio'): adapter.submit(item,'speech')
            call.assert_not_called()
        adapter=StudyAdapter(self.config,self.store)
        with self.probe([{'codec_type':'video'}],'png_pipe'),patch.object(adapter,'_call') as call:
            caps=adapter.media_capabilities(item); self.assertEqual(caps['kind'],'image'); self.assertFalse(caps['playback'])
            with self.assertRaisesRegex(ValueError,'image'): adapter.submit(item,'speech')
            call.assert_not_called()
        adapter=StudyAdapter(self.config,self.store)
        with self.probe([{'codec_type':'audio'},{'codec_type':'video','disposition':{'attached_pic':1}}]):
            caps=adapter.media_capabilities(item); self.assertEqual(caps['kind'],'audio'); self.assertTrue(caps['speech']); self.assertFalse(caps['visual'])
        adapter=StudyAdapter(self.config,self.store)
        with self.probe([]),patch.object(adapter,'_call') as call:
            self.assertEqual(adapter.media_capabilities(item)['kind'],'unknown')
            with self.assertRaises(ValueError): adapter.submit(item,'speech')
            call.assert_not_called()

    def test_existing_generated_track_opens_without_captions_or_retranscription_and_preserves_original(self):
        item=self.media(); artifact=self.evidence(item,[{'start':1.25,'end':3.5,'text':'Xin chào.'}]); original=artifact.read_bytes()
        bridge=DesktopBridge(self.config,self.root)
        try:
            with self.probe([{'codec_type':'audio'}]),patch.object(bridge,'_study_action'),patch.object(bridge._study,'submit') as submit:
                self.assertEqual(bridge.dispatch({'action':'select-item','id':item['id']}),{'ok':True})
                selected=bridge.snapshot()['state']['selectedItem']; track=selected['transcript']
                self.assertEqual(track['source'],'generated'); self.assertEqual(track['language'],'vi'); self.assertEqual(track['cues'][0]['start'],1.25)
                self.assertIn('00:00:01,250 --> 00:00:03,500',transcript_export(track,'srt'))
                self.assertIn('WEBVTT',transcript_export(track,'vtt')); self.assertIn('[00:01] Xin chào.',transcript_export(track))
                self.assertEqual(artifact.read_bytes(),original); submit.assert_not_called()
                job=next(j for j in bridge._state['jobs'] if j['id']=='study-one')
                self.assertEqual(job['sourceItemId'],item['id']); self.assertEqual(job['sourceTitle'],item['title'])
        finally: bridge.close()

    def test_invalid_timing_does_not_fabricate_cues_or_subtitle_export(self):
        item=self.media(); self.evidence(item,[{'text':'Text without timestamps.'}])
        track=StudyAdapter(self.config,self.store).transcript_tracks(item)[0]
        self.assertFalse(track['timed']); self.assertEqual(track['cues'],[])
        self.assertEqual(transcript_export(track),'Text without timestamps.')
        with self.assertRaisesRegex(ValueError,'no valid timing'): transcript_export(track,'vtt')

    def test_source_languages_and_imported_sidecar_remain_distinct(self):
        item=self.media(); sidecar=self.root/'sample.vtt'
        sidecar.write_text('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nImported original\n')
        original=sidecar.read_bytes()
        for language,text in [('en','English original'),('vi','Vietnamese original')]:
            self.store.save_captions(item['id'],{'status':'ready','source':'source-captions','language':language,'cues':[{'start':0,'end':1,'text':text}]})
        tracks=Library(self.root).caption_tracks(item)
        self.assertEqual(len(tracks),3); self.assertEqual(len({t['id'] for t in tracks}),3)
        self.assertEqual({t['language'] for t in tracks},{'en','vi','und'}); self.assertEqual(sidecar.read_bytes(),original)

    def test_generated_artifact_changed_source_and_output_are_rejected(self):
        item=self.media(); artifact=self.evidence(item,[{'start':0,'end':1,'text':'Test'}]); adapter=StudyAdapter(self.config,self.store)
        artifact.write_text('{}')
        with self.assertRaisesRegex(ValueError,'integrity'): adapter.transcript_tracks(item)

    def test_adding_speech_preserves_existing_visual_job_and_history(self):
        item=self.media(); folder=self.store.meta/'study'/item['id']; folder.mkdir(parents=True)
        job=folder/'job.json'; job.write_text(json.dumps({'id':'visual-original','state':'evidence_ready','created_at':0}))
        original=job.read_bytes(); self.store.item_meta(item['id'],study={'folder':str(folder),'recipe':'visual','jobId':'visual-original'})
        adapter=StudyAdapter(self.config,self.store)
        with self.probe([{'codec_type':'video'},{'codec_type':'audio'}]),patch.object(adapter,'_call',return_value={'state':'submitted'}) as call,patch.object(adapter,'status',return_value={'state':'submitted'}):
            adapter.submit(item,'speech')
            self.assertEqual(call.call_args.args[1]['out'],str(folder/'speech'))
        meta=self.store.item_meta(item['id']); self.assertEqual(meta['studyHistory'][0]['jobId'],'visual-original')
        self.assertEqual(meta['study']['recipe'],'speech'); self.assertEqual(job.read_bytes(),original)
        self.assertTrue(any(j['id']=='visual-original' for j in self.store.scan()[1]))

    def test_missing_and_hidden_sources_keep_derived_history_without_title_matching(self):
        item=self.media(); self.evidence(item,[{'start':0,'end':1,'text':'Preserved'}])
        self.store.rename(item['id'],'Known display name')
        job_path=self.store.meta/'study'/item['id']/'job.json'; original=job_path.read_bytes()
        (self.root/item['filename']).unlink() # synthetic source only
        items,jobs=Library(self.root).scan(); self.assertEqual(items,[])
        job=next(j for j in jobs if j['id']=='study-one')
        self.assertEqual(job['sourceItemId'],item['id']); self.assertTrue(job['sourceUnavailable']); self.assertFalse(job['canResume'])
        self.assertIn('Known display name',job['title']); self.assertIn('missing',job['sourceUnavailableReason'])
        (self.root/item['filename']).write_bytes(b'authored synthetic media')
        self.store.item_meta(item['id'],hidden=True)
        job=next(j for j in Library(self.root).scan()[1] if j['id']=='study-one')
        self.assertIn('hidden',job['sourceUnavailableReason']); self.assertEqual(job_path.read_bytes(),original)
        self.store.item_meta(item['id'],hidden=False)
        job=next(j for j in Library(self.root).scan()[1] if j['id']=='study-one')
        self.assertNotIn('sourceUnavailable',job)

    def test_existing_preferences_receive_controls_intro_without_resetting_preferences(self):
        settings={'appearance':'dark','notifications':False,'quality':'720'}
        (self.root/'desktop-settings.json').write_text(json.dumps(settings))
        bridge=DesktopBridge(self.config,self.root)
        try:
            prefs=bridge._state['settings']; self.assertEqual(prefs['tourState'],'skipped'); self.assertFalse(prefs['controlsIntroSeen'])
            self.assertEqual(prefs['appearance'],'dark'); self.assertFalse(prefs['notifications']); self.assertEqual(prefs['quality'],'720')
        finally: bridge.close()
        self.assertEqual(json.loads((self.root/'desktop-settings.json').read_text()),settings)

    def test_visible_growing_audio_does_not_mark_live_job_complete(self):
        self.media('Browser audio live-fixture.wav')
        self.store.begin({'id':'live-fixture','action':'live-transcript','kind':'audio','url':'https://example.org/authored'})
        job=self.store.get_job('live-fixture'); job.update(status='processing',outputs=[{'id':'live-fixture','filename':'Browser audio live-fixture.wav','bytes':23}])
        self.store._write(self.store.meta/'jobs'/'live-fixture.json',job)
        bridge=DesktopBridge(self.config,self.root)
        try:
            with self.probe([{'codec_type':'audio'}]):
                snapshot=bridge.snapshot()['state']; live=next(j for j in snapshot['jobs'] if j['id']=='live-fixture')
                self.assertEqual(live['status'],'processing'); self.assertNotIn('finished',live)
                self.assertFalse(live['canCancel']); self.assertIn('browser toolbar',live['detail'])
                self.assertEqual(snapshot['library'][0]['status'],'complete')
        finally: bridge.close()

    def test_only_hash_verified_original_sampled_frames_become_preview_candidates(self):
        item=self.media(); folder=self.store.meta/'study'/item['id']; folder.mkdir(parents=True)
        image=folder/'frame-0000.jpg'; image.write_bytes(b'authored fixture pixels')
        manifest=folder/'data.json'; manifest.write_text(json.dumps({'frames':[{'file':image.name,'time_s':2.75,'sha256':hashlib.sha256(image.read_bytes()).hexdigest()}]}))
        adapter=StudyAdapter(self.config,self.store)
        records=[{'id':'frames-1','mode':'frames','path':str(manifest)}]
        frames=adapter.frames(item,records)
        self.assertEqual(frames[0]['sourceItemId'],item['id']); self.assertEqual(frames[0]['time'],2.75)
        self.assertEqual(self.store.path(frames[0]['filename']),image.resolve())
        image.write_bytes(b'altered fixture pixels')
        with self.assertRaisesRegex(ValueError,'integrity'): adapter.frames(item,records)
        manifest.write_text(json.dumps({'frames':[{'file':'../escaped.jpg','time_s':1,'sha256':'0'*64}]}))
        with self.assertRaisesRegex(ValueError,'outside'): adapter.frames(item,records)

    def test_preview_mime_uses_verified_container_and_safe_unknown_fallback(self):
        item=self.media('misnamed.png'); server=PreviewServer(self.store)
        try:
            mime=verified_mime({'format':{'format_name':'wav'}},'audio')
            with urlopen(Request(server.url(item['filename'],mime),headers={'Range':'bytes=0-3'})) as response:
                self.assertEqual(response.status,206); self.assertEqual(response.headers['Content-Type'],'audio/wav')
                self.assertEqual(response.headers['X-Content-Type-Options'],'nosniff'); self.assertIn('sandbox',response.headers['Content-Security-Policy'])
            (self.root/'hostile.svg').write_text('<html><script>alert(1)</script></html>')
            with urlopen(server.url('hostile.svg','text/html')) as response:
                self.assertEqual(response.headers['Content-Type'],'application/octet-stream')
                self.assertEqual(response.headers['Content-Disposition'],'attachment'); self.assertIn('sandbox',response.headers['Content-Security-Policy'])
            url=server.url(item['filename'],'audio/wav'); (self.root/item['filename']).write_bytes(b'replaced with different bytes')
            with self.assertRaises(HTTPError) as caught: urlopen(url)
            self.assertEqual(caught.exception.code,404)
        finally: server.close()
        ambiguous={'format':{'format_name':'matroska,webm'}}
        self.assertEqual(verified_mime(ambiguous,'video',b'\x42\x82\x84webm'),'video/webm')
        self.assertEqual(verified_mime(ambiguous,'video',b'\x42\x82\x88matroska'),'video/x-matroska')

    @unittest.skipUnless(shutil.which('ffprobe') and shutil.which('ffmpeg'),'Installed FFmpeg tools required for real stream verification')
    def test_real_authored_audio_and_silent_video_streams(self):
        audio=self.root/'authored.wav'
        with wave.open(str(audio),'wb') as output:
            output.setparams((1,2,16000,0,'NONE','not compressed')); output.writeframes(b'\0\0'*16000)
        video=self.root/'silent.mp4'
        subprocess.run([shutil.which('ffmpeg'),'-nostdin','-v','error','-f','lavfi','-i','color=c=black:s=64x64:d=0.5','-an','-c:v','mpeg4',str(video)],check=True,capture_output=True,
                       creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        config={**self.config,'ffprobe':shutil.which('ffprobe')}; adapter=StudyAdapter(config,self.store)
        items={i['filename']:i for i in self.store.scan()[0]}
        self.assertEqual(adapter.media_capabilities(items['authored.wav'])['kind'],'audio')
        self.assertTrue(adapter.media_capabilities(items['authored.wav'])['speech'])
        self.assertEqual(adapter.media_capabilities(items['silent.mp4'])['kind'],'video')
        self.assertFalse(adapter.media_capabilities(items['silent.mp4'])['hasAudio'])
        with self.assertRaisesRegex(ValueError,'no audio'): adapter.submit(items['silent.mp4'],'speech')
        renamed=self.root/'audio-disguised-as-image.png'; renamed.write_bytes(audio.read_bytes())
        renamed_item=next(i for i in self.store.scan()[0] if i['filename']==renamed.name)
        caps=adapter.media_capabilities(renamed_item)
        self.assertEqual(caps['kind'],'audio'); self.assertEqual(caps['mimeType'],'audio/wav')

    def test_bridge_preferences_and_hidden_item_restore_persist(self):
        item=self.media(); bridge=DesktopBridge(self.config,self.root)
        try:
            with self.probe([{'codec_type':'audio'}]):
                self.assertEqual(bridge.dispatch({'action':'settings','appearance':'dark','autoplayNext':True,'transcriptTextSize':20,'tourState':'skipped'}),{'ok':True})
                self.assertEqual(bridge.dispatch({'action':'remove-item','id':item['id']}),{'ok':True})
                self.assertEqual(bridge.snapshot()['state']['library'],[]); self.assertTrue((self.root/item['filename']).exists())
                self.assertEqual(bridge.dispatch({'action':'restore-item','id':item['id']}),{'ok':True})
                self.assertEqual(len(bridge.snapshot()['state']['library']),1)
                with patch('recycle.recycle_file') as recycle:
                    self.assertIn('error',bridge.dispatch({'action':'trash-item','id':item['id']})); recycle.assert_not_called()
        finally: bridge.close()
        fresh=DesktopBridge(self.config,self.root)
        try:
            self.assertEqual(fresh._state['settings']['appearance'],'dark'); self.assertEqual(fresh._state['settings']['tourState'],'skipped')
            self.assertEqual(fresh._state['settings']['transcriptTextSize'],20); self.assertTrue(fresh._state['settings']['autoplayNext'])
        finally: fresh.close()

if __name__=='__main__': unittest.main()
