"""Download exposed public media; delegate PNG/JPEG cleaning to the installed IPS skill.

Sources are retained byte-for-byte. A batch publishes one directory only after every
item succeeds. No browser cookies, custom metadata parsers, or cloud cleaning.
"""
from __future__ import annotations
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import stat
import subprocess
import time
import uuid
from urllib.parse import urlsplit, urljoin, unquote

MAX_FILE = 256 * 1024 * 1024
MAX_BATCH = 1024 * 1024 * 1024
MIMES = {'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif','image/avif':'.avif','image/bmp':'.bmp','image/svg+xml':'.svg',
         'video/mp4':'.mp4','video/webm':'.webm','video/quicktime':'.mov','audio/mpeg':'.mp3','audio/mp4':'.m4a','audio/aac':'.aac','audio/ogg':'.ogg','audio/wav':'.wav','audio/x-wav':'.wav','audio/flac':'.flac','audio/opus':'.opus','audio/webm':'.webm','application/ogg':'.ogg'}
EXTENSIONS = set(MIMES.values()) | {'.jpeg','.m4v'}

def digest(path):
    with open(path,'rb') as stream: return hashlib.file_digest(stream,'sha256').hexdigest()

def safe_path(path):
    path=Path(os.path.abspath(path))
    for part in [*reversed(path.parents),path]:
        try: s=part.lstat()
        except FileNotFoundError: continue
        if stat.S_ISLNK(s.st_mode) or getattr(s,'st_file_attributes',0) & 0x400:
            raise ValueError('Choose a local save folder without links or cloud placeholders.')
        if not (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode)):
            raise ValueError('The save path contains a special file.')
    return path

def validate_url(value):
    if not isinstance(value,str) or len(value)>8192 or re.search(r'[\x00-\x20]',value): raise ValueError('Invalid media link.')
    u=urlsplit(value)
    if u.scheme not in ('http','https') or not u.hostname or u.username or u.password or u.port not in (None,80 if u.scheme=='http' else 443): raise ValueError('Use a standard public media link.')
    if '.' not in u.hostname or u.hostname.endswith(('.localhost','.local','.internal')): raise ValueError('Local network media is not supported.')
    try: addr=ipaddress.ip_address(u.hostname)
    except ValueError: addr=None
    if addr is not None and not addr.is_global: raise ValueError('Local network media is not supported.')
    return u._replace(fragment='')

def public_addresses(host,port):
    addresses=socket.getaddrinfo(host,port,type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ValueError('The media address resolves to a private or reserved network.')
    return addresses

def open_public(value):
    # Connect to the exact DNS result we validated; preserve hostname verification/SNI.
    # No proxies, cookie jars or credential stores are consulted.
    for _ in range(6):
        u=validate_url(value);port=u.port or (443 if u.scheme=='https' else 80)
        addresses=public_addresses(u.hostname,port);conn=None
        try:
            conn=http.client.HTTPConnection(u.hostname,port,timeout=25)
            last=None
            for family,kind,proto,_,address in addresses:
                sock=socket.socket(family,kind,proto);sock.settimeout(25)
                try: sock.connect(address);break
                except OSError as error: last=error;sock.close()
            else: raise last or OSError('No public address is reachable.')
            if u.scheme=='https':
                try: sock=ssl.create_default_context().wrap_socket(sock,server_hostname=u.hostname)
                except BaseException: sock.close();raise
            conn.sock=sock
            path=u.path or '/'
            if u.query:path+='?'+u.query
            conn.request('GET',path,headers={'User-Agent':'Framekeep/1.7','Accept':'image/*,video/*,audio/*;q=0.9','Accept-Encoding':'identity'})
            response=conn.getresponse()
            if response.status in (301,302,303,307,308):
                location=response.getheader('Location');response.close();conn.close()
                if not location:raise ValueError('The media redirect has no destination.')
                value=urljoin(value,location);continue
            if response.status != 200:raise ValueError(f'The site returned HTTP {response.status}. Signed-in or protected media may not be available to the helper.')
            return response,conn,u
        except BaseException:
            if conn:conn.close()
            raise
    raise ValueError('Too many media redirects.')

def filename(url,index,extension):
    name=unquote(url.path.rsplit('/',1)[-1]);name=Path(name).stem
    name=re.sub(r'[<>:"/\\|?*\x00-\x1f]','_',name).strip(' .')[:100] or 'media'
    if re.match(r'(?i)^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)',name):name='media-'+name
    return f'{index:03d}-{name}{extension}'

def download_one(item,index,sources,remaining,cancelled,progress):
    response,conn,url=open_public(item['url'])
    try:
        mime=response.getheader('Content-Type','').split(';')[0].strip().lower()
        ext=MIMES.get(mime)
        if not ext and mime in ('application/octet-stream','binary/octet-stream'):
            ext=Path(url.path).suffix.lower()
            if ext not in EXTENSIONS:ext=None
        if not ext:raise ValueError('This link did not return a supported image, audio or video file.')
        # The actual response type decides cleaning, never a filename supplied by a page.
        image=ext in ('.png','.jpg','.jpeg')
        folder=sources/('images' if image else 'other');folder.mkdir(exist_ok=True)
        path=folder/filename(url,index,ext);size=0
        limit=min(MAX_FILE,remaining)
        length=response.getheader('Content-Length')
        if length and (not length.isdigit() or int(length)>limit):raise ValueError('This file exceeds the capture limit. Use Video tools for large video downloads.')
        with path.open('xb') as stream:
            while True:
                if cancelled.is_set():raise ValueError('Batch cancelled. Original source bytes are retained.')
                chunk=response.read(128*1024)
                if not chunk:break
                size+=len(chunk)
                if size>limit:raise ValueError('Capture limit reached (256 MiB per file, 1 GiB per batch).')
                stream.write(chunk)
                progress(size,int(length) if length else None)
        if not size or (length and size!=int(length)):raise ValueError('The media download was empty or incomplete.')
        return {'source':path,'sha256':digest(path),'bytes':size,'sanitize':image,'mime':mime}
    finally:response.close();conn.close()

def sanitizer_paths():
    skill=Path(os.environ.get('USERPROFILE',str(Path.home())))/'.agents'/'skills'/'image-provenance-sanitizer'
    wrapper=skill/'scripts'/'Invoke-ImageProvenanceSanitizer.ps1'
    manifest=Path(os.environ.get('LOCALAPPDATA',''))/'CodexTools'/'image-provenance-sanitizer'/'tools.json'
    if not wrapper.is_file() or not manifest.is_file():raise ValueError('The installed Image Provenance Sanitizer is unavailable. No clean files were saved.')
    return wrapper,manifest

def sanitize_images(images,output,report,task):
    wrapper,_=sanitizer_paths()
    # Reuse user/machine runtimes; never install or copy a shell into Framekeep.
    candidates=[Path(os.environ.get('ProgramFiles',r'C:\Program Files'))/'PowerShell'/'7'/'pwsh.exe',
                Path(os.environ.get('USERPROFILE',str(Path.home())))/'.cache'/'codex-runtimes'/'codex-primary-runtime'/'dependencies'/'native'/'powershell'/'pwsh.exe']
    if shutil.which('pwsh.exe'):candidates.append(Path(shutil.which('pwsh.exe')))
    shell=next((p for p in candidates if p.is_file()),None)
    if shell is None:raise ValueError('Image cleaning needs the existing PowerShell 7 runtime. No clean files were saved.')
    command=[str(shell),'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',str(wrapper),'-Mode','batch','-BatchAction','metadata-only','-InputPath',str(images),'-OutputDirectory',str(output),'-ReportPath',str(report),'-TimeoutSeconds','120']
    # Bounded pipe collection via communicate avoids PowerShell stdout deadlocks.
    with task['lock']:
        if task['cancelled'].is_set():raise ValueError('Batch cancelled before cleaning.')
        process=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        task['process']=process
    try:
        stdout,stderr=process.communicate(timeout=1200)
    except subprocess.TimeoutExpired:
        subprocess.run(['taskkill.exe','/PID',str(process.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0),timeout=15)
        process.communicate(timeout=15)
        raise ValueError('Image cleaning timed out. No clean batch was published.')
    finally:
        with task['lock']:task.pop('process',None)
    if process.returncode != 0:
        note='The local sanitizer report is retained.' if report.is_file() else 'The sanitizer could not create a report; check its installed dependencies.'
        raise ValueError('Image cleaning failed. Originals are retained; no final batch was saved. '+note)
    if len(stdout)>32*1024*1024 or not report.is_file():raise ValueError('The sanitizer did not return a complete report.')
    record=json.loads(stdout.decode('utf-8-sig'))
    disk=json.loads(report.read_text('utf-8-sig'))
    if record != disk or record.get('success') is not True or record.get('offlinePolicyVerified') is not True or record.get('error') or not record.get('results'):
        raise ValueError('The sanitizer report did not confirm success and offline verification.')
    return record

def run_capture(config,message,task,emit):
    items=message.get('items')
    image_mode=message.get('imageMode','sanitize')
    if image_mode not in ('sanitize','original'):raise ValueError('Choose image cleaning or original copies.')
    if not isinstance(items,list) or not 1<=len(items)<=100:raise ValueError('Choose between 1 and 100 media items.')
    for item in items:
        if not isinstance(item,dict) or item.get('kind') not in ('image','audio','video'):raise ValueError('Invalid media selection.')
        validate_url(item.get('url'))
    if len({i['url'] for i in items})!=len(items):raise ValueError('Duplicate media in the batch.')
    root=safe_path(config['directory']);root.mkdir(parents=True,exist_ok=True)
    run='Capture-'+time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:8]
    sources=safe_path(root/'Originals'/run)
    stage=safe_path(root/('.framekeep-'+run));final=safe_path(root/run)
    if any(p.exists() for p in (sources,stage,final)):raise ValueError('Capture destination already exists.')
    sources.mkdir(parents=True);stage.mkdir();report=sources/'sanitizer-report.json'
    downloaded=[];owned={};published=False;work=None;cleaned=None
    def update(detail,completed=0):emit({'event':'progress','detail':detail,'completed':completed})
    try:
        total=0
        for index,item in enumerate(items,1):
            update(f'Downloading {index} of {len(items)}…',index-1)
            record=download_one(item,index,sources,MAX_BATCH-total,task['cancelled'],lambda size,length:None)
            record['sourceUrl']=item['url']
            if image_mode=='original':record['sanitize']=False
            downloaded.append(record);total+=record['bytes']
        expected_images=[r for r in downloaded if r['sanitize']]
        results={}
        if expected_images:
            # Downloads can be watched/customized by the Windows shell. Keep the
            # sanitizer's disposable directories in local application data.
            work_root=safe_path(Path(os.environ.get('LOCALAPPDATA',str(root)))/'Framekeep'/'CaptureWork')
            work_root.mkdir(parents=True,exist_ok=True)
            work=safe_path(work_root/run)
            if work.exists():raise ValueError('Sanitizer work directory already exists.')
            work.mkdir();cleaned=work/'cleaned'
            update(f'Cleaning and verifying {len(expected_images)} image'+('s…' if len(expected_images)!=1 else '…'))
            record=sanitize_images(sources/'images',cleaned,report,task)
            for r in record['results']:
                candidate=Path(r.get('output',''))
                if candidate.parent==cleaned and candidate.is_file() and not candidate.is_symlink() and digest(candidate)==r.get('outputSha256'):
                    owned[candidate]=r['outputSha256']
            if len(record['results'])!=len(expected_images):raise ValueError('The sanitizer returned an incomplete batch.')
            results={Path(r['source']).name:r for r in record['results']}
        files=[]
        for entry in downloaded:
            source=entry['source']
            if digest(source)!=entry['sha256']:raise ValueError('A source changed during processing.')
            target=stage/source.name
            if entry['sanitize']:
                r=results.get(source.name,{})
                candidate=Path(r.get('output',''))
                safe_path(candidate)
                if candidate.parent != cleaned or not candidate.is_file() or r.get('sourcePreserved') is not True or r.get('reencoded') is not False or r.get('dimensionsPreserved') is not True or r.get('alphaPreserved') is not True or r.get('decodedRgbaExact') is False:
                    raise ValueError('Image preservation checks were incomplete.')
                if r.get('sourceSha256Before')!=entry['sha256'] or r.get('sourceSha256After')!=entry['sha256'] or digest(candidate)!=r.get('outputSha256'):
                    raise ValueError('Image verification hashes did not match.')
                if r.get('after',{}).get('c2pa',{}).get('independentAbsenceVerified') is not True:
                    raise ValueError('Independent C2PA absence verification was not confirmed.')
                with candidate.open('rb') as src,target.open('xb') as dst:shutil.copyfileobj(src,dst)
                owned[target]=digest(target)
                if owned[target]!=r['outputSha256']:raise ValueError('Clean image changed while copying to the save folder.')
                candidate.unlink()
                owned.pop(candidate,None)
            else:
                with source.open('rb') as src,target.open('xb') as dst:shutil.copyfileobj(src,dst)
                if digest(target)!=entry['sha256']:raise ValueError('Original-format copy did not match its source.')
            owned[target]=digest(target)
            files.append({'filename':target.name,'bytes':target.stat().st_size,'sha256':owned[target],'sanitized':entry['sanitize'],'reencoded':False,'sourceUrl':entry['sourceUrl']})
        if cleaned is not None:cleaned.rmdir();work.rmdir()
        if task['cancelled'].is_set():raise ValueError('Batch cancelled before final save.')
        # Sources are rechecked as a complete set immediately before publication.
        if any(digest(r['source'])!=r['sha256'] for r in downloaded):raise ValueError('A source changed before final save.')
        receipt={'version':'1.8.0','status':'complete','imageMode':image_mode,'files':files,'originals':str(sources),'sanitizerReport':str(report) if expected_images else None,
                 'limits':{'fileBytes':MAX_FILE,'batchSourceBytes':MAX_BATCH},'sourceRetention':'Retained until the user explicitly deletes their originals.'}
        (stage/'capture-report.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8')
        # Windows directory rename is no-clobber; consumers never see a partly completed batch.
        if final.exists():raise ValueError('Capture destination appeared during processing.')
        safe_path(root);stage.rename(final);published=True
        emit({'event':'complete','folder':final.name,'files':files,'bytes':sum(f['bytes'] for f in files)})
    except BaseException as error:
        if not published:
            # Remove only run-owned, hash-unchanged final candidates. Never remove original bytes.
            for path,expected in owned.items():
                try:
                    if path.is_file() and not path.is_symlink() and digest(path)==expected:path.unlink()
                except OSError:pass
            try:
                if cleaned is not None:cleaned.rmdir();work.rmdir()
            except OSError:pass
            try:stage.rmdir()
            except OSError:pass
            try:
                with (sources/'capture-failure.json').open('x',encoding='utf-8') as stream:
                    json.dump({'status':'failed','error':str(error)[:650],'finalBatchPublished':False,'sourcesRetained':True,'stagingRetained':stage.exists(),'sanitizerWorkRetained':str(work) if work is not None and work.exists() else None},stream,indent=2)
            except OSError:pass
        raise
