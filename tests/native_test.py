import importlib.util
import io
import json
from pathlib import Path
import struct
import tempfile
import threading
import unittest
import sys
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('host', Path(__file__).parents[1] / 'native' / 'host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
sys.path.insert(0, str(Path(__file__).parents[1] / 'native'))
from recycle import download_path


class FakeProcess:
    def __init__(self, lines, code=0):
        self.stdout = io.StringIO('\n'.join(lines))
        self.returncode = code
        self.pid = 12345
    def wait(self): return self.returncode
    def poll(self): return self.returncode


class NativeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='framekeep-unit-')
        self.addCleanup(self.temp.cleanup)
        self.config = {'node': 'C:/tools/node.exe', 'ffmpeg': 'C:/tools/ffmpeg.exe', 'directory': self.temp.name}

    def test_urls(self):
        for value in ['https://youtu.be/BaW_jenozKc?si=x', 'https://youtube.com/shorts/BaW_jenozKc', 'https://m.youtube.com/watch?v=BaW_jenozKc&list=x', 'https://youtube.com:443/watch?v=BaW_jenozKc']:
            self.assertEqual(host.normalize_url(value), 'https://www.youtube.com/watch?v=BaW_jenozKc')
        for value in ['https://youtube.com.evil.org/watch?v=BaW_jenozKc', 'https://user:pass@youtube.com/watch?v=BaW_jenozKc', 'https://youtube.com:90/watch?v=BaW_jenozKc', 'https://youtu.be/BaW_jenozKc/extra', 'https://youtube.com/playlist?list=x', None]:
            with self.assertRaises(ValueError): host.normalize_url(value)

    def test_page_source_retains_signed_stream_and_referer_without_cookies(self):
        source = {'url':'https://video.b-cdn.net/bcdn_token=fixture&expires=123/video/playlist.m3u8', 'pageUrl':'https://members.example.org/lesson/', 'type':'direct'}
        url, args = host.source_command(self.config, {'source':source})
        self.assertEqual(url, source['url']); self.assertEqual(args[-2:], ['--referer', source['pageUrl']]); self.assertNotIn('--cookies', args)
        for bad in ['http://127.0.0.1/video.mp4','https://user:pass@video.example.org/a.mp4','file:///C:/video.mp4','https://video.example.org/executable.exe']:
            with self.assertRaises(ValueError): host.source_request({'source':{**source,'url':bad}})

    def test_recycle_path_rejects_traversal_directories_and_non_media(self):
        for name in ['../video.mp4','C:\\video.mp4','video.mp4:secret','CON.mp4','video.mp4.','host.py','']:
            with self.assertRaises(ValueError): download_path(self.temp.name, name)
        self.assertIsNone(download_path(self.temp.name, 'missing.mp4'))
        path = Path(self.temp.name) / 'directory.mp4'; path.mkdir()
        with self.assertRaises(ValueError): download_path(self.temp.name, path.name)

    def test_recycle_action_waits_for_confirmation_and_reports_missing_files(self):
        path = Path(self.temp.name) / 'fixture.mp4'; path.write_bytes(b'fixture')
        output = io.BytesIO(); server = host.Host(self.config, output)
        with patch('recycle.recycle_file', side_effect=OSError('File is in use')):
            server.handle({'id':'a','action':'trash','filename':path.name})
        server.handle({'id':'b','action':'trash','filename':'missing.mp4'})
        output.seek(0)
        self.assertEqual(host.read_message(output)['event'],'error'); self.assertTrue(path.exists())
        self.assertEqual(host.read_message(output)['data']['fileState'],'missing')

    def test_frame_roundtrip_unicode(self):
        output = io.BytesIO()
        server = host.Host(self.config, output)
        server.emit({'id': 'abc', 'event': 'result', 'title': '日本語 • café'})
        output.seek(0)
        self.assertEqual(host.read_message(output)['title'], '日本語 • café')

    def test_all_platforms_and_lookalikes(self):
        self.assertEqual(len(host.PLATFORMS), 16)
        for platform in host.PLATFORMS[1:]:
            for domain in platform['domains']:
                self.assertEqual(host.normalize_url(f'https://{domain}/video/example?utm_source=test#tracking'), f'https://{domain}/video/example')
                with self.assertRaises(ValueError): host.normalize_url(f'https://{domain}.evil.test/video/example')
        self.assertEqual(host.normalize_url('https://vimeo.com/123?h=unlisted&utm_source=mail'), 'https://vimeo.com/123?h=unlisted')

    def test_frames_reject_oversize_truncation_and_arrays(self):
        for data in [b'\x01', struct.pack('<I', 70000), struct.pack('<I', 10) + b'{}', struct.pack('<I', 2) + b'[]']:
            with self.assertRaises(ValueError): host.read_message(io.BytesIO(data))
        self.assertIsNone(host.read_message(io.BytesIO()))

    def test_fragmented_pipe_reads(self):
        class Fragmented(io.BytesIO):
            def read(self, n): return super().read(min(n, 1))
        payload = b'{"id":"test"}'
        self.assertEqual(host.read_message(Fragmented(struct.pack('<I', len(payload)) + payload)), {'id':'test'})

    def test_download_arguments_are_allowlisted(self):
        message = {'url':'https://youtu.be/BaW_jenozKc', 'kind':'video', 'quality':'1080'}
        args = host.download_command(self.config, message)
        self.assertIn('bv[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4][height<=1080]', args)
        self.assertIn('--ignore-config', args)
        self.assertIn('--no-plugin-dirs', args)
        self.assertIn('--no-overwrites', args)
        self.assertEqual(args[-2], '--')
        self.assertNotIn('--cookies-from-browser', args)
        with self.assertRaises(ValueError): host.download_command(self.config, {**message, 'quality':'1080;calc.exe'})
        with self.assertRaises(ValueError): host.download_command(self.config, {**message, 'kind':'shell'})

    def test_audio_and_best(self):
        message = {'url':'https://youtu.be/BaW_jenozKc', 'kind':'audio', 'quality':'192'}
        args = host.download_command(self.config, message)
        self.assertIn('192K', args)
        self.assertIn('mp3', args)
        self.assertIn('bv[ext=mp4]+ba[ext=m4a]/b[ext=mp4]', host.download_command(self.config, {**message, 'kind':'video', 'quality':'best'}))

    def test_metadata_uses_available_mp4_heights(self):
        info = host.summarize({'id':'BaW_jenozKc','title':'Test','duration':11,'formats':[
            {'ext':'mp4','vcodec':'avc1','height':1080}, {'ext':'webm','vcodec':'vp9','height':2160}, {'ext':'mp4','vcodec':'avc1','height':1080}]})
        self.assertEqual(info['heights'], [1080])
        with self.assertRaises(ValueError): host.summarize({'id':'BaW_jenozKc','is_live':True})

    def test_caption_json3_preserves_timing_and_cleans_text(self):
        data = {'events': [{'tStartMs':1500,'dDurationMs':2000,'segs':[{'utf8':'Hello '},{'utf8':'&amp; welcome'}]}, {'tStartMs':4000,'segs':[{'utf8':'\n'}]}]}
        parsed = host.parse_captions(json.dumps(data), '.json3')
        self.assertEqual(parsed['cues'], [{'start':1.5,'duration':2.0,'text':'Hello & welcome'}])

    def test_vtt_and_srt_parsing_and_overlapping_duplicates(self):
        data = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000 align:start\n<v Narrator>Hello <c>world</c>\n\n00:00:02.900 --> 00:00:04.000\nHello world\n\n3\n00:00:06,000 --> 00:00:08,500\nNext sentence\n'
        cues = host.parse_captions(data, '.vtt')['cues']
        self.assertEqual(len(cues), 2); self.assertEqual(cues[0], {'start':1.0,'duration':3.0,'text':'Hello world'})
        self.assertEqual(cues[1]['duration'],2.5)

    def test_transcript_is_bounded_and_never_invents_missing_captions(self):
        self.assertEqual(host.parse_captions('WEBVTT\n', '.vtt')['cues'], [])
        events = [{'tStartMs':i*1000,'dDurationMs':100,'segs':[{'utf8':str(i)}]} for i in range(5100)]
        result = host.parse_captions(json.dumps({'events':events}), '.json3')
        self.assertTrue(result['truncated']); self.assertEqual(len(result['cues']),5000)

    def test_caption_tracks_prefer_manual_english_and_exclude_live_chat(self):
        source = {'id':'test','formats':[{'ext':'mp4','vcodec':'avc1','height':720}], 'automatic_captions': {'en':[{'ext':'json3','name':'English'}], 'de':[{'ext':'vtt'}]}, 'subtitles': {'en':[{'ext':'vtt','name':'English'}], 'live_chat':[{'ext':'json3'}]}}
        tracks = host.summarize(source)['tracks']
        self.assertEqual(tracks[0]['language'],'en'); self.assertFalse(tracks[0]['automatic']); self.assertEqual(len(tracks),2)

    def run_download(self, lines, code=0):
        output = io.BytesIO()
        server = host.Host(self.config, output)
        task = {'cancelled':threading.Event(), 'timed_out':threading.Event(), 'lock':threading.Lock()}
        server.jobs['test'] = task
        def fake_process(command, **kwargs):
            emitted = []
            for line in lines:
                if line.startswith('FK_FILE:'):
                    original = Path(json.loads(line.removeprefix('FK_FILE:')))
                    if original.parent == Path(self.temp.name) and original.is_file():
                        staged = Path(command[command.index('-P')+1]) / original.name
                        staged.write_bytes(original.read_bytes())
                        line = 'FK_FILE:' + json.dumps(str(staged))
                emitted.append(line)
            return FakeProcess(emitted, code)
        with patch.object(host.subprocess, 'Popen', side_effect=fake_process):
            server.run_job('test', 'download', ['not-executed','-P',self.temp.name], task)
        output.seek(0)
        messages = []
        while (message := host.read_message(output)) is not None: messages.append(message)
        self.assertEqual(server.jobs, {})
        return messages

    def test_complete_requires_verified_nonempty_output(self):
        result = self.run_download([])
        self.assertEqual(result[-1]['event'], 'error')
        file = Path(self.temp.name) / 'video.mp4'
        file.write_bytes(b'test fixture')
        result = self.run_download(['FK_PROGRESS:{"downloaded":5,"total":10}', 'FK_PROCESSING', 'FK_FILE:' + json.dumps(str(file))])
        self.assertEqual(result[0]['percent'], 50)
        self.assertEqual(result[1]['phase'], 'processing')
        self.assertEqual(result[-1]['event'], 'complete')
        self.assertEqual(result[-1]['bytes'], 12)

    def test_final_file_cannot_escape_output_directory(self):
        result = self.run_download(['FK_FILE:' + json.dumps(str(Path(__file__).resolve()))])
        self.assertEqual(result[-1]['event'], 'error')

    def test_missing_or_malformed_progress_does_not_abort_a_verified_download(self):
        file = Path(self.temp.name) / 'video.mp4'
        file.write_bytes(b'test fixture')
        result = self.run_download(['FK_PROGRESS:{"downloaded":1024,"speed":NA}',
                                    'FK_PROGRESS:{"downloaded":5,"total":10,"speed":null,"eta":null}',
                                    'FK_FILE:' + json.dumps(str(file))])
        self.assertEqual(result[0]['percent'], 50)
        self.assertIsNone(result[0]['speed']); self.assertIsNone(result[0]['eta'])
        self.assertEqual(result[-1]['event'], 'complete')
        command = host.download_command(self.config, {'url':'https://youtu.be/BaW_jenozKc','kind':'audio','quality':'192'})
        self.assertIn('%(progress.speed|null)j', ' '.join(command))

    def test_failure_does_not_become_success(self):
        result = self.run_download(['ERROR: HTTP Error 403 at https://example.com/signed?token=private'], 1)
        self.assertEqual(result[-1]['event'], 'error')
        self.assertNotIn('token=', result[-1]['error'])

    def test_real_downloader_template_handles_missing_course_codec_metadata(self):
        import yt_dlp
        command = host.download_command(self.config, {'url':'https://youtu.be/BaW_jenozKc','kind':'video','quality':'best'})
        template = command[command.index('--progress-template')+1].removeprefix('download:')
        ydl = yt_dlp.YoutubeDL({'quiet':True})
        rows = [ydl.evaluate_outtmpl(template, {'info':{},'progress':progress}) for progress in [
            {'downloaded_bytes':5,'total_bytes':10},
            {'downloaded_bytes':6,'total_bytes_estimate':10,'speed':2,'eta':2},
            {'downloaded_bytes':7,'fragment_index':3,'fragment_count':4}]]
        file = Path(self.temp.name)/'fixture.mp4'; file.write_bytes(b'test fixture')
        messages = self.run_download(rows+['FK_FILE:'+json.dumps(str(file))])
        self.assertEqual([m['percent'] for m in messages[:-1]], [50,60,75])
        self.assertEqual(messages[-1]['event'],'complete')

    def test_busy_and_unknown_requests(self):
        output = io.BytesIO()
        server = host.Host(self.config, output)
        server.jobs['active'] = {'action':'probe','cancelled':threading.Event()}
        server.handle({'id':'next','action':'probe','url':'https://youtu.be/BaW_jenozKc'})
        server.handle({'id':'other','action':'shell'})
        output.seek(0)
        self.assertEqual(host.read_message(output)['event'], 'error')
        self.assertEqual(host.read_message(output)['event'], 'error')

    def test_new_video_probe_can_run_while_download_continues(self):
        server = host.Host(self.config, io.BytesIO())
        server.jobs['download'] = {'action':'download','cancelled':threading.Event()}
        with patch.object(host.threading.Thread,'start'):
            server.handle({'id':'probe','action':'probe','url':'https://youtu.be/BaW_jenozKc'})
        self.assertEqual(set(server.jobs), {'download','probe'})
        self.assertFalse(server.jobs['download']['cancelled'].is_set())

    def test_downloads_have_no_fixed_parallel_count_limit(self):
        server = host.Host(self.config, io.BytesIO())
        with patch.object(host.threading.Thread,'start'):
            for i in range(16): server.handle({'id':str(i),'action':'download','url':'https://youtu.be/BaW_jenozKc','kind':'video','quality':'best'})
        self.assertEqual(len(server.jobs),16)

    def test_parallel_outputs_preserve_existing_file_and_use_distinct_names(self):
        from recycle import publish_download
        root=Path(self.temp.name); (root/'lesson.mp4').write_bytes(b'original')
        for name, content in [('a',b'first'),('b',b'second')]:
            stage=root/('.framekeep-'+name); stage.mkdir(); file=stage/'lesson.mp4'; file.write_bytes(content)
            saved=publish_download(file,root)
            self.assertEqual(saved.read_bytes(),content)
        self.assertEqual((root/'lesson.mp4').read_bytes(),b'original')
        self.assertEqual((root/'lesson (2).mp4').read_bytes(),b'first')
        self.assertEqual((root/'lesson (3).mp4').read_bytes(),b'second')


if __name__ == '__main__': unittest.main()
