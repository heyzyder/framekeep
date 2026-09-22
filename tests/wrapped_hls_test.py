import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'native'))
import wrapped_hls as hls

SOURCE={'url':'https://v8.streamvsmov.com/stream/4ed18660-15f7-4dae-a6e2-03ae7ddd486a/master.m3u8','type':'direct'}
PACKETS=(b'\x47'+bytes(187))*5
PLAYLIST=b'#EXTM3U\n#EXTINF:6,\na.png\n#EXTINF:6,\nb.png\n#EXT-X-ENDLIST\n'

class WrappedTests(unittest.TestCase):
 def test_only_known_source_and_complete_plaintext_playlist(self):
  self.assertTrue(hls.matches(SOURCE));self.assertFalse(hls.matches({'url':SOURCE['url'].replace('streamvsmov.com','streamvsmov.com.evil.example'),'type':'direct'}))
  self.assertEqual(len(hls.playlist(PLAYLIST,SOURCE['url'])),2)
  for data in [PLAYLIST.replace(b'#EXT-X-ENDLIST',b''),PLAYLIST.replace(b'#EXTINF:6,',b'#EXT-X-KEY:METHOD=AES-128\n#EXTINF:6,',1),PLAYLIST.replace(b'a.png',b'file:///private.ts'),PLAYLIST.replace(b'a.png',b'http://127.0.0.1/a.ts')]:
   with self.assertRaises(ValueError):hls.playlist(data,SOURCE['url'])
 def test_transport_payload_must_match_every_packet(self):
  self.assertEqual(hls.transport_packets(PACKETS),PACKETS)
  self.assertEqual(hls.transport_packets(b'\x89PNG\r\n\x1a\n'+bytes(493)+PACKETS),PACKETS)
  for data in [b'',b'<html>'+PACKETS,PACKETS+b'junk',b'\x89PNG\r\n\x1a\n'+bytes(65536)+PACKETS]:
   with self.assertRaises(ValueError):hls.transport_packets(data)
 def test_cancelled_or_corrupt_late_segment_never_publishes(self):
  for cancel in (False,True):
   task={'action':'download','source':SOURCE,'kind':'video','quality':'best','cancelled':threading.Event(),'lock':threading.Lock()}
   calls=0
   def read(url,limit):
    nonlocal calls
    calls+=1
    if calls==1:return PLAYLIST,SOURCE['url']
    if calls==2:return PACKETS,url
    if cancel:task['cancelled'].set();return PACKETS,url
    return b'bad segment',url
   with tempfile.TemporaryDirectory() as tmp,patch.object(hls,'read_public',side_effect=read),patch.object(hls,'process',return_value=json.dumps({'streams':[{'codec_type':'video','height':1080}]}).encode()):
    with self.assertRaises(ValueError):hls.run_stream({'directory':tmp,'ffmpeg':'ffmpeg.exe'},task,lambda _:None)
    self.assertEqual(list(Path(tmp).iterdir()),[])

if __name__=='__main__':unittest.main()
