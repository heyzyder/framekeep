"""Framekeep's JSON agent interface. Uses the same native host and saved receipts."""
import argparse
import io
import json
from pathlib import Path
import sys
import threading
import uuid
import host
from study_adapter import StudyAdapter

def invoke(config, request, progress=None):
    if not isinstance(request,dict): raise ValueError('Expected a JSON request object.')
    action=request.get('action')
    allowed={'status','library','job','probe','download','capture','transcript','cancel','study-submit','study-status','study-read','study-artifact','study-resume'}
    if action not in allowed: raise ValueError('Unsupported Framekeep agent action.')
    server=host.Host(config,output=io.BytesIO())
    if action.startswith('study-'):
        adapter=StudyAdapter(config,server.library); item=server.library.item(request.get('itemId'))
        if action=='study-submit': return adapter.submit(item,request.get('recipe','visual'))
        if action=='study-status': return adapter.status(item)
        if action=='study-read': return adapter.read(item,request.get('chunk',1))
        if action=='study-artifact': return adapter.read_artifact(item,request.get('artifactId'))
        return adapter.resume(item)
    message={**request,'id':request.get('id') or 'agent_'+uuid.uuid4().hex,'origin':request.get('origin','cli')}
    done=threading.Event(); terminal=[]
    def receive(event):
        if event.get('event') in ('result','complete','error','cancelled'): terminal.append(event); done.set()
        elif progress: progress(event)
    server.emit=receive
    try:
        server.handle(message)
        if not done.wait(21630 if action in ('download','capture') else 180): raise TimeoutError('Framekeep operation timed out.')
        result=terminal[-1]
        if result.get('event')=='error': raise ValueError(result.get('error','Operation failed.'))
        return result
    finally: server.close()

def load_config(path):
    config=json.loads(Path(path).read_text('utf-8-sig'))
    if not isinstance(config,dict) or not isinstance(config.get('directory'),str): raise ValueError('Invalid Framekeep config file.')
    return config

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',default=str(Path(__file__).with_name('config.json')),help='Explicit installed or isolated Framekeep config JSON')
    sub=parser.add_subparsers(dest='command',required=True)
    sub.add_parser('list'); sub.add_parser('status')
    for command in ('get','cancel'):
        child=sub.add_parser(command); child.add_argument('id')
    child=sub.add_parser('request'); child.add_argument('json',help='JSON object or @path to JSON file')
    for command in ('study-submit','study-status','study-read','study-resume'):
        child=sub.add_parser(command); child.add_argument('item_id')
        if command=='study-submit': child.add_argument('--recipe',choices=('visual','speech','general'),default='visual')
        if command=='study-read': child.add_argument('--chunk',type=int,default=1)
    args=parser.parse_args()
    if args.command=='request':
        request=json.loads(Path(args.json[1:]).read_text('utf-8-sig') if args.json.startswith('@') else args.json)
    elif args.command.startswith('study-'):
        request={'action':args.command,'itemId':args.item_id,**({'recipe':args.recipe} if hasattr(args,'recipe') else {}),**({'chunk':args.chunk} if hasattr(args,'chunk') else {})}
    else: request={'action':{'list':'library','get':'job'}.get(args.command,args.command),**({'target':args.id} if hasattr(args,'id') else {})}
    try:
        result=invoke(load_config(args.config),request)
        print(json.dumps({'ok':True,'result':result},ensure_ascii=False)); return 0
    except (ValueError,OSError,TimeoutError) as error:
        print(json.dumps({'ok':False,'error':str(error)},ensure_ascii=False)); return 2

if __name__=='__main__':
    if hasattr(sys.stdout,'reconfigure'): sys.stdout.reconfigure(encoding='utf-8')
    raise SystemExit(main())
