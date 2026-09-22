"""Framekeep desktop entry point: shared UI in the installed Windows WebView2 runtime."""
from pathlib import Path
import ctypes
import json
import os
import re
import sys


def main():
    directory = Path(__file__).resolve().parent
    # pythonw provides no console streams. Some dependency diagnostics still write to them.
    for name in ('stdout', 'stderr'):
        if getattr(sys, name) is None: setattr(sys, name, open(os.devnull, 'w', encoding='utf-8'))
    try:
        from windows_identity import APP_ID, set_window_identity
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)
        import webview
        from desktop_bridge import DesktopBridge
        import host
        config = json.loads((directory / 'config.json').read_text('utf-8-sig'))
        bridge = DesktopBridge(config, directory)
        window = webview.create_window('Framekeep', url=str(directory / 'ui' / 'desktop.html'), js_api=bridge,
                                       width=1180, height=760, min_size=(880, 540), background_color='#F4F5F8', text_select=True)
        bridge._window = window
        def identity():
            hwnd = window.native.Handle.ToInt64()
            from System.Drawing import Icon
            window.native.Icon = Icon.ExtractAssociatedIcon(str(directory / 'Framekeep.exe'))
            from System.Drawing import Size, Point
            from System.Windows.Forms import Screen, FormStartPosition
            area = Screen.FromControl(window.native).WorkingArea
            scale = ctypes.windll.user32.GetDpiForWindow(hwnd) / 96 or 1
            width, height = min(int(1180 * scale), area.Width - 40), min(int(760 * scale), area.Height - 40)
            window.native.MinimumSize = Size(min(int(880 * scale), width), min(int(510 * scale), height))
            window.native.Size = Size(width, height)
            window.native.StartPosition = FormStartPosition.Manual
            window.native.Location = Point(area.X + (area.Width-width)//2, area.Y + (area.Height-height)//2)
            verified = set_window_identity(hwnd, directory)
            (directory / 'desktop-health.json').write_text(json.dumps({'version': host.VERSION, 'renderer': 'WebView2', 'location':str(directory), 'pid':os.getpid(), 'taskbarProperties': verified}), encoding='utf-8')
        def closing():
            if bridge._owns_work():
                result = ctypes.windll.user32.MessageBoxW(None, 'This window still has downloads or file operations running. Stop them and close Framekeep?\n\nChoose No to keep Framekeep running.', 'Close Framekeep?', 0x24)
                if result != 6: return False
            bridge.close()
        window.events.before_show += identity
        window.events.closing += closing
        if len(sys.argv) == 3 and sys.argv[1] == '--handoff' and re.fullmatch(r'handoff-[\da-f-]{36}\.json', sys.argv[2]):
            handoff = directory / sys.argv[2]
            if handoff.is_file() and not handoff.is_symlink() and handoff.stat().st_size < 20000:
                try: received = json.loads(handoff.read_text('utf-8'))
                finally: handoff.unlink(missing_ok=True)
                window.events.loaded += lambda: bridge.dispatch({'action': 'analyze', **received})
        webview.settings['ALLOW_DOWNLOADS'] = False
        webview.start(gui='edgechromium', icon=str(directory / 'framekeep-app.ico'), private_mode=True)
    except Exception as error:
        ctypes.windll.user32.MessageBoxW(None, str(error)[:600] + '\n\nRun Install Framekeep.cmd to repair the app.', 'Framekeep could not start', 0x10)


if __name__ == '__main__': main()
