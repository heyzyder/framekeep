import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).parents[1] / 'native'))
from desktop_bridge import DesktopBridge
import host

class DesktopTests(unittest.TestCase):
    def make(self, root):
        return DesktopBridge({'directory':str(root),'node':sys.executable,'ffmpeg':sys.executable},root)

    def test_no_console_and_snapshot_polling(self):
        with tempfile.TemporaryDirectory() as root, patch.object(sys,'stdout',None), patch.object(sys,'stderr',None):
            bridge=self.make(root)
            snap=bridge.snapshot(); self.assertIn('jobs',snap['state'])
            self.assertIsNone(bridge.snapshot(snap['revision']))
            bridge._server.close()

    def test_library_removes_deleted_file_and_preserves_failed_delete(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root); file=root/'lesson.mp4'; file.write_bytes(b'fixture')
            bridge=self.make(root); self.assertEqual(len(bridge.snapshot()['state']['jobs']),1)
            job=bridge._state['jobs'][0]
            bridge._requests['trash']={'action':'trash','filename':file.name}
            bridge._receive({'id':'trash','event':'error','error':'File in use'})
            self.assertEqual(bridge._state['jobs'][0]['fileError'],'File in use')
            file.unlink()
            bridge._requests['trash']={'action':'trash','filename':file.name}
            bridge._receive({'id':'trash','event':'result','data':{'fileState':'trashed'}})
            self.assertEqual(bridge.snapshot()['state']['jobs'],[])

    def test_dispatch_does_not_expose_arbitrary_host_operations(self):
        with tempfile.TemporaryDirectory() as root:
            bridge=self.make(root)
            self.assertIn('error',bridge.dispatch({'action':'run','command':'anything'}))
            self.assertIn('error',bridge.dispatch({'action':'analyze','url':'file:///C:/secret'}))
            self.assertIn('error',bridge.dispatch({'action':'download','kind':'video','quality':'best'}))

    def test_stale_thumbnail_does_not_replace_new_video(self):
        with tempfile.TemporaryDirectory() as root:
            bridge=self.make(root)
            bridge._state['probe']={'status':'ready','url':'new','source':{'url':'new'},'info':{}}
            bridge._requests['preview']={'action':'preview','source':{'url':'old'}}
            bridge._receive({'id':'preview','event':'result','data':{'thumbnail':'data:image/jpeg;base64,AAAA'}})
            self.assertNotIn('thumbnail',bridge._state['probe']['info'])

    def test_bad_pasted_link_clears_previous_ready_video(self):
        with tempfile.TemporaryDirectory() as root:
            bridge=self.make(root)
            bridge._state['probe']={'status':'ready','url':'https://youtube.com/watch?v=jNQXAC9IVRw','info':{}}
            self.assertIn('error',bridge.dispatch({'action':'analyze','url':'file:///private'}))
            self.assertEqual(bridge.snapshot()['state']['probe']['status'],'error')
            self.assertIn('error',bridge.dispatch({'action':'download','kind':'video','quality':'best'}))

    def test_pasted_lesson_replaces_source_after_host_resolution(self):
        with tempfile.TemporaryDirectory() as root:
            bridge=self.make(root)
            page='https://members.example.com/lesson'
            source={'url':'https://cdn.example.com/playlist.m3u8','pageUrl':page,'type':'direct','title':'Lesson'}
            with patch.object(bridge,'_request') as request:
                self.assertEqual(bridge.dispatch({'action':'analyze','url':page}),{'ok':True})
                request.assert_called_with('probe',url=page)
                bridge._requests['p']={'action':'probe','url':page}
                bridge._receive({'id':'p','event':'result','data':{'source':source,'heights':[720],'tracks':[]}})
                self.assertEqual(bridge._state['probe']['url'],source['url'])
                self.assertEqual(bridge._state['probe']['info']['title'],'Lesson')

    def test_preview_is_bounded_and_never_fetches_local_input(self):
        with patch('host.subprocess.run') as run:
            with self.assertRaises(ValueError): host.video_preview({'ffmpeg':'ffmpeg'},{'source':{'url':'file:///secret.mp4','pageUrl':'https://example.com','type':'direct'}})
            run.assert_not_called()
            run.return_value.returncode=0; run.return_value.stdout=b'\xff\xd8'+b'a'*130001
            source={'url':'https://example.com/video.mp4','pageUrl':'https://example.com/course','type':'direct'}
            self.assertEqual(host.video_preview({'ffmpeg':'ffmpeg'},{'source':source}),{'thumbnail':''})
            self.assertEqual(run.call_args.kwargs['timeout'],20)
            run.return_value.stdout=b'\xff\xd8jpeg'; self.assertTrue(host.video_preview({'ffmpeg':'ffmpeg'},{'source':source})['thumbnail'].startswith('data:image/jpeg;base64,'))

    def test_parallel_downloads_and_independent_updates(self):
        with tempfile.TemporaryDirectory() as root:
            bridge=self.make(root)
            bridge._state['probe']={'status':'ready','url':'https://youtu.be/jNQXAC9IVRw','info':{'title':'Video'}}
            with patch.object(bridge._server,'handle'):
                for i in range(16): self.assertEqual(bridge.dispatch({'action':'download','kind':'video','quality':str(144+i)}),{'ok':True})
            self.assertEqual(len(bridge._state['jobs']),16)
            first,second=bridge._state['jobs'][:2]
            bridge._receive({'id':first['id'],'event':'progress','percent':25,'downloaded':25,'total':100})
            bridge._receive({'id':second['id'],'event':'cancelled'})
            self.assertEqual(first['status'],'downloading'); self.assertEqual(first['percent'],25)
            self.assertEqual(second['status'],'cancelled')

if __name__=='__main__': unittest.main()
