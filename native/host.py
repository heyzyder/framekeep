"""Framekeep native messaging host. Standard library only; yt-dlp runs separately."""
from __future__ import annotations

import collections
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import threading
import tempfile
import html
import ipaddress
import hashlib
import uuid
import base64
from urllib.parse import parse_qs, parse_qsl, urlencode, urlsplit, urlunsplit

ORIGIN = 'chrome-extension://mddibmfbdbahbimeclofpakiekckanio/'
VERSION = '1.8.0'
MAX_MESSAGE = 65536
CREATE_NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
PLATFORMS = json.loads(Path(__file__).with_name('platforms.json').read_text(encoding='utf-8'))


def platform_for(hostname):
    return next((platform for platform in PLATFORMS if any(hostname == domain or hostname.endswith('.' + domain) for domain in platform['domains'])), None)


def normalize_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError('Paste a video link from a supported platform.')
    url = urlsplit(value.strip())
    if url.scheme not in ('http', 'https') or url.username or url.password or url.port not in (None, 443 if url.scheme == 'https' else 80):
        raise ValueError('Use a standard public video link.')
    platform = platform_for(url.hostname or '')
    if not platform:
        raise ValueError('This site is not supported yet. See the supported platforms in the extension.')
    if platform['name'] != 'YouTube':
        if url.path in ('', '/') and not url.query:
            raise ValueError('Paste a specific video or post link, rather than a homepage.')
        query = [(k, v) for k, v in parse_qsl(url.query, keep_blank_values=True)
                 if not k.startswith('utm_') and k not in ('fbclid', 'igsh', 'igshid')]
        return urlunsplit(('https', url.hostname, url.path, urlencode(query), ''))
    parts = [part for part in url.path.split('/') if part]
    video_id = None
    if url.hostname == 'youtu.be' and len(parts) == 1:
        video_id = parts[0]
    elif url.hostname == 'youtube.com' or url.hostname.endswith('.youtube.com') or url.hostname == 'youtube-nocookie.com' or url.hostname.endswith('.youtube-nocookie.com'):
        if url.path == '/watch':
            video_id = parse_qs(url.query).get('v', [''])[0]
        elif len(parts) == 2 and parts[0] in ('shorts', 'live', 'embed'):
            video_id = parts[1]
    if not re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id or ''):
        raise ValueError('Use a single YouTube video or Short.')
    return 'https://www.youtube.com/watch?v=' + video_id


def read_exact(stream, count):
    data = bytearray()
    while len(data) < count:
        chunk = stream.read(count - len(data))
        if not chunk:
            if not data:
                return None
            raise ValueError('Truncated native message.')
        data.extend(chunk)
    return bytes(data)


def read_message(stream):
    header = read_exact(stream, 4)
    if header is None:
        return None
    size = struct.unpack('<I', header)[0]
    if size < 2 or size > MAX_MESSAGE:
        raise ValueError('Invalid native message size.')
    payload = read_exact(stream, size)
    if payload is None:
        raise ValueError('Truncated native message.')
    message = json.loads(payload)
    if not isinstance(message, dict):
        raise ValueError('Expected a message object.')
    return message


def base_command(config):
    return [sys.executable, '-u', '-m', 'yt_dlp', '--ignore-config', '--no-plugin-dirs',
            '--use-extractors', 'default,-generic', '--match-filter', '!is_live',
            '--no-playlist', '--playlist-items', '1', '--no-cache-dir', '--no-colors', '--encoding', 'utf-8',
            '--socket-timeout', '25', '--retries', '2', '--fragment-retries', '2',
            '--js-runtimes', 'node:' + config['node'], '--ffmpeg-location', config['ffmpeg']]


def public_url(value):
    if not isinstance(value, str) or len(value) > 8192 or re.search(r'[\x00-\x20]', value):
        raise ValueError('Invalid page video address.')
    url = urlsplit(value)
    hostname = url.hostname or ''
    if url.scheme not in ('http', 'https') or url.username or url.password or url.port not in (None, 443 if url.scheme == 'https' else 80):
        raise ValueError('Use a standard web video address.')
    if '.' not in hostname or hostname == 'localhost' or hostname.endswith(('.local', '.localhost')):
        raise ValueError('Use a video on a public website.')
    try: address = ipaddress.ip_address(hostname)
    except ValueError: address = None
    if address and not address.is_global: raise ValueError('Use a video on a public website.')
    return url._replace(fragment='')


def resolve_message(message):
    from podcast_audio import episode_id, resolve_episode
    candidate = (message.get('source') or {}).get('url') or message.get('url')
    if episode_id(candidate):
        source = resolve_episode(candidate)
        return {**message, 'url':source['url'], 'source':source}
    if message.get('source'): return message
    value = message.get('url')
    url = public_url(value)
    if platform_for(url.hostname): return {**message, 'url':normalize_url(value)}
    from browser_sources import lookup
    cached = lookup(Path(__file__).with_name('browser-sources'), value)
    if cached:
        source_request({'source':cached})
        return {**message, 'source':cached}
    if re.search(r'\.(mp4|m4v|webm|mov|m3u8|mpd|mp3|m4a|aac|ogg|opus|wav|flac)$', url.path, re.I):
        return {**message, 'source':{'url':url.geturl(), 'pageUrl':url.geturl(), 'type':'direct', 'title':'Video'}}
    from page_source import resolve_page
    source = resolve_page(value, public_url, source_request)
    return {**message, 'url':source['url'], 'source':source}


def source_request(message):
    source = message.get('source')
    if not source:
        return normalize_url(message.get('url')), []
    if not isinstance(source, dict):
        raise ValueError('Invalid page video.')
    urls = []
    for value in [source.get('url'), source.get('pageUrl')]:
        if not isinstance(value, str) or len(value) > 8192 or re.search(r'[\x00-\x20]', value):
            raise ValueError('Invalid page video address.')
        url = urlsplit(value)
        hostname = url.hostname or ''
        if url.scheme not in ('http', 'https') or url.username or url.password or url.port not in (None, 443 if url.scheme == 'https' else 80):
            raise ValueError('Use a standard web video address.')
        if '.' not in hostname or hostname == 'localhost' or hostname.endswith(('.local', '.localhost')):
            raise ValueError('Use a video on a public website.')
        try:
            address = ipaddress.ip_address(hostname)
        except ValueError:
            address = None
        if address and not address.is_global:
            raise ValueError('Use a video on a public website.')
        urls.append(url)
    media, page = urls
    embed_hosts = ('youtube.com', 'youtube-nocookie.com', 'vimeo.com', 'wistia.com', 'wistia.net', 'mediadelivery.net', 'bunny.net', 'sproutvideo.com', 'vidyard.com')
    direct = source.get('type') == 'direct' and re.search(r'\.(mp4|m4v|webm|mov|m3u8|mpd|mp3|m4a|aac|ogg|opus|wav|flac)$', media.path, re.I)
    embed = source.get('type') == 'embed' and any(media.hostname == h or media.hostname.endswith('.' + h) for h in embed_hosts)
    if not (direct or embed):
        raise ValueError('This player does not expose a supported video link.')
    return urlunsplit(media._replace(fragment='')), ['--use-extractors', 'default', '--referer', urlunsplit(page._replace(fragment=''))]


def source_command(config, message):
    url, options = source_request(message)
    return url, base_command(config) + options


def video_preview(config, message):
    """One small real frame, in memory. No media files or signed URLs are persisted."""
    url, _ = source_request(message)
    if (message.get('source') or {}).get('type') != 'direct':
        raise ValueError('A detected video source is required for a preview.')
    command = [config['ffmpeg'], '-hide_banner', '-loglevel', 'error', '-nostdin',
               '-rw_timeout', '12000000', '-protocol_whitelist', 'http,https,tcp,tls,crypto',
               '-referer', message['source']['pageUrl'], '-i', url, '-ss', '1',
               '-frames:v', '1', '-an', '-vf', 'scale=480:270:force_original_aspect_ratio=decrease',
               '-c:v', 'mjpeg', '-q:v', '5', '-f', 'image2pipe', 'pipe:1']
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=20, creationflags=CREATE_NO_WINDOW)
    except subprocess.TimeoutExpired:
        return {'thumbnail': ''}
    frame = result.stdout
    if result.returncode or not frame.startswith(b'\xff\xd8') or len(frame) > 130000:
        return {'thumbnail': ''}
    return {'thumbnail': 'data:image/jpeg;base64,' + base64.b64encode(frame).decode('ascii')}


def download_command(config, message):
    url, command = source_command(config, message)
    kind, quality = message.get('kind'), str(message.get('quality'))
    if kind == 'video':
        if quality != 'best' and (not quality.isdecimal() or not 144 <= int(quality) <= 8640):
            raise ValueError('Invalid video quality.')
        cap = '' if quality == 'best' else f'[height<={int(quality)}]'
        selection = f'bv[ext=mp4]{cap}+ba[ext=m4a]/b[ext=mp4]{cap}'
        if message.get('source'):
            selection += f'/bv{cap}+ba/b{cap}'
        command += ['-f', selection, '--merge-output-format', 'mp4']
        if message.get('source'):
            command += ['--recode-video', 'mp4']
    elif kind == 'audio' and quality in ('128', '192', '320'):
        command += ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', quality + 'K']
    else:
        raise ValueError('Invalid format or audio quality.')
    template = f'%(title).140B [%(id).80B] [{kind}-{quality}].%(ext)s'
    if (message.get('source') or {}).get('type') == 'direct':
        title = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', str(message['source'].get('title') or 'Page video'))[:120].strip(' .') or 'Page video'
        # A page label makes course files recognizable; URLs/tokens never become filenames.
        identifier = hashlib.sha256(urlsplit(url).path.encode()).hexdigest()[:12]
        template = f'{title.replace("%", "%%")} [page-{identifier}] [{kind}-{quality}].%(ext)s'
    # Fixed output directory and arguments; no executable, flags or credentials from Chrome.
    command += ['--windows-filenames', '--no-overwrites', '--newline', '--progress',
                '--progress-delta', '0.4', '--no-simulate',
                '-P', str(config['directory']), '-o', template,
                '--progress-template', 'download:FK_PROGRESS:{"downloaded":%(progress.downloaded_bytes|0)j,"total":%(progress.total_bytes,progress.total_bytes_estimate|0)j,"speed":%(progress.speed|null)j,"eta":%(progress.eta|null)j,"vcodec":%(info.vcodec|null)j,"acodec":%(info.acodec|null)j,"fragment":%(progress.fragment_index|null)j,"fragments":%(progress.fragment_count|null)j}',
                '--progress-template', 'postprocess:FK_PROCESSING',
                '--print', 'after_move:FK_FILE:%(filepath)j', '--', url]
    return command


def summarize(info):
    if info.get('is_live') or info.get('live_status') in ('is_upcoming', 'is_live'):
        raise ValueError('Live broadcasts are not supported. Try again after the stream finishes.')
    if info.get('_type') in ('playlist', 'multi_video') or not info.get('id') or not info.get('formats'):
        raise ValueError('Use a single video link. Albums, profiles and playlists are not supported.')
    heights = sorted({int(f['height']) for f in info.get('formats', [])
                      if f.get('ext') == 'mp4' and f.get('vcodec') not in (None, 'none')
                      and isinstance(f.get('height'), (int, float)) and 144 <= f['height'] <= 8640}, reverse=True)
    thumbnail = info.get('thumbnail') or ''
    if thumbnail.startswith('//'):
        thumbnail = 'https:' + thumbnail
    elif thumbnail.startswith('http://'):
        thumbnail = 'https://' + thumbnail[7:]
    thumb_url = urlsplit(thumbnail)
    if thumb_url.scheme != 'https' or thumb_url.username or thumb_url.password:
        thumbnail = ''
    webpage = urlsplit(info.get('webpage_url') or '')
    platform = platform_for(webpage.hostname or '')
    tracks = {}
    for automatic, collection in [(True, info.get('automatic_captions') or {}), (False, info.get('subtitles') or {})]:
        for language, formats in collection.items():
            if language == 'live_chat' or not re.fullmatch(r'[A-Za-z0-9_-]{1,35}', language):
                continue
            if any(f.get('ext') in ('json3', 'vtt', 'srt') for f in formats):
                tracks[language] = {'language': language, 'name': str(next((f.get('name') for f in formats if f.get('name')), language))[:100], 'automatic': automatic}
    return {'id': str(info['id'])[:200], 'title': str(info.get('title') or 'Untitled video')[:500],
            'channel': str(info.get('uploader') or info.get('channel') or '')[:200],
            'platform': platform['name'] if platform else str(info.get('extractor_key') or 'Video'),
            'thumbnail': thumbnail[:4096], 'duration': info.get('duration'), 'heights': heights,
            'audioOnly': all(f.get('vcodec') == 'none' for f in info['formats']),
            'tracks': sorted(tracks.values(), key=lambda t: (not t['language'].startswith('en'), t['automatic'], not t['language'].endswith('-orig'), t['language']))[:200]}


def parse_captions(content, extension):
    cues = []
    if extension == '.json3':
        data = json.loads(content)
        for event in data.get('events', []):
            text = ''.join(segment.get('utf8', '') for segment in event.get('segs', []))
            if text.strip():
                cues.append({'start': max(0, float(event.get('tStartMs', 0)) / 1000),
                             'duration': max(0, float(event.get('dDurationMs', 0)) / 1000), 'text': text})
    else:
        def seconds(value):
            parts = [float(p) for p in value.replace(',', '.').split(':')]
            return sum(number * 60 ** i for i, number in enumerate(reversed(parts)))
        timing = re.compile(r'((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}[.,]\d{3})')
        lines = content.replace('\r', '').split('\n')
        for index, line in enumerate(lines):
            match = timing.search(line)
            if not match:
                continue
            text_lines = []
            for cursor in range(index + 1, len(lines)):
                text_line = lines[cursor]
                if not text_line.strip() or timing.search(text_line):
                    break
                text_lines.append(text_line)
            start, end = seconds(match[1]), seconds(match[2])
            cues.append({'start': start, 'duration': max(0, end - start), 'text': '\n'.join(text_lines)})
    cleaned, size, truncated = [], 0, False
    for cue in cues:
        cue['text'] = ' '.join(html.unescape(re.sub(r'<[^>]*>', '', cue['text'])).split())
        if not cue['text'] or not math.isfinite(cue['start']) or not math.isfinite(cue['duration']):
            continue
        if cleaned and cue['text'] == cleaned[-1]['text'] and cue['start'] <= cleaned[-1]['start'] + cleaned[-1]['duration'] + .05:
            cleaned[-1]['duration'] = max(cleaned[-1]['duration'], cue['start'] + cue['duration'] - cleaned[-1]['start'])
            continue
        encoded_size = len(json.dumps(cue, ensure_ascii=False).encode('utf-8'))
        if size + encoded_size > 700000 or len(cleaned) >= 5000:
            truncated = True
            break
        size += encoded_size
        cleaned.append(cue)
    return {'cues': cleaned, 'truncated': truncated}


def clean_error(lines):
    errors = [line for line in lines if 'ERROR:' in line]
    text = errors[-1] if errors else 'The download helper could not finish. Check your connection and retry.'
    # Do not expose signed media links or local traceback contents in the UI.
    text = re.sub(r'https?://\S+', '[link]', text)
    text = re.sub(r'\x1b\[[0-9;]*m', '', text)
    if any(word in text.lower() for word in ('sign in', 'log in', 'login', 'cookies', 'bot')):
        return 'This platform requires sign-in or a verification check for this video. Framekeep supports public videos without browser cookies.'
    if 'Requested format is not available' in text:
        return 'That MP4 quality is unavailable. Check the video again or choose audio.'
    return text.removeprefix('ERROR:').strip()[:650]


class Host:
    def __init__(self, config, output=None):
        self.config = config
        self.output = output or sys.stdout.buffer
        self.write_lock = threading.Lock()
        self.job_lock = threading.Lock()
        self.preview_lock = threading.Lock()
        self.jobs = {}
        from library_state import Library
        self.library = Library(config['directory'])
        self._closed = threading.Event()
        self._recorded = set()

    def publish(self, message):
        # Keep durable receipts even when an in-process adapter supplies its own emit.
        if message.get('id') in self._recorded:
            self.library.event(message)
            if message.get('event') in ('complete','error','cancelled'): self._recorded.discard(message['id'])
        self.emit(message)

    def watch_cancel(self, request_id, task):
        def watch():
            while not self._closed.wait(0.25):
                with self.job_lock:
                    if self.jobs.get(request_id) is not task: return
                if self.library.cancelled(request_id):
                    task['cancelled'].set(); self.kill(task); return
        threading.Thread(target=watch,daemon=True).start()

    def emit(self, message):
        payload = json.dumps(message, ensure_ascii=False, allow_nan=False).encode('utf-8')
        if len(payload) > 1024 * 1024:
            raise ValueError('Native response too large.')
        with self.write_lock:
            self.output.write(struct.pack('<I', len(payload)) + payload)
            self.output.flush()

    def kill(self, task):
        with task['lock']:
            process = task.get('process')
            if process and process.poll() is None:
                if os.name == 'nt':
                    subprocess.run(['taskkill.exe', '/PID', str(process.pid), '/T', '/F'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW)
                else:
                    process.kill()

    def handle(self, message):
        request_id = message.get('id')
        if not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', request_id):
            raise ValueError('Invalid request ID.')
        action = message.get('action')
        try:
            if action in ('library', 'job'):
                if action == 'library':
                    items,jobs=self.library.scan(); data={'library':items,'jobs':jobs}
                else:
                    data=self.library.get_job(message.get('target'))
                    if not data: raise ValueError('Unknown job ID.')
                self.publish({'id':request_id,'event':'result','data':data})
            elif action == 'status':
                for field in ('node', 'ffmpeg'):
                    if not Path(self.config[field]).is_file():
                        raise ValueError('A required tool moved. Run Install Framekeep.cmd again.')
                version = importlib.metadata.version('yt-dlp')
                importlib.metadata.version('yt-dlp-ejs')
                self.publish({'id': request_id, 'event': 'result', 'data': {
                    'version': VERSION, 'protocol': 2, 'location': str(Path(__file__).resolve().parent), 'extractor': version, 'directory': str(self.config['directory']), 'capabilities': ['trash', 'preview', 'desktop', 'page-sources', 'parallel-downloads', 'shared-library', 'shared-jobs']}})
            elif action == 'capture':
                from media_capture import run_capture
                existing=self.library.begin(message)
                if existing:
                    self.emit({'id':request_id,**existing['terminal'],'reused':True}); return
                self._recorded.add(request_id)
                task = {'cancelled': threading.Event(), 'lock': threading.Lock(), 'action': 'capture'}
                with self.job_lock:
                    if request_id in self.jobs:
                        raise ValueError('Duplicate capture request.')
                    self.jobs[request_id] = task
                self.watch_cancel(request_id,task)
                def capture():
                    try:
                        run_capture(self.config, message, task, lambda result: self.publish({'id': request_id, **result}))
                    except Exception as error:
                        self.publish({'id': request_id, 'event': 'cancelled' if task['cancelled'].is_set() else 'error', 'error': str(error)[:650]})
                    finally:
                        with self.job_lock: self.jobs.pop(request_id, None)
                thread = threading.Thread(target=capture, daemon=True)
                task['thread'] = thread
                thread.start()
            elif action == 'preview':
                source_request(message)
                def preview():
                    with self.preview_lock:
                        try: self.publish({'id': request_id, 'event': 'result', 'data': video_preview(self.config, message)})
                        except (ValueError, OSError): self.publish({'id': request_id, 'event': 'result', 'data': {'thumbnail': ''}})
                threading.Thread(target=preview, daemon=True).start()
            elif action == 'folder':
                directory = Path(self.config['directory'])
                directory.mkdir(parents=True, exist_ok=True)
                os.startfile(str(directory))
                self.publish({'id': request_id, 'event': 'result'})
            elif action == 'desktop':
                application = Path(__file__).with_name('Framekeep.exe')
                if not application.is_file():
                    raise ValueError('Run Install Framekeep.cmd to install the desktop app.')
                arguments = [str(application)]
                handoff = None
                if message.get('url') or message.get('source'):
                    url, _ = source_request(message)
                    handoff = application.with_name('handoff-' + str(uuid.uuid4()) + '.json')
                    handoff.write_text(json.dumps({'url':url, 'source':message.get('source')}), encoding='utf-8')
                    arguments += ['--handoff', handoff.name]
                try:
                    subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW, cwd=str(application.parent))
                except OSError:
                    if handoff: handoff.unlink(missing_ok=True)
                    raise
                self.publish({'id': request_id, 'event': 'result'})
            elif action == 'files':
                from recycle import download_path
                filenames = message.get('filenames')
                if not isinstance(filenames, list) or len(filenames) > 12:
                    raise ValueError('Invalid download list.')
                states = {}
                for filename in filenames:
                    try: states[filename] = bool(download_path(self.config['directory'], filename))
                    except (ValueError, OSError): states[filename] = False
                self.publish({'id':request_id, 'event':'result', 'data':states})
            elif action == 'cancel':
                with self.job_lock:
                    task = self.jobs.get(message.get('target'))
                if task:
                    task['cancelled'].set()
                    self.kill(task)
                else:
                    self.library.cancel(message.get('target'))
                self.publish({'id': request_id, 'event': 'result'})
            elif action == 'trash':
                from recycle import download_path, recycle_file, operation_lock
                with self.job_lock:
                    if any(task.get('action') == 'download' for task in self.jobs.values()):
                        raise ValueError('Wait for the current download to finish before deleting a file.')
                with operation_lock(self.config['directory']):
                    path = download_path(self.config['directory'], message.get('filename'))
                    if path:
                        recycle_file(path)
                self.publish({'id': request_id, 'event': 'result', 'data': {'fileState': 'trashed' if path else 'missing'}})
            elif action in ('probe', 'download', 'transcript'):
                if action == 'download':
                    existing=self.library.begin(message)
                    if existing:
                        self.emit({'id':request_id,**existing['terminal'],'reused':True}); return
                    self._recorded.add(request_id)
                message = resolve_message(message)
                url, command = source_command(self.config, message)
                if action == 'transcript':
                    language = message.get('language', '')
                    if not isinstance(language, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,35}', language):
                        raise ValueError('Choose an available caption language.')
                    command += ['--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', '^' + re.escape(language) + '$', '--sub-format', 'json3/vtt/srt', '--no-progress', '-o', 'captions.%(ext)s']
                else:
                    command = command + ['--dump-single-json', '--skip-download', '--', url] if action == 'probe' else download_command(self.config, message)
                with self.job_lock:
                    count = sum(task.get('action') == action and (action == 'download' or not task['cancelled'].is_set()) for task in self.jobs.values())
                    if action != 'download' and count >= 1:
                        raise ValueError('Wait for the current ' + action + ' to finish.')
                    task = {'cancelled': threading.Event(), 'timed_out': threading.Event(), 'lock': threading.Lock(), 'action': action, 'url': url, 'source':message.get('source'), 'language': message.get('language'), 'kind':message.get('kind'),'quality':message.get('quality')}
                    self.jobs[request_id] = task
                if action == 'download': self.watch_cancel(request_id,task)
                thread = threading.Thread(target=self.run_job, args=(request_id, action, command, task), daemon=True)
                task['thread'] = thread
                thread.start()
            else:
                raise ValueError('Unknown helper action.')
        except (ValueError, KeyError, OSError, importlib.metadata.PackageNotFoundError) as error:
            self.publish({'id': request_id, 'event': 'error', 'error': str(error)[:650]})

    def run_job(self, request_id, action, command, task):
        timer = None
        process = None
        caption_temp = None
        download_temp = None
        try:
            from wrapped_hls import matches,run_stream
            if action in ('probe','download') and matches(task.get('source')):
                result=run_stream(self.config,task,lambda m:self.publish({'id':request_id,**m}))
                with self.job_lock:self.jobs.pop(request_id,None)
                self.publish({'id':request_id,**result});return
            if action == 'download':
                Path(self.config['directory']).mkdir(parents=True, exist_ok=True)
                download_temp = tempfile.TemporaryDirectory(prefix='.framekeep-', dir=self.config['directory'])
                # Each transfer owns its fragments, intermediate streams, and conversion output.
                command = list(command)
                command[command.index('-P') + 1] = download_temp.name
            if action == 'transcript':
                caption_temp = tempfile.TemporaryDirectory(prefix='framekeep-captions-')
                command += ['-P', caption_temp.name, '--', task['url']]
            with task['lock']:
                if task['cancelled'].is_set():
                    self.publish({'id': request_id, 'event': 'cancelled'})
                    return
                process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                           stdin=subprocess.DEVNULL, text=True, encoding='utf-8', errors='replace',
                                           creationflags=CREATE_NO_WINDOW, cwd=str(Path(__file__).resolve().parent))
                task['process'] = process
            def expire():
                task['timed_out'].set()
                self.kill(task)
            timer = threading.Timer(120 if action in ('probe', 'transcript') else 21600, expire)
            timer.daemon = True
            timer.start()
            errors = collections.deque(maxlen=20)
            info, filename = None, None
            for raw in process.stdout:
                line = raw.strip()
                if len(line) > 16 * 1024 * 1024:
                    raise ValueError('The video response was too large.')
                if action == 'probe' and line.startswith('{'):
                    info = summarize(json.loads(line))
                elif line.startswith('FK_PROGRESS:'):
                    # Progress is advisory; a malformed update must not kill the media download.
                    try:
                        progress = json.loads(line.removeprefix('FK_PROGRESS:'))
                        if not isinstance(progress, dict):
                            continue
                        total, downloaded = float(progress.get('total') or 0), float(progress.get('downloaded') or 0)
                    except (ValueError, TypeError):
                        continue
                    percent = min(100, max(0, 100 * downloaded / total)) if total > 0 and math.isfinite(total) and math.isfinite(downloaded) else None
                    def number(value):
                        try:
                            value = float(value)
                            return value if math.isfinite(value) and value >= 0 else None
                        except (TypeError, ValueError):
                            return None
                    if percent is None:
                        fragment, fragments = number(progress.get('fragment')), number(progress.get('fragments'))
                        if fragment is not None and fragments and fragments > 0:
                            percent = min(100, 100 * fragment / fragments)
                    stage = 'audio' if progress.get('vcodec') == 'none' else 'video' if progress.get('acodec') == 'none' else 'media'
                    self.publish({'id': request_id, 'event': 'progress', 'phase': 'downloading', 'percent': percent,
                               'stage': stage, 'downloaded': number(downloaded), 'total': number(total),
                               'speed': number(progress.get('speed')), 'eta': number(progress.get('eta'))})
                elif line.startswith('FK_PROCESSING'):
                    self.publish({'id': request_id, 'event': 'progress', 'phase': 'processing', 'percent': None})
                elif line.startswith('FK_FILE:'):
                    filename = json.loads(line.removeprefix('FK_FILE:'))
                elif line:
                    errors.append(line)
                    if action == 'download' and line.startswith(('[Merger]', '[ExtractAudio]')):
                        self.publish({'id': request_id, 'event': 'progress', 'phase': 'processing', 'percent': None})
            process.wait()
            if task['cancelled'].is_set():
                result = {'event': 'cancelled'}
            elif task['timed_out'].is_set():
                result = {'event': 'error', 'error': 'The operation timed out. Check your connection and try again.'}
            elif process.returncode != 0:
                result = {'event': 'error', 'error': clean_error(errors)}
            elif action == 'probe' and info:
                if task.get('source'):
                    info['source'] = task['source']
                    if info.get('audioOnly'):
                        info['title'] = task['source'].get('title') or info['title']
                    from browser_sources import remember
                    try: remember(Path(__file__).with_name('browser-sources'), task['source'])
                    except (OSError,ValueError): pass
                result = {'event': 'result', 'data': info}
            elif action == 'transcript':
                files = [path for path in Path(caption_temp.name).iterdir() if path.suffix in ('.json3', '.vtt', '.srt') and path.is_file()]
                if not files:
                    result = {'event': 'error', 'error': 'This caption track is unavailable. Try another language or retry later.'}
                elif files[0].stat().st_size > 8 * 1024 * 1024:
                    result = {'event': 'error', 'error': 'This transcript is too large to display.'}
                else:
                    parsed = parse_captions(files[0].read_text(encoding='utf-8-sig'), files[0].suffix)
                    if not parsed['cues']:
                        raise ValueError('The caption track contains no readable transcript.')
                    result = {'event': 'result', 'data': {**parsed, 'language': task['language']}}
            elif action == 'download' and filename:
                path = Path(filename).resolve()
                if path.parent != Path(download_temp.name).resolve() or not path.is_file() or path.is_symlink() or path.stat().st_size == 0:
                    raise ValueError('The downloaded file could not be verified in the save folder.')
                from recycle import publish_download
                saved = publish_download(path, self.config['directory'])
                result = {'event': 'complete', 'filename': saved.name, 'bytes': saved.stat().st_size}
            else:
                result = {'event': 'error', 'error': 'The helper did not return a verified result. Try again.'}
            # Release the job before announcing completion so the next request can start immediately.
            with self.job_lock:
                self.jobs.pop(request_id, None)
            self.publish({'id': request_id, **result})
        except Exception as error:
            self.kill(task)
            with self.job_lock:
                self.jobs.pop(request_id, None)
            self.publish({'id': request_id, 'event': 'error', 'error': clean_error(['ERROR: ' + str(error)])})
        finally:
            if timer:
                timer.cancel()
            if process:
                process.wait()
                process.stdout.close()
            if caption_temp:
                caption_temp.cleanup()
            if download_temp:
                # The unique directory was created by this job directly inside the configured folder.
                if Path(download_temp.name).resolve().parent == Path(self.config['directory']).resolve():
                    download_temp.cleanup()
            with self.job_lock:
                self.jobs.pop(request_id, None)

    def close(self):
        self._closed.set()
        with self.job_lock:
            tasks = list(self.jobs.values())
        for task in tasks:
            task['cancelled'].set()
            self.kill(task)
        for task in tasks:
            thread = task.get('thread')
            if thread:
                thread.join(timeout=5)


def main():
    config = json.loads(Path(__file__).with_name('config.json').read_text(encoding='utf-8-sig'))
    extension_id = config.get('allowedExtensionId', ORIGIN.split('/')[2])
    if not isinstance(extension_id,str) or not re.fullmatch(r'[a-p]{32}',extension_id): return 1
    if len(sys.argv) < 2 or sys.argv[1] != 'chrome-extension://' + extension_id + '/':
        return 1
    if os.name == 'nt':
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    host = Host(config)
    try:
        while (message := read_message(sys.stdin.buffer)) is not None:
            host.handle(message)
    except (ValueError, OSError):
        return 1
    finally:
        host.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
