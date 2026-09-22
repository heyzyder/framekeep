"""Original-copy capture is explicit and never a failed-cleaning fallback."""
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'native'))
import media_capture as capture

class OriginalCaptureTests(unittest.TestCase):
    def test_explicit_original_keeps_png_bytes_and_provenance_without_sanitizer(self):
        def download(item,index,sources,*args):
            p=sources/'images';p.mkdir();p=p/'sample.png';p.write_bytes(b'known-original-image')
            return {'source':p,'sha256':capture.digest(p),'bytes':p.stat().st_size,'sanitize':True,'mime':'image/png'}
        with tempfile.TemporaryDirectory() as tmp,patch.object(capture,'download_one',side_effect=download),patch.object(capture,'sanitize_images') as sanitize:
            events=[]
            capture.run_capture({'directory':tmp},{'items':[{'url':'https://example.org/sample.png','kind':'image'}],'imageMode':'original'}, {'cancelled':threading.Event(),'lock':threading.Lock()},events.append)
            sanitize.assert_not_called()
            final=Path(tmp)/events[-1]['folder']
            self.assertEqual((final/'sample.png').read_bytes(),b'known-original-image')
            receipt=json.loads((final/'capture-report.json').read_text())
            self.assertEqual(receipt['imageMode'],'original')
            self.assertFalse(receipt['files'][0]['sanitized'])
            self.assertEqual(receipt['files'][0]['sourceUrl'],'https://example.org/sample.png')

if __name__=='__main__':unittest.main()
