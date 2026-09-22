import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'native'))
from podcast_audio import episode_id, parse_episode
import host

ID='2zTyabIrSSTlPes6AtFAeY'
URL='https://open.spotify.com/episode/'+ID

def page(audio, identifier=ID):
    data={'props':{'pageProps':{'state':{'data':{'entity':{'id':identifier,'type':'episode','title':'Public podcast','audioPreview':{'url':'https://cdn.example.org/preview.mp3'}},'defaultAudioFileObject':audio}}}}}
    return ('<script id="__NEXT_DATA__" type="application/json">'+json.dumps(data)+'</script>').encode()

class PodcastTests(unittest.TestCase):
    def test_strict_episode_identity(self):
        for value in [URL,URL+'?si=test','https://open.spotify.com/embed/episode/'+ID,'https://open.spotify.com/intl-en/episode/'+ID]:
            self.assertEqual(episode_id(value),ID)
        for value in ['https://open.spotify.com/track/'+ID,'https://open.spotify.com.evil.example/episode/'+ID,URL+'bad','file:///episode/'+ID]:
            self.assertIsNone(episode_id(value))

    def test_only_allowed_full_passthrough(self):
        result=parse_episode(page({'passthrough':'ALLOWED','passthroughUrl':'https://cdn.example.org/full.mp3'}),ID)
        self.assertEqual(result['url'],'https://cdn.example.org/full.mp3')
        self.assertEqual(result['pageUrl'],URL)
        for audio in [{},{'passthrough':'NONE','passthroughUrl':''},{'passthrough':'NONE','passthroughUrl':'https://cdn.example.org/full.mp3','url':['encrypted']}]:
            with self.assertRaisesRegex(ValueError,'public full audio'):
                parse_episode(page(audio),ID)

    def test_identity_and_unsafe_targets_fail_closed(self):
        with self.assertRaisesRegex(ValueError,'identity'):
            parse_episode(page({},'45m6z2GQIIvert8LxSXcjt'),ID)
        for url in ['http://127.0.0.1/full.mp3','https://user:secret@cdn.example.org/full.mp3','file:///full.mp3','https://cdn.example.org/full.mpd']:
            with self.assertRaises(ValueError):
                parse_episode(page({'passthrough':'ALLOWED','passthroughUrl':url}),ID)
        with self.assertRaises(ValueError):parse_episode(b'x'*2_000_001,ID)

    def test_native_resolves_episode_before_generic_extractor(self):
        source={'url':'https://cdn.example.org/full.mp3','pageUrl':URL,'type':'direct','title':'Podcast'}
        with patch('podcast_audio.resolve_episode',return_value=source):
            result=host.resolve_message({'url':URL,'kind':'audio'})
        self.assertEqual(result['source'],source)
        command=host.download_command({'node':'node','ffmpeg':'ffmpeg','directory':'fixture'}, {**result,'quality':'192'})
        self.assertIn('mp3',command);self.assertEqual(command[-1],source['url'])

    def test_audio_formats_use_media_path_and_no_video_choice(self):
        for ext in ['mp3','m4a','aac','ogg','opus','wav','flac']:
            source={'url':'https://cdn.example.org/full.'+ext,'pageUrl':'https://example.org/episode','type':'direct'}
            self.assertEqual(host.source_request({'source':source})[0],source['url'])
        self.assertTrue(host.summarize({'id':'audio','formats':[{'vcodec':'none','acodec':'mp3'}]})['audioOnly'])
        self.assertFalse(host.summarize({'id':'video','formats':[{'vcodec':'h264','acodec':'aac'}]})['audioOnly'])

if __name__=='__main__':unittest.main()
