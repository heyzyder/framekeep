"""Recycle one validated file using the Windows Shell, without a delete fallback."""
import ctypes
import os
from pathlib import Path
import re
import stat
import uuid
import hashlib
from contextlib import contextmanager


@contextmanager
def operation_lock(directory):
    """Briefly serialize publishing/recycling, including other app/Chrome processes."""
    if os.name != 'nt':
        yield; return
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    name = 'Local\\Framekeep-' + hashlib.sha256(str(Path(directory).resolve()).casefold().encode()).hexdigest()[:24]
    handle = kernel.CreateMutexW(None, False, name)
    if not handle: raise OSError('Could not coordinate access to the save folder.')
    acquired = False
    try:
        result = kernel.WaitForSingleObject(handle, 10000)
        if result not in (0, 0x80): raise ValueError('The save folder is busy finishing another file. Try again shortly.')
        acquired = True
        yield
    finally:
        if acquired: kernel.ReleaseMutex(handle)
        kernel.CloseHandle(handle)


def publish_download(path, directory):
    """Move a verified job output into the library without overwriting an existing file."""
    path, root = Path(path), Path(directory).resolve()
    if path.is_symlink() or path.resolve().parent.parent != root or not path.parent.name.startswith('.framekeep-'):
        raise ValueError('Invalid temporary download file.')
    with operation_lock(root):
        for index in range(10000):
            target = root / (path.name if index == 0 else f'{path.stem} ({index + 1}){path.suffix}')
            if target.exists(): continue
            try:
                # Windows rename fails if a file appeared at the target; never replace it.
                path.rename(target)
                return target
            except FileExistsError: continue
    raise ValueError('Too many files share this name. Rename a saved copy before retrying.')


def download_path(directory, filename):
    if (not isinstance(filename, str) or not filename or len(filename) > 255
            or re.search(r'[<>:"/\\|?*\x00-\x1f]', filename) or filename.endswith((' ', '.'))
            or re.match(r'(?i)^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', filename)
            or Path(filename).suffix.lower() not in ('.mp4', '.mp3', '.webm', '.m4a')):
        raise ValueError('This download has an invalid filename.')
    root = Path(directory).resolve(strict=True)
    path = root / filename
    if not path.exists():
        return None
    attributes = path.lstat()
    if (not stat.S_ISREG(attributes.st_mode) or path.is_symlink()
            or getattr(attributes, 'st_file_attributes', 0) & 0x400
            or path.resolve().parent != root):
        raise ValueError('Only regular downloaded files in the save folder can be recycled.')
    return path


def recycle_file(path):
    if os.name != 'nt':
        raise OSError('Recycle Bin is available only on Windows.')
    from ctypes import wintypes
    ole = ctypes.OleDLL('ole32')
    shell = ctypes.OleDLL('shell32')
    pointer = ctypes.c_void_p
    guid = lambda value: (ctypes.c_ubyte * 16).from_buffer_copy(uuid.UUID(value).bytes_le)
    operation, item = pointer(), pointer()
    initialized = False

    def call(obj, index, types, *args):
        vtable = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(pointer))).contents
        function = ctypes.WINFUNCTYPE(ctypes.HRESULT, pointer, *types)(vtable[index])
        result = function(obj, *args)
        if result < 0:
            raise OSError(f'Windows could not recycle this file (0x{result & 0xffffffff:08X}).')

    try:
        ole.CoInitializeEx(None, 2)
        initialized = True
        ole.CoCreateInstance(ctypes.byref(guid('3ad05575-8857-4850-9277-11b85bdb8e09')), None, 1,
                             ctypes.byref(guid('947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8')), ctypes.byref(operation))
        # RECYCLEONDELETE + ADDUNDORECORD + EARLYFAILURE + silent/no-error UI.
        # No permanent-deletion API is used if the shell cannot recycle the file.
        call(operation, 5, [wintypes.DWORD], 0x00080000 | 0x20000000 | 0x00100000 | 0x0004 | 0x0010 | 0x0400)
        shell.SHCreateItemFromParsingName(ctypes.c_wchar_p(str(path)), None,
                                         ctypes.byref(guid('43826d1e-e718-42ee-bc55-a1e261c37bfe')), ctypes.byref(item))
        call(operation, 18, [pointer, pointer], item, None)
        call(operation, 21, [])
        aborted = wintypes.BOOL()
        call(operation, 22, [ctypes.POINTER(wintypes.BOOL)], ctypes.byref(aborted))
        if aborted.value or Path(path).exists():
            raise OSError('Windows could not move this file to the Recycle Bin. Your file was kept.')
    finally:
        for obj in [item, operation]:
            if obj:
                vtable = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(pointer))).contents
                ctypes.WINFUNCTYPE(wintypes.ULONG, pointer)(vtable[2])(obj)
        if initialized:
            ole.CoUninitialize()
