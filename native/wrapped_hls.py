"""Public StreamVSMov VOD: validate PNG-prefixed MPEG-TS transport segments.

Only verified transport packets reach a local-file-only FFmpeg process. Remote
playlists never reach FFmpeg and its extension/protocol checks are not disabled.
"""
import base64
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import tempfile
import time
from urllib.parse import urljoin
from media_capture import open_public, validate_url, safe_path

CREATE_NO_WINDOW=getattr(subprocess,'CREATE_NO_WINDOW',0)


def matches(source):
    try:
        url=validate_url(source['url'])
        return source.get('type')=='direct' and (url.hostname=='streamvsmov.com' or url.hostname.endswith('.streamvsmov.com')) and bool(re.fullmatch(r'/stream/[a-f0-9-]{36}/master\.m3u8',url.path,re.I))
    except (ValueError,TypeError,KeyError):return False


def read_public(url,limit):
    response,connection,final=open_public(url)
    try:
        data=response.read(limit+1)
        if len(data)>limit:raise ValueError('The player response exceeds the supported size.')
        length=response.getheader('Content-Length')
        if length and (not length.isdigit() or int(length)!=len(data)):raise ValueError('The player response was incomplete.')
        return data,final.geturl()
    finally:response.close();connection.close()


def playlist(raw,base):
    lines=raw.decode('utf-8-sig').splitlines()
    if not lines or lines[0]!='#EXTM3U' or '#EXT-X-ENDLIST' not in lines:raise ValueError('Only completed public episodes are supported by this player.')
    segments=[];duration=None
    for line in lines[1:]:
        line=line.strip()
        if line.startswith(('#EXT-X-KEY:','#EXT-X-MAP:','#EXT-X-BYTERANGE:','#EXT-X-STREAM-INF:','#EXT-X-DISCONTINUITY')):
            raise ValueError('This player uses an unsupported stream variant; no partial file was saved.')
        if line.startswith('#EXTINF:'):
            duration=float(line[8:].split(',')[0])
            if not math.isfinite(duration) or not 0<duration<=120:raise ValueError('Invalid episode segment duration.')
        elif line and not line.startswith('#'):
            if duration is None or len(segments)>=10000:raise ValueError('Invalid or oversized episode playlist.')
            url=validate_url(urljoin(base,line)).geturl()
            segments.append((url,duration));duration=None
    if not segments or duration is not None:raise ValueError('The episode playlist is incomplete.')
    return segments


def transport_packets(data):
    if not data:raise ValueError('The player returned an empty video segment.')
    if data[0]!=0x47 and not data.startswith(b'\x89PNG\r\n\x1a\n'):
        raise ValueError('The player returned an unsupported video segment.')
    # The service prefixes each TS segment with a small PNG and padding. Require
    # the complete remaining payload to consist of aligned 188-byte TS packets.
    for offset in range(min(65536,len(data))):
        if data[offset]!=0x47 or (len(data)-offset)%188 or len(data)-offset<188*3:continue
        if all(data[i]==0x47 for i in range(offset,len(data),188)):return data[offset:]
    raise ValueError('Video packet validation failed; no partial episode was saved.')


def process(command,task,timeout=120):
    with task['lock']:
        if task['cancelled'].is_set():raise ValueError('Download cancelled.')
        p=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=CREATE_NO_WINDOW)
        task['process']=p
    try:
        stdout,stderr=p.communicate(timeout=timeout)
        if task['cancelled'].is_set():raise ValueError('Download cancelled.')
        if p.returncode:raise ValueError('The local decoder could not read this episode. No partial file was saved.')
        return stdout
    except subprocess.TimeoutExpired:
        p.kill();p.communicate();raise ValueError('Episode processing timed out. No partial file was saved.') from None
    finally:
        with task['lock']:task.pop('process',None)


def run_stream(config,task,emit,*,segments_limit=None):
    """segments_limit is a Python-only QA hook, never supplied by native messages."""
    source=task['source']
    if not matches(source):raise ValueError('Unsupported wrapped stream source.')
    root=safe_path(config['directory']);root.mkdir(parents=True,exist_ok=True)
    raw,final=read_public(source['url'],2_000_000);segments=playlist(raw,final)
    if segments_limit is not None:segments=segments[:segments_limit]
    if task['cancelled'].is_set():raise ValueError('Download cancelled.')
    ffprobe=str(Path(config['ffmpeg']).with_name('ffprobe.exe'))
    with tempfile.TemporaryDirectory(prefix='.framekeep-stream-',dir=root) as temp:
        folder=Path(temp);transport=folder/'media.ts';first,_=read_public(segments[0][0],32*1024*1024)
        transport.write_bytes(transport_packets(first))
        info=json.loads(process([ffprobe,'-v','error','-protocol_whitelist','file','-show_entries','stream=codec_type,codec_name,width,height','-of','json',str(transport)],task))
        video=next((s for s in info['streams'] if s['codec_type']=='video'),None)
        audio=next((s for s in info['streams'] if s['codec_type']=='audio'),None)
        if not video and not audio:raise ValueError('No playable media found in this episode.')
        if task['action']=='probe':
            thumbnail=''
            if video:
                frame=process([config['ffmpeg'],'-v','error','-nostdin','-protocol_whitelist','file','-i',str(transport),'-frames:v','1','-an','-vf','scale=480:-2','-c:v','mjpeg','-q:v','5','-f','image2pipe','pipe:1'],task)
                if frame.startswith(b'\xff\xd8') and len(frame)<=130000:thumbnail='data:image/jpeg;base64,'+base64.b64encode(frame).decode('ascii')
            return {'event':'result','data':{'id':hashlib.sha256(source['url'].encode()).hexdigest()[:12],'title':source.get('title') or 'Episode','platform':'Embedded video','channel':'','duration':sum(d for _,d in segments),'heights':[video['height']] if video and video.get('height') else [],'audioOnly':not video,'tracks':[],'thumbnail':thumbnail,'source':source}}
        kind,quality=task['kind'],str(task['quality'])
        if kind=='video' and (not video or (quality!='best' and int(quality)<video.get('height',0))):raise ValueError('This episode has one source resolution. Choose Best available.')
        if kind=='audio' and (not audio or quality not in ('128','192','320')):raise ValueError('The selected audio format is unavailable.')
        started=time.monotonic();size=len(first)
        with transport.open('ab') as stream:
            for index,(url,_) in enumerate(segments[1:],1):
                if task['cancelled'].is_set():raise ValueError('Download cancelled.')
                if time.monotonic()-started>21600:raise ValueError('Episode download timed out.')
                data,_=read_public(url,32*1024*1024);size+=len(data)
                if size>16*1024**3:raise ValueError('Episode exceeds the 16 GiB download limit.')
                stream.write(transport_packets(data))
                emit({'event':'progress','phase':'downloading','stage':kind,'percent':100*(index+1)/len(segments),'downloaded':size,'total':None,'speed':size/max(1,time.monotonic()-started),'eta':None})
        if task['cancelled'].is_set():raise ValueError('Download cancelled.')
        emit({'event':'progress','phase':'processing','percent':None})
        title=re.sub(r'[<>:"/\\|?*\x00-\x1f]','_',str(source.get('title') or 'Episode'))[:120].strip(' .') or 'Episode'
        extension='mp3' if kind=='audio' else 'mp4'
        target=folder/f'{title} [video-{hashlib.sha256(source["url"].encode()).hexdigest()[:12]}] [{kind}-{quality}].{extension}'
        command=[config['ffmpeg'],'-v','error','-nostdin','-protocol_whitelist','file','-i',str(transport)]
        command+=['-vn','-c:a','libmp3lame','-b:a',quality+'k'] if kind=='audio' else ['-map','0:v:0','-map','0:a:0?','-c','copy','-movflags','+faststart']
        process(command+[str(target)],task,timeout=1200)
        if not target.is_file() or not target.stat().st_size:raise ValueError('The episode output is empty.')
        if task['cancelled'].is_set():raise ValueError('Download cancelled.')
        from recycle import publish_download
        saved=publish_download(target,root)
        return {'event':'complete','filename':saved.name,'bytes':saved.stat().st_size}
