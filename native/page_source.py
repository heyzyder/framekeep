"""Resolve public lesson pages using the same exposed player sources as Chrome."""
from html.parser import HTMLParser
import re
from urllib.parse import urljoin
from urllib.request import Request, build_opener, HTTPRedirectHandler

class PlayerHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.media, self.embeds, self.title, self.in_title = [], [], '', False
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'title': self.in_title = True
        if tag in ('presto-player', 'video', 'audio', 'source') and attrs.get('src'): self.media.append(attrs['src'])
        if tag == 'iframe' and attrs.get('src'): self.embeds.append(attrs['src'])
    def handle_endtag(self, tag):
        if tag == 'title': self.in_title = False
    def handle_data(self, text):
        if self.in_title: self.title += text

def resolve_page(value, validate, validate_source):
    value = validate(value).geturl()
    class PublicRedirect(HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            validate(newurl)
            return super().redirect_request(req, fp, code, msg, headers, newurl)
    request = Request(value, headers={'User-Agent': 'Mozilla/5.0 Framekeep/1.5', 'Accept': 'text/html'})
    with build_opener(PublicRedirect()).open(request, timeout=20) as response:
        validate(response.url)
        raw = response.read(2_000_001)
        if len(raw) > 2_000_000: raise ValueError('This page is too large to inspect. Open it in Chrome and use Framekeep on the video player.')
        parser = PlayerHTML(); parser.feed(raw.decode(response.headers.get_content_charset() or 'utf-8', 'replace'))
        candidates = []
        for kind, values in [('direct', parser.media), ('embed', parser.embeds)]:
            for media in values:
                source = {'url': urljoin(response.url, media), 'pageUrl':value, 'type':kind, 'title':re.sub(r'\s+', ' ', parser.title).strip()[:200] or 'Page video'}
                try: validate_source({'source':source})
                except ValueError: continue
                if not any(s['url']==source['url'] for s in candidates): candidates.append(source)
            if candidates: break
    if len(candidates) == 1: return candidates[0]
    if candidates: raise ValueError('This page contains several videos. Open it in Chrome and choose the video in Framekeep.')
    raise ValueError('This page needs its browser player or a signed-in session. Open the lesson in Chrome, then open Framekeep to detect its video. You can send it to the app with Open in desktop.')
