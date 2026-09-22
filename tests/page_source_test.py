import unittest
from pathlib import Path
import sys
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parents[1]/'native'))
import host
from page_source import PlayerHTML
import tempfile
import browser_sources

class PageSourceTests(unittest.TestCase):
    def test_player_attributes_preserve_signed_address(self):
        parser=PlayerHTML()
        parser.feed('<title>Nghiên cứu &amp; learning</title><presto-player src="https://cdn.example/v/playlist.m3u8?token=abc&amp;expires=123"></presto-player>')
        self.assertEqual(parser.media,['https://cdn.example/v/playlist.m3u8?token=abc&expires=123'])
        self.assertEqual(parser.title,'Nghiên cứu & learning')

    def test_lesson_resolves_to_source_and_preserves_referer(self):
        page='https://members.example.com/course/lesson'
        source={'url':'https://cdn.example.com/a.m3u8','type':'direct','pageUrl':page}
        with patch('page_source.resolve_page',return_value=source) as resolve:
            resolved=host.resolve_message({'url':page})
            self.assertEqual(resolved['source'],source)
            self.assertEqual(host.source_request(resolved)[1][-1],page)
            resolve.assert_called_once()

    def test_invalid_addresses_never_fetch(self):
        with patch('page_source.resolve_page') as resolve:
            for url in ['file:///private','http://127.0.0.1/lesson','https://user:pass@example.com/lesson','https://localhost/a','https://youtube.com/playlist?list=abc']:
                with self.assertRaises(ValueError): host.resolve_message({'url':url})
            resolve.assert_not_called()

    def test_browser_handoff_is_encrypted_scoped_and_expires(self):
        with tempfile.TemporaryDirectory() as directory:
            source={'url':'https://cdn.example.com/video.m3u8?token=fixture','pageUrl':'https://members.example.com/lesson','type':'direct'}
            browser_sources.remember(directory,source)
            file=next(Path(directory).glob('*.bin'))
            self.assertNotIn(b'token=fixture',file.read_bytes())
            self.assertEqual(browser_sources.lookup(directory,source['pageUrl']),source)
            self.assertIsNone(browser_sources.lookup(directory,'https://members.example.com/another'))
            with patch('browser_sources.time.time',return_value=browser_sources.time.time()+901):
                self.assertIsNone(browser_sources.lookup(directory,source['pageUrl']))
            self.assertFalse(file.exists())

if __name__=='__main__':unittest.main()
