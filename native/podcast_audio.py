"""Read a Spotify episode's explicitly allowed public full-file passthrough.

No account APIs, encrypted audio URLs, decryption, or preview substitution.
"""
from html.parser import HTMLParser
import json
import re
from urllib.parse import urlsplit
from media_capture import open_public, validate_url


def episode_id(value):
    try:
        url = validate_url(value)
    except (ValueError, TypeError):
        return None
    match = re.fullmatch(r'/(?:intl-[a-z-]+/)?(?:embed/)?episode/([A-Za-z0-9]{22})/?', url.path)
    return match[1] if url.hostname == 'open.spotify.com' and match else None


class EpisodeHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.collect = False
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == 'script':
            self.collect = dict(attrs).get('id') == '__NEXT_DATA__'

    def handle_endtag(self, tag):
        if tag == 'script':
            self.collect = False

    def handle_data(self, value):
        if self.collect:
            self.parts.append(value)


def parse_episode(raw, identifier):
    if len(raw) > 2_000_000:
        raise ValueError('The public podcast page is too large to inspect.')
    parser = EpisodeHTML()
    parser.feed(raw.decode('utf-8', 'replace'))
    try:
        data = json.loads(''.join(parser.parts))['props']['pageProps']['state']['data']
        entity = data['entity']
        if entity.get('id') != identifier or entity.get('type') != 'episode':
            raise ValueError('Episode identity mismatch.')
        audio = data.get('defaultAudioFileObject') or {}
        # Deliberately never read audio.url, audioPreview, or player credentials.
        if audio.get('passthrough') != 'ALLOWED' or not audio.get('passthroughUrl'):
            raise ValueError('Spotify does not expose a public full audio file for this episode. Open the publisher’s episode page in Framekeep if it offers a download. A short preview is not the full episode.')
        target = validate_url(audio['passthroughUrl'])
        if not re.search(r'\.(mp3|m4a|aac|ogg|opus|wav|flac)$', target.path, re.I):
            raise ValueError('This public podcast file format is not supported yet.')
        return {'url':target.geturl(), 'pageUrl':'https://open.spotify.com/episode/'+identifier,
                'type':'direct', 'title':str(entity.get('title') or entity.get('name') or 'Podcast episode')[:200]}
    except (KeyError, TypeError, json.JSONDecodeError):
        raise ValueError('Spotify did not return this public episode. Check its episode link and try again.') from None


def resolve_episode(value):
    identifier = episode_id(value)
    if not identifier:
        raise ValueError('Use a single Spotify podcast episode link.')
    response, connection, final_url = open_public('https://open.spotify.com/embed/episode/'+identifier)
    try:
        if final_url.hostname != 'open.spotify.com' or episode_id(final_url.geturl()) != identifier:
            raise ValueError('Spotify redirected to a different episode.')
        return parse_episode(response.read(2_000_001), identifier)
    finally:
        response.close()
        connection.close()
