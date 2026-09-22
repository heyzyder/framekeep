"""Short-lived, user-encrypted handoff between Chrome and the desktop app."""
import ctypes as C
from ctypes import wintypes as W
import hashlib
import json
from pathlib import Path
import re
import time
import uuid
from urllib.parse import urlsplit, urlunsplit

TTL = 15 * 60
class Blob(C.Structure):
    _fields_ = [('size', W.DWORD), ('data', C.POINTER(C.c_byte))]

def crypt(data, decrypt=False):
    raw = C.create_string_buffer(data)
    source, output = Blob(len(data), C.cast(raw, C.POINTER(C.c_byte))), Blob()
    api = C.windll.crypt32.CryptUnprotectData if decrypt else C.windll.crypt32.CryptProtectData
    if not api(C.byref(source), None, None, None, None, 1, C.byref(output)):
        raise OSError('Windows could not open the browser handoff.')
    try: return C.string_at(output.data, output.size)
    finally:
        C.windll.kernel32.LocalFree.argtypes = [C.c_void_p]
        C.windll.kernel32.LocalFree(output.data)

def key(page):
    url = urlsplit(page)
    return hashlib.sha256(urlunsplit(url._replace(fragment='')).encode()).hexdigest() + '.bin'

def cleanup(directory):
    entries = sorted((p for p in directory.glob('*.bin') if re.fullmatch(r'[a-f0-9]{64}\.bin',p.name) and p.is_file() and not p.is_symlink()), key=lambda p:p.stat().st_mtime, reverse=True)
    for i,p in enumerate(entries):
        if i >= 20 or time.time()-p.stat().st_mtime > TTL: p.unlink(missing_ok=True)

def remember(directory, source):
    directory = Path(directory)
    directory.mkdir(exist_ok=True)
    if directory.is_symlink(): return
    payload = crypt(json.dumps({'expires':time.time()+TTL,'source':source},ensure_ascii=False).encode('utf-8'))
    if len(payload)>20000: return
    temporary = directory / (str(uuid.uuid4())+'.tmp')
    try:
        temporary.write_bytes(payload)
        temporary.replace(directory/key(source['pageUrl']))
        cleanup(directory)
    finally: temporary.unlink(missing_ok=True)

def lookup(directory, page):
    directory=Path(directory)
    if not directory.is_dir() or directory.is_symlink(): return None
    try:
        cleanup(directory)
        file=directory/key(page)
        if file.is_symlink() or not file.is_file() or file.stat().st_size>20000: return None
        data=json.loads(crypt(file.read_bytes(),decrypt=True))
        if not time.time() < data['expires'] <= time.time()+TTL: return None
        if key(data['source']['pageUrl']) != key(page): return None
        return data['source']
    except (OSError,ValueError,KeyError): return None
