"""Minimal stdio MCP adapter to the same public Framekeep JSON agent interface."""
import argparse
import json
import sys
from framekeep_cli import invoke,load_config

SCHEMA={'type':'object','properties':{'action':{'type':'string','enum':['status','library','job','probe','download','capture','transcript','cancel','study-submit','study-status','study-read','study-artifact','study-resume']},
        'id':{'type':'string'},'target':{'type':'string'},'url':{'type':'string'},'source':{'type':'object'},'items':{'type':'array'},
        'kind':{'type':'string'},'quality':{'type':'string'},'itemId':{'type':'string'},'recipe':{'type':'string'},'chunk':{'type':'integer'},'language':{'type':'string'},'artifactId':{'type':'string'},'imageMode':{'type':'string'},'pageUrl':{'type':'string'}},'required':['action']}

def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--config',required=True); args=parser.parse_args()
    config=load_config(args.config)
    for line in sys.stdin:
        request=None
        try:
            if len(line)>1024*1024: raise ValueError('Request too large.')
            request=json.loads(line)
            if 'id' not in request: continue
            method=request.get('method')
            if method=='initialize': result={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'framekeep','version':'1.8.0'}}
            elif method=='ping': result={}
            elif method=='tools/list': result={'tools':[{'name':'framekeep','description':'Inspect or invoke Framekeep acquisition and optional attached study jobs. Same IDs and results as Desktop. No automatic study review.','inputSchema':SCHEMA}]}
            elif method=='tools/call':
                params=request.get('params',{})
                if params.get('name')!='framekeep': raise ValueError('Unknown tool.')
                data=invoke(config,{**params.get('arguments',{}),'origin':'mcp'})
                result={'content':[{'type':'text','text':json.dumps(data,ensure_ascii=False)}],'isError':False}
            else: raise ValueError('Unsupported method.')
            response={'jsonrpc':'2.0','id':request['id'],'result':result}
        except Exception as error:
            response={'jsonrpc':'2.0','id':request.get('id') if isinstance(request,dict) else None,'error':{'code':-32602,'message':str(error)[:650]}}
        print(json.dumps(response,ensure_ascii=False),flush=True)

if __name__=='__main__':
    for stream in (sys.stdin,sys.stdout):
        if hasattr(stream,'reconfigure'): stream.reconfigure(encoding='utf-8')
    main()
