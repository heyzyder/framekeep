"""Session-scoped, read-only loopback media preview with byte-range playback."""
import mimetypes
import re
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote, urlsplit

class PreviewServer:
    def __init__(self, library):
        token=secrets.token_urlsafe(32); self.library=library; self.allowed=set()
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
                    path=library.path(relative); size=path.stat().st_size; start,end=0,size-1
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
                    self.send_header('Content-Type',mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
                    self.send_header('X-Content-Type-Options','nosniff'); self.send_header('Cache-Control','no-store')
                    if path.suffix.lower()=='.svg': self.send_header('Content-Security-Policy',"sandbox; default-src 'none'; style-src 'unsafe-inline'")
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
    def url(self,filename):
        self.library.path(filename); self.allowed.add(filename)
        return self.base+quote(filename,safe='/')
    def close(self): self.server.shutdown(); self.server.server_close()
