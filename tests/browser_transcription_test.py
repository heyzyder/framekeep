import base64
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import wave

sys.path.insert(0,str(Path(__file__).parents[1]/'native'))
from browser_transcription import BrowserTranscription, MAX_CHUNK, settle_segments
from library_state import Library
import host


class FakeEngine:
    def __init__(self,config):self.calls=0;self.closed=False;self.info={'ready':True}
    def transcribe(self,pcm,language):
        self.calls+=1
        if not any(pcm):return {'segments':[],'language':language or 'und','processingSeconds':0}
        length=len(pcm)/32000
        return {'segments':[{'start':0,'end':length,'text':' one two',
            'words':[{'start':0,'end':min(length,1),'text':' one'}, {'start':max(1,length-1),'end':length,'text':' two'}]}],
            'language':language or 'en','processingSeconds':0.02}
    def close(self):self.closed=True


class BrowserTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='framekeep-browser-test-');self.addCleanup(self.temp.cleanup)
        self.library=Library(self.temp.name);self.adapter=BrowserTranscription({'directory':self.temp.name},self.library,FakeEngine)
        self.addCleanup(lambda:self.adapter.stop(interrupted=True))
    def start(self):return self.adapter.start({'sessionId':'fixture-session','url':'https://example.org/authored','title':'Authored speech','language':'en'})
    def chunk(self,n,pcm=None):return self.adapter.chunk({'sessionId':'fixture-session','sequence':n,'pcm':base64.b64encode(pcm if pcm is not None else b'\x01\x02'*(MAX_CHUNK//2)).decode()})

    def test_incremental_before_stop_and_same_durable_desktop_item(self):
        self.start()
        for n in range(6):result=self.chunk(n)
        self.assertEqual(result['status'],'recording');self.assertTrue(result['cues']);self.assertTrue(result['provisional'])
        engine=self.adapter.engine
        for n in range(6,10):self.chunk(n)
        self.assertIs(self.adapter.engine,engine);self.assertEqual(engine.calls,2)
        result=self.adapter.stop()
        self.assertEqual(result['status'],'stopped');self.assertTrue(engine.closed)
        item=self.library.item('fixture-session');self.assertEqual(item['kind'],'audio')
        track=self.library.item_meta(item['id'])['transcriptTracks'][0]
        self.assertEqual(track['source'],'generated-live');self.assertFalse(track['sourceTiming']);self.assertTrue(track['partial'])
        self.assertEqual(self.library.get_job(item['id'])['sourceItemId'],item['id'])
        with wave.open(str(self.library.path(item['filename']))) as audio:self.assertEqual(audio.getnframes(),160000)

    def test_sequence_size_identity_and_native_envelope_limits(self):
        self.start()
        with self.assertRaises(ValueError):self.chunk(1)
        with self.assertRaises(ValueError):self.chunk(0,b'a'*(MAX_CHUNK+2))
        with self.assertRaises(ValueError):self.adapter.chunk({'sessionId':'other','sequence':0,'pcm':'AA=='})
        message={'id':'r','action':'browser-chunk','sessionId':'fixture-session','sequence':0,'pcm':base64.b64encode(bytes(MAX_CHUNK)).decode()}
        self.assertLess(len(json.dumps(message).encode()),host.MAX_MESSAGE)

    def test_silence_yields_no_words_and_interruption_keeps_audio(self):
        self.start()
        for n in range(6):result=self.chunk(n,bytes(MAX_CHUNK))
        self.assertEqual(result['cues'],[]);self.assertIsNone(result['metrics']['firstTextSeconds'])
        result=self.adapter.stop('Fixture disconnected',True,2)
        self.assertEqual(result['status'],'interrupted');self.assertEqual(result['metrics']['droppedChunks'],2)
        self.assertTrue(self.library.path(self.library.item('fixture-session')['filename']).is_file())

    def test_partial_receipt_has_stable_item_before_stop(self):
        self.start();self.chunk(0)
        self.assertEqual(self.library.item('fixture-session')['id'],'fixture-session')
        with wave.open(str(self.library.path(self.library.item('fixture-session')['filename']))) as audio:self.assertEqual(audio.getnframes(),16000)

    def test_overlap_does_not_duplicate_settled_words(self):
        rows=[{'start':0,'end':3,'text':'Hello there friend','words':[{'start':0,'end':1,'text':'Hello'}, {'start':1,'end':2,'text':' there'}, {'start':2,'end':3,'text':' friend'}]}]
        settled,provisional=settle_segments(rows,5,6,7)
        self.assertEqual([x['text'] for x in settled],['there']);self.assertEqual([x['text'] for x in provisional],['friend'])

    def test_model_failure_is_counted_and_partial_audio_survives(self):
        self.start()
        for n in range(5):self.chunk(n)
        def failure(*args):raise RuntimeError('Synthetic inference interruption')
        self.adapter.engine.transcribe=failure
        with self.assertRaises(RuntimeError):self.chunk(5)
        result=self.adapter.stop('Synthetic interruption',True)
        self.assertEqual(result['metrics']['failedChunks'],1)
        self.assertEqual(result['seconds'],6)
        self.assertEqual(self.library.get_job('fixture-session')['transcriptState'],'interrupted')

    def test_boundary_word_drift_does_not_duplicate_the_settled_suffix(self):
        rows=[{'start':4.7,'end':5.8,'text':'hello friend','words':[{'start':4.7,'end':5.2,'text':' hello'},{'start':5.2,'end':5.8,'text':' friend'}]}]
        settled,_=settle_segments(rows,0,4.9,6,settled_text='Say hello')
        self.assertEqual([cue['text'] for cue in settled],['friend'])
        self.assertEqual(settled[0]['start'],5.2)
        repeated=[{'start':5.0,'end':5.5,'text':'hello','words':[{'start':5.0,'end':5.5,'text':' hello'}]}]
        settled,_=settle_segments(repeated,0,4.9,6,settled_text='Say hello')
        self.assertEqual([cue['text'] for cue in settled],['hello'])

    def test_interrupted_provisional_text_has_distinct_desktop_track(self):
        self.start()
        for n in range(6):self.chunk(n)
        self.adapter.stop('Interrupted fixture',True)
        tracks=self.library.item_meta('fixture-session')['transcriptTracks']
        self.assertEqual(len(tracks),2);self.assertTrue(tracks[1]['provisional'])
        self.assertIn('Unsettled',tracks[1]['name'])
        self.assertTrue((self.library.meta/'live/fixture-session-windows.jsonl').is_file())


if __name__=='__main__':unittest.main()
