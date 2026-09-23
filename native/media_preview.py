"""Session-scoped, read-only loopback media preview with byte-range playback."""
import re
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote, urlsplit

SAFE_MEDIA_TYPES={'video/mp4','audio/mp4','video/webm','audio/webm','video/ogg','audio/ogg','audio/mpeg',
                  'audio/wav','audio/flac','audio/aac','video/x-matroska','audio/x-matroska','video/quicktime',
                  'image/png','image/jpeg','image/gif','image/webp','image/avif','image/bmp','image/svg+xml','image/x-icon'}


def verified_mime(data,kind,header=b''):
    """Map FFprobe's detected demuxer/codec; never infer a media MIME from a name."""
    formats=set(data.get('format',{}).get('format_name','').split(','))
    brand=str(data.get('format',{}).get('tags',{}).get('major_brand','')).strip()
    if kind=='image':
        if brand in ('avif','avis'): return 'image/avif'
        codecs={s.get('codec_name') for s in data.get('streams',[]) if s.get('codec_type')=='video'}
        for codec,mime in [('png','image/png'),('mjpeg','image/jpeg'),('gif','image/gif'),('webp','image/webp'),('bmp','image/bmp'),('svg','image/svg+xml')]:
            if codec in codecs: return mime
        if 'ico' in formats: return 'image/x-icon'
        return 'application/octet-stream'
    prefix='audio' if kind=='audio' else 'video'
    if brand=='qt': return 'video/quicktime' if kind=='video' else 'audio/mp4'
    if 'mp4' in formats or 'm4a' in formats: return prefix+'/mp4'
    # FFprobe uses the same demuxer name for MKV and WebM. The EBML DocType
    # distinguishes them; a filename or the alias list cannot establish WebM.
    if 'webm' in formats and b'\x42\x82\x84webm' in header[:256]: return prefix+'/webm'
    if 'matroska' in formats: return prefix+'/x-matroska'
    if 'ogg' in formats: return prefix+'/ogg'
    if kind=='audio':
        for name,mime in [('mp3','audio/mpeg'),('wav','audio/wav'),('flac','audio/flac'),('aac','audio/aac')]:
            if name in formats: return mime
    return 'application/octet-stream'


def image_signature(path):
    """A bounded raster signature check for already verified extracted frame files."""
    with path.open('rb') as stream: header=stream.read(32)
    if header.startswith(b'\x89PNG\r\n\x1a\n'): return 'image/png'
    if header.startswith(b'\xff\xd8\xff'): return 'image/jpeg'
    if header[:6] in (b'GIF87a',b'GIF89a'): return 'image/gif'
    if header[:4]==b'RIFF' and header[8:12]==b'WEBP': return 'image/webp'
    if header.startswith(b'BM'): return 'image/bmp'
    if header[4:8]==b'ftyp' and header[8:12] in (b'avif',b'avis'): return 'image/avif'
    return 'application/octet-stream'

class PreviewServer:
    def __init__(self, library):
        token=secrets.token_urlsafe(32); self.library=library; self.allowed={}
        allowed=self.allowed
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_HEAD(self): self.serve(False)
            def do_GET(self): self.serve(True)
            def serve(self,body):
                try:
                    parts=urlsplit(self.path).path.split('/',2)
                    if len(parts)!=3 or not secrets.compare_digest(parts[1],token): self.send_error(404); return
                    relative=unquote(parts[2])
                    if relative not in allowed: self.send_error(404); return
                    path=library.path(relative); info=path.stat(); size=info.st_size; start,end=0,size-1
                    media_type,registered_size,registered_mtime=allowed[relative]
                    if (size,info.st_mtime_ns)!=(registered_size,registered_mtime): self.send_error(404); return
                    header=self.headers.get('Range'); partial=False
                    if header:
                        match=re.fullmatch(r'bytes=(\d*)-(\d*)',header)
                        if not match or not any(match.groups()): self.send_error(416); return
                        first,last=match.groups()
                        if first: start=int(first); end=min(int(last),size-1) if last else size-1
                        else: start=max(0,size-int(last))
                        if start>end or start>=size: self.send_error(416); return
                        partial=True
                    self.send_response(206 if partial else 200)
                    self.send_header('Content-Type',media_type)
                    self.send_header('X-Content-Type-Options','nosniff'); self.send_header('Cache-Control','no-store')
                    self.send_header('Content-Security-Policy',"sandbox; default-src 'none'; style-src 'unsafe-inline'")
                    if media_type=='application/octet-stream': self.send_header('Content-Disposition','attachment')
                    self.send_header('Accept-Ranges','bytes'); self.send_header('Content-Length',str(max(0,end-start+1)))
                    if partial: self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
                    self.end_headers()
                    if body:
                        with path.open('rb') as stream:
                            stream.seek(start); remaining=end-start+1
                            while remaining>0:
                                chunk=stream.read(min(256*1024,remaining))
                                if not chunk: break
                                self.wfile.write(chunk); remaining-=len(chunk)
                except (ValueError,OSError):
                    try: self.send_error(404)
                    except OSError: pass
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.base=f'http://127.0.0.1:{self.server.server_port}/{token}/'
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
    def url(self,filename,media_type=None):
        path=self.library.path(filename); info=path.stat()
        if media_type is None: media_type=image_signature(path)
        if media_type not in SAFE_MEDIA_TYPES: media_type='application/octet-stream'
        self.allowed[filename]=(media_type,info.st_size,info.st_mtime_ns)
        return self.base+quote(filename,safe='/')
    def close(self): self.server.shutdown(); self.server.server_close()
