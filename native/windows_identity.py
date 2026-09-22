"""One durable identity for the executable, running window and pinned shortcut."""
import ctypes as C
from ctypes import wintypes as W
from pathlib import Path
import subprocess
import sys

APP_ID = 'Framekeep.Desktop'

class GUID(C.Structure):
    _fields_ = [('a', W.DWORD), ('b', W.WORD), ('c', W.WORD), ('d', C.c_ubyte * 8)]

class KEY(C.Structure):
    _fields_ = [('fmtid', GUID), ('pid', W.DWORD)]

class VALUE(C.Structure):
    _fields_ = [('vt', W.WORD), ('r1', W.WORD), ('r2', W.WORD), ('r3', W.WORD), ('pointer', C.c_void_p), ('padding', C.c_void_p)]

def guid(value):
    result = GUID(); C.oledll.ole32.CLSIDFromString(value, C.byref(result)); return result

def set_window_identity(hwnd, directory):
    shell = C.windll.shell32
    get_store = shell.SHGetPropertyStoreForWindow
    get_store.argtypes = [W.HWND, C.POINTER(GUID), C.POINTER(C.c_void_p)]
    get_store.restype = C.c_long
    store = C.c_void_p()
    iid = guid('{886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99}')
    result = get_store(hwnd, C.byref(iid), C.byref(store))
    if result < 0: raise OSError('Windows could not set the taskbar identity.')
    table = C.cast(store, C.POINTER(C.POINTER(C.c_void_p))).contents
    setter = C.WINFUNCTYPE(C.c_long, C.c_void_p, C.POINTER(KEY), C.POINTER(VALUE))(table[6])
    getter = C.WINFUNCTYPE(C.c_long, C.c_void_p, C.POINTER(KEY), C.POINTER(VALUE))(table[5])
    release = C.WINFUNCTYPE(W.ULONG, C.c_void_p)(table[2])
    directory = Path(directory)
    expected = {2: subprocess.list2cmdline([str(directory / 'Framekeep.exe')]),
                3: str(directory / 'Framekeep.exe') + ',0', 4: 'Framekeep', 5: APP_ID}
    verified = {}
    try:
        for pid, text in expected.items():
            key = KEY(guid('{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}'), pid)
            buffer = C.create_unicode_buffer(text)
            value = VALUE(31, 0, 0, 0, C.cast(buffer, C.c_void_p), None)
            if setter(store, C.byref(key), C.byref(value)) < 0: raise OSError('Windows rejected the taskbar properties.')
        for pid, text in expected.items():
            key = KEY(guid('{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}'), pid); value = VALUE()
            getter(store, C.byref(key), C.byref(value))
            verified[pid] = value.vt == 31 and C.wstring_at(value.pointer) == text
            C.oledll.ole32.PropVariantClear(C.byref(value))
        return verified
    finally: release(store)
