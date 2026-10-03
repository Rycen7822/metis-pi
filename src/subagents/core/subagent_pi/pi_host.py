"""Thin trusted Pi-host stdio bridge over the existing Python IPC client."""
from __future__ import annotations
import asyncio
import contextlib
import json
import os
from .client import call_timeout,request
from .config import load_config
from .common import AgentError
from .schema import TOOLS,BY_NAME,validate,validate_op
from .stdio import OutputClosed,Stdio

HOST_OPS=frozenset({'pi_watch','pi_view','pi_claim','pi_observe','pi_release','pi_uncertain','pi_detach'})

async def serve_pi(home):
    io=await Stdio().open()
    tasks={}; source=None; scope=None
    async def dispatch(msg):
        nonlocal source,scope
        rid=msg['id']; prepared=None
        try:
            op=msg.get('operation'); p=msg.get('params',{})
            if not isinstance(p,dict): raise AgentError('invalid_argument','params must be an object')
            if op=='initialize':
                if source is not None: raise AgentError('already_initialized','Pi bridge is already bound')
                candidate=msg.get('source')
                if not isinstance(candidate,dict) or not isinstance(candidate.get('env'),dict) or not isinstance(candidate.get('parent'),dict) or candidate['parent'].get('kind')!='pi':
                    raise AgentError('invalid_parent','Trusted Pi initialization is required')
                ping=await request(home,'ping',{})
                if ping.get('pi_host')!=1:
                    raise AgentError('version_mismatch','Running daemon lacks Pi host support; drain and restart it explicitly')
                config=load_config(home)
                extra={k:os.environ[k] for k in config['inheritance'].get('child_env',[]) if k in os.environ}
                candidate={**candidate,'env':{**candidate['env'],**extra}}
                result=await request(home,'scope_open',p,source=candidate)
                result['boot_timeout']=call_timeout('spawn',{},home)
                source=candidate; scope=result['scope']
            else:
                if source is None: raise AgentError('uninitialized','Initialize Pi host first')
                if p.get('scope',scope)!=scope: raise AgentError('scope_mismatch','Native tools belong to the current Pi session scope')
                if op in BY_NAME and any(t['name']==op for t in TOOLS):
                    definition=BY_NAME[op]
                    validate(p,definition['inputSchema'])
                    op=definition['_op']
                elif op not in HOST_OPS:
                    raise AgentError('unknown_operation','Unknown native Pi operation')
                p={**p,'scope':scope}
                validate_op(op,p)
                current=source
                if 'model' in msg:
                    source={**source,'parent':{**source['parent'],'model':msg['model']}}
                    current=source
                if 'project_trust' in msg:
                    if op not in {'spawn','message','followup'}: raise AgentError('invalid_argument','Project trust applies only to child launches')
                    current={**source,'project_trust':msg['project_trust']}
                if op=='wait':
                    async def output(value):
                        nonlocal prepared
                        prepared=value.get('_pi_delivery')
                        await io.output({'id':rid,'ok':True,'result':value})
                    await request(home,op,p,timeout=call_timeout(op,p,home),source=current,on_result=output)
                    return
                result=await request(home,op,p,timeout=call_timeout(op,p,home),source=current)
            await io.output({'id':rid,'ok':True,'result':result})
        except AgentError as e:
            with contextlib.suppress(OutputClosed):
                await io.output({'id':rid,'ok':False,'error':e.as_dict()})
        except asyncio.CancelledError:
            if prepared:
                with contextlib.suppress(AgentError,OSError,TimeoutError):
                    for receipt in prepared['receipts']:
                        await asyncio.shield(request(home,'pi_release',{'scope':scope,'receipt':receipt},timeout=5,autostart=False,source=source))
        except OutputClosed:
            if prepared:
                with contextlib.suppress(AgentError,OSError,TimeoutError):
                    for receipt in prepared['receipts']:
                        await request(home,'pi_uncertain',{'scope':scope,'receipt':receipt},timeout=5,autostart=False,source=source)
        except Exception as e:
            # Do not print request/source values or turn an uncertain mutation
            # into an instruction to retry it.
            os.write(2,('metis subagent bridge: '+type(e).__name__+'\n').encode())
            with contextlib.suppress(OutputClosed):
                await io.output({'id':rid,'ok':False,'error':{'code':'runtime_error','message':'Runtime failure; inspect the operation before retrying a mutation'}})

    try:
        while True:
            try: line=await io.reader.readline()
            except ValueError: break
            if not line: break
            try: msg=json.loads(line)
            except (ValueError,UnicodeError): break
            if not isinstance(msg,dict): break
            if 'cancel' in msg:
                key=msg['cancel']
                if isinstance(key,str) and key in tasks: tasks[key].cancel()
                continue
            rid=msg.get('id')
            if not isinstance(rid,str) or not rid or len(rid)>128 or rid in tasks: break
            if len(tasks)>=64: break
            task=asyncio.create_task(dispatch(msg)); tasks[rid]=task
            task.add_done_callback(lambda t,key=rid:tasks.pop(key,None))
    finally:
        io.transport.close()
        pending=list(tasks.values())
        for task in pending: task.cancel()
        await asyncio.gather(*pending,return_exceptions=True)
        if source and scope:
            with contextlib.suppress(AgentError,OSError,TimeoutError):
                await request(home,'pi_detach',{'scope':scope},timeout=2,autostart=False,source=source)
        io.close()
