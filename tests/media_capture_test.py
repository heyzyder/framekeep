import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'native'))
import media_capture as capture

def task():return {'cancelled':threading.Event(),'lock':threading.Lock()}

class MediaCaptureTests(unittest.TestCase):
    def test_rejects_private_credentials_schemes_and_ports(self):
        for url in ['file:///a.png','https://user:pass@example.org/a.png','http://127.0.0.1/a.png','http://192.168.1.2/a.png','http://localhost/a.png','https://example.org:444/a.png','https://a.internal/a.png']:
            with self.subTest(url=url),self.assertRaises(ValueError):capture.validate_url(url)
    def test_dns_checks_every_answer_before_connecting(self):
        values=[(2,1,6,'',('93.184.216.34',443)),(2,1,6,'',('127.0.0.1',443))]
        with patch.object(capture.socket,'getaddrinfo',return_value=values),self.assertRaises(ValueError):capture.public_addresses('example.org',443)
    def test_collision_free_safe_names(self):
        self.assertEqual(capture.filename(capture.validate_url('https://example.org/CON.png'),1,'.png'),'001-media-CON.png')
        self.assertNotIn('/',capture.filename(capture.validate_url('https://example.org/a%2fb.png'),1,'.png'))
    def test_html_and_incomplete_downloads_fail(self):
        class Response(io.BytesIO):
            def getheader(self,name,default=None):return {'Content-Type':'image/png','Content-Length':'99'}.get(name,default)
        class Connection:
            def close(self):pass
        with tempfile.TemporaryDirectory() as tmp:
            response=Response(b'partial')
            with patch.object(capture,'open_public',return_value=(response,Connection(),capture.validate_url('https://example.org/a.png'))),self.assertRaisesRegex(ValueError,'incomplete'):
                capture.download_one({'url':'https://example.org/a.png'},1,Path(tmp),1000,task()['cancelled'],lambda *_:None)
            response=Response(b'<html>');response.getheader=lambda name,default=None:'text/html' if name=='Content-Type' else None
            with patch.object(capture,'open_public',return_value=(response,Connection(),capture.validate_url('https://example.org/a.png'))),self.assertRaisesRegex(ValueError,'supported'):
                capture.download_one({'url':'https://example.org/a.png'},2,Path(tmp),1000,task()['cancelled'],lambda *_:None)
    def fixture(self,item,index,sources,*args):
        directory=sources/'other';directory.mkdir(exist_ok=True)
        path=directory/f'{index:03d}-sample.webp';path.write_bytes(b'original-webp-fixture-'+bytes([index]))
        return {'source':path,'sha256':capture.digest(path),'bytes':path.stat().st_size,'sanitize':False,'mime':'image/webp'}
    def test_batch_preserves_originals_publishes_all_and_labels_unsupported(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(capture,'download_one',side_effect=self.fixture):
            events=[];capture.run_capture({'directory':tmp},{'items':[{'url':f'https://example.org/{i}.webp','kind':'image'} for i in range(10)]},task(),events.append)
            self.assertEqual(events[-1]['event'],'complete');self.assertEqual(len(events[-1]['files']),10)
            final=Path(tmp)/events[-1]['folder'];receipt=json.loads((final/'capture-report.json').read_text())
            self.assertTrue(all(not f['sanitized'] and not f['reencoded'] for f in receipt['files']))
            for f in receipt['files']:self.assertEqual(capture.digest(final/f['filename']),capture.digest(Path(receipt['originals'])/'other'/f['filename']))
            self.assertEqual(list(Path(tmp).glob('.framekeep-*')),[])
    def test_late_download_failure_does_not_publish_partial_batch(self):
        def fail(item,index,sources,*args):
            if index==2:raise ValueError('fixture failure')
            return self.fixture(item,index,sources,*args)
        with tempfile.TemporaryDirectory() as tmp,patch.object(capture,'download_one',side_effect=fail):
            events=[]
            with self.assertRaisesRegex(ValueError,'fixture failure'):capture.run_capture({'directory':tmp},{'items':[{'url':f'https://example.org/{i}.webp','kind':'image'} for i in range(3)]},task(),events.append)
            self.assertEqual(list(Path(tmp).glob('Capture-*')),[])
            self.assertEqual(len(list((Path(tmp)/'Originals').rglob('*.webp'))),1)
            self.assertFalse(any(e['event']=='complete' for e in events))
    def test_missing_sanitizer_never_falls_back_to_original(self):
        def image(*args):
            result=self.fixture(*args);result['sanitize']=True;return result
        with tempfile.TemporaryDirectory() as tmp,patch.object(capture,'download_one',side_effect=image),patch.object(capture,'sanitize_images',side_effect=ValueError('missing dependency')):
            with self.assertRaisesRegex(ValueError,'missing dependency'):capture.run_capture({'directory':tmp},{'items':[{'url':'https://example.org/a.png','kind':'image'}]},task(),lambda _:None)
            self.assertFalse(list(Path(tmp).glob('Capture-*')))
    def test_cancel_before_publication_retains_sources(self):
        t=task();t['cancelled'].set()
        with tempfile.TemporaryDirectory() as tmp,patch.object(capture,'download_one',side_effect=self.fixture):
            with self.assertRaisesRegex(ValueError,'cancelled'):capture.run_capture({'directory':tmp},{'items':[{'url':'https://example.org/a.webp','kind':'image'}]},t,lambda _:None)
            self.assertEqual(list(Path(tmp).glob('Capture-*')),[])
            self.assertEqual(list(Path(tmp).glob('.framekeep-*')),[])
    def test_duplicate_urls_fail_before_any_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError,'Duplicate'):capture.run_capture({'directory':tmp},{'items':[{'url':'https://example.org/a.png','kind':'image'}]*2},task(),lambda _:None)
            self.assertEqual(list(Path(tmp).iterdir()),[])
    def test_second_image_validation_failure_rolls_back_every_candidate(self):
        def image(item,index,sources,*args):
            folder=sources/'images';folder.mkdir(exist_ok=True)
            p=folder/f'{index}.png';p.write_bytes(b'synthetic-image-'+bytes([index]))
            return {'source':p,'sha256':capture.digest(p),'bytes':p.stat().st_size,'sanitize':True,'mime':'image/png'}
        def sanitizer(images,output,report,t):
            output.mkdir();results=[]
            for index,source in enumerate(sorted(images.iterdir())):
                candidate=output/source.name;candidate.write_bytes(source.read_bytes())
                results.append({'source':str(source),'output':str(candidate),'outputSha256':capture.digest(candidate),'sourceSha256Before':capture.digest(source),'sourceSha256After':capture.digest(source),'sourcePreserved':True,'reencoded':False,'dimensionsPreserved':index==0,'alphaPreserved':True,'decodedRgbaExact':True,'after':{'c2pa':{'independentAbsenceVerified':True}}})
            return {'results':results}
        with tempfile.TemporaryDirectory() as tmp,patch.object(capture,'download_one',side_effect=image),patch.object(capture,'sanitize_images',side_effect=sanitizer):
            with self.assertRaisesRegex(ValueError,'preservation checks'):capture.run_capture({'directory':tmp},{'items':[{'url':f'https://example.org/{i}.png','kind':'image'} for i in range(2)]},task(),lambda _:None)
            self.assertEqual(list(Path(tmp).glob('Capture-*')),[])
            self.assertEqual(list(Path(tmp).glob('.framekeep-*')),[])
            self.assertEqual(len(list((Path(tmp)/'Originals').rglob('*.png'))),2)

if __name__=='__main__':unittest.main()
