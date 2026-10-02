#!/usr/bin/env python3
"""Deterministic managed SDK transport simulator. No models, credentials, network or repository edits.

It also stands in for Pi's own skill loader (get_commands returns the registry
built by skill_registry() from PI_TEST_AMBIENT_SKILL_DIRS plus --skill paths) and
for the shipped managed-surface extension: with PI_AGENTS_CHILD_BUILTINS set it
writes the same `subagent-pi-surface applied ...` stderr report the daemon gates
a restricted launch on. PI_TEST_SURFACE='missing'|'mismatch'|'malformed' breaks
that report so the daemon-side verification can be tested without real Pi."""
from __future__ import annotations
import argparse
import asyncio
import contextlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

p=argparse.ArgumentParser(add_help=False)
p.add_argument('--hold-eof',action='store_true'); p.add_argument('--session'); p.add_argument('--session-dir'); p.add_argument('--mode')
p.add_argument('--skill',action='append'); p.add_argument('--extension',action='append'); p.add_argument('--exclude-tools'); p.add_argument('--no-extensions',action='store_true'); p.add_argument('--no-skills',action='store_true'); p.add_argument('--no-context-files',action='store_true')
p.add_argument('--handle-prompt',action='store_true')
p.add_argument('--hold-prompt-ms',type=int,default=0)
p.add_argument('--no-managed-protocol',action='store_true')
p.add_argument('--reject-abort',action='store_true')
a,_=p.parse_known_args()
if a.no_context_files and any(Path(path).name=='managed-context.ts' for path in a.extension or []):
    print('subagent-pi-context ready',file=sys.stderr,flush=True)
MARK_OUTCOME='PI_MOCK_OUTCOME'
path=Path(a.session) if a.session else Path(a.session_dir)/'test-session.jsonl'; current=None; queue=[]; ui={}

def surface_report():
    """Stand-in for extensions/managed-surface.ts: report the built-in surface the
    child applied, in the same line format (ok/builtins read back from the live
    registry in real Pi)."""
    plan=os.environ.get('PI_AGENTS_CHILD_BUILTINS')
    if plan is None: return
    allowed=sorted(n for n in (x.strip() for x in plan.split(',')) if n)
    mode=os.environ.get('PI_TEST_SURFACE','ok')
    if mode=='missing': return
    if mode=='malformed':
        print('subagent-pi-surface applied',file=sys.stderr,flush=True); return
    applied=allowed if mode!='mismatch' else [n for n in allowed if n!='read']
    print('subagent-pi-surface applied ok=%s allowed=%s builtins=%s expected=%s unidentified=' % (
        'true' if applied==allowed else 'false',','.join(allowed),','.join(applied),','.join(allowed)),
        file=sys.stderr,flush=True)

def read_bootstrap():
    """Emulate the real bridge: consume the pipe, emit the ready marker and the
    structured receipt (same channel contract as codex-mcp-bridge.ts)."""
    raw=os.environ.get('PI_AGENTS_BOOTSTRAP_FD')
    if not raw or not raw.isdigit(): return None
    fd=int(raw); chunks=[]
    while True:
        try: data=os.read(fd,65536)
        except OSError: break
        if not data: break
        chunks.append(data)
    os.close(fd)
    payload=None
    try:
        payload=json.loads(b''.join(chunks))
        servers=payload.get('mcp',{}).get('servers',[])
        names=','.join(s['name'] for s in servers)
        print(f'subagent-pi-bridge ready servers={len(servers)} names={names}',file=sys.stderr,flush=True)
        for s in servers:
            if 'FAKE_TEST_ECHO' in s.get('env',{}):
                print(f'bridge-env {s["name"]}={s["env"]["FAKE_TEST_ECHO"]}',file=sys.stderr,flush=True)
        receipt={'kind':'subagent-pi-bridge-receipt','v':1,
                 'agent':payload.get('agent',{}).get('id'),'generation':payload.get('agent',{}).get('generation'),
                 'state':'ready','servers':[{'name':s['name'],'status':'lazy','required':bool(s.get('required'))} for s in servers]}
        if os.environ.get('PI_TEST_RECEIPT_STATUS')=='failed_required' and receipt['servers']:
            receipt={**receipt,'state':'ready','servers':[{**s,'status':'failed','required':True} for s in receipt['servers']]}
    except Exception:
        print('subagent-pi-bridge ready servers=0 error=malformed',file=sys.stderr,flush=True)
        receipt={'kind':'subagent-pi-bridge-receipt','v':1,'agent':None,'generation':None,'state':'failed','servers':[]}
    rraw=os.environ.get('PI_AGENTS_BRIDGE_RECEIPT_FD')
    if rraw and rraw.isdigit():
        rfd=int(rraw)
        try: os.write(rfd,(json.dumps(receipt)+'\n').encode())
        finally:
            try: os.close(rfd)
            except OSError: pass
    return payload

BRIDGE=read_bootstrap()

def skill_entry(skill_md: Path):
    """Pi's rule (dist/core/skills.js): frontmatter `name`, else the parent dir
    name; a skill without a non-empty description is not loaded at all."""
    try: head=skill_md.read_text(encoding='utf-8',errors='replace')[:4096]
    except OSError: return None
    m=re.match(r'\ufeff?---\s*\n(.*?)\n---',head,re.DOTALL)
    front=m.group(1) if m else ''
    desc=re.search(r'^description:\s*(.+?)\s*$',front,re.MULTILINE)
    if not desc or not desc.group(1).strip().strip('"\''): return None
    hit=re.search(r'^name:\s*["\']?([^"\'\n]+?)["\']?\s*$',front,re.MULTILINE)
    return hit.group(1).strip() if hit else skill_md.parent.name

def skill_registry():
    """Pi's loader order, verified against Pi 0.85.1: skills discovered from the
    user's own Pi configuration register BEFORE CLI --skill paths, and a name
    collision keeps the first registration. A Codex skill that duplicates a Pi
    skill is therefore dropped by Pi itself.
    PI_TEST_AMBIENT_SKILL_DIRS (os.pathsep separated) stands in for Pi's own
    discovery: it is empty by default, so tests never read a real ~/.pi tree."""
    registry={}
    def add(skill_md: Path):
        if not skill_md.is_file(): return
        name=skill_entry(skill_md)
        if name: registry.setdefault(name,str(skill_md.resolve()))
    for root in (os.environ.get('PI_TEST_AMBIENT_SKILL_DIRS','') or '').split(os.pathsep):
        if not root: continue
        try: entries=sorted(Path(root).iterdir())
        except OSError: continue
        for entry in entries: add(entry/'SKILL.md' if entry.is_dir() else entry)
    for raw in a.skill or []:
        entry=Path(raw); add(entry/'SKILL.md' if entry.is_dir() else entry)
    return registry

SKILLS=skill_registry()

def emit(e):
    print(json.dumps(e,ensure_ascii=False),flush=True)

def msg(role,body,**extra):
    m={'role':role,'content':[{'type':'text','text':body}],**extra}
    path.parent.mkdir(parents=True,exist_ok=True)
    if not path.exists(): path.write_text(json.dumps({'type':'session','id':'fake-session','version':3})+'\n')
    with path.open('a') as f: f.write(json.dumps({'type':'message','message':m},ensure_ascii=False)+'\n')
    emit({'type':'message_end','message':m})

def response(r,success=True,data=None,error=None):
    emit({'type':'response','id':r.get('id'),'command':r['type'],'success':success,**({'data':data} if data is not None else {}),**({'error':error} if error else {})})

TASK_OPTS={'delay','settle','resume','retry','compact','dupsettled','model','parallel','after_tool','gate'}

def parse_task(task):
    """Parse test-only key=value| prefixes: turn/post-run delay, continuation and
    retry counts, compaction, or duplicate managed completion."""
    opts={}
    while '|' in task:
        head,tail=task.split('|',1)
        key,sep,value=head.partition('=')
        if not sep or key not in TASK_OPTS: break
        opts[key]=value; task=tail
    return task,opts

async def held_prompt(r):
    """Delay the acceptance reply to exercise uncertain mutation timeouts."""
    global current
    await asyncio.sleep(a.hold_prompt_ms/1000)
    response(r); current=asyncio.create_task(run(r['message'],r['runId']))

async def run(raw_task, rid):
    task,opts=parse_task(raw_task)
    delay=float(opts.get('delay',.1)); settle=float(opts.get('settle',0))
    resume=int(opts.get('resume',0)); retry=int(opts.get('retry',0)); compact=bool(opts.get('compact'))
    emit({'type':'agent_start'})
    msg('user',task)
    if opts.get('gate'):
        while not Path(opts['gate']).exists(): await asyncio.sleep(.01)
    if task=='CRASH': os._exit(9)
    if task=='SPAWN_CHILD':
        proc=subprocess.Popen(['sleep','120'])
        emit({'type':'tool_execution_start','toolName':'bash','toolCallId':'sleep','args':{'command':'sleep 120','pid':proc.pid}})
        await asyncio.sleep(120)
    if opts.get('model'):
        kind=opts['model']
        end=asyncio.get_running_loop().time()+delay
        while asyncio.get_running_loop().time()<end:
            if kind=='noise': emit({'type':'extension_ui_request','method':'notify','message':'still alive'})
            elif kind!='silent':
                emit({'type':'message_update','assistantMessageEvent':{'type':kind+'_delta','delta':'x' if kind!='empty' else ''}})
            await asyncio.sleep(.1)
        output='Completed: '+task
    elif task=='UI_CONFIRM':
        await asyncio.sleep(float(opts.get('delay',0)))
        f=asyncio.get_running_loop().create_future(); ui['ui-1']=f
        emit({'type':'extension_ui_request','id':'ui-1','method':'confirm','title':'Allow this test operation?','message':'Test-only confirmation'})
        accepted=await f; ui.pop('ui-1',None)
        output='confirmed='+str(accepted)
    else:
        emit({'type':'tool_execution_start','toolName':'read','toolCallId':'read-1','args':{'path':'src/example.py','sample':'界'*5000 if task=='BIG' else ''}})
        if opts.get('parallel'):
            emit({'type':'tool_execution_start','toolName':'bash','toolCallId':'long-2','args':{'command':'sleep'}})
        await asyncio.sleep(delay/2)
        if task!='NO_CONSUME':
            while queue: msg('user',queue.pop(0))
        emit({'type':'tool_execution_end','toolName':'read','toolCallId':'read-1','isError':False,'result':{'content':[{'type':'text','text':'sample'}]}})
        await asyncio.sleep(delay/2)
        if opts.get('parallel'):
            emit({'type':'tool_execution_end','toolName':'bash','toolCallId':'long-2','isError':False,'result':{}})
        if task!='NO_CONSUME':
            while queue: msg('user',queue.pop(0))
        else: queue.clear()
        if opts.get('after_tool'): await asyncio.sleep(float(opts['after_tool']))
        output=('汉字🙂\u2028\u2029'*3000) if task=='BIG' else 'Completed: '+task
    if compact:
        # Pi compacts by itself: overflow ends the run with willRetry, the
        # transcript is replaced, then the retried run continues.
        msg('assistant','Context overflow; compacting before retry',stopReason='error',errorMessage='context_length_exceeded')
        emit({'type':'agent_end','messages':[],'willRetry':True})
        emit({'type':'auto_compaction_start','reason':'overflow'})
        emit({'type':'auto_compaction_end','aborted':False})
        emit({'type':'agent_start'})
        msg('assistant',output,stopReason='stop',usage={'input':100,'output':10,'totalTokens':110})
    elif retry:
        # Pi retries by itself: the low-level run ends with a transient error
        # and agent_end(willRetry), then the retry attempts run.
        msg('assistant','Transient failure: overloaded',stopReason='error',errorMessage='overloaded')
        emit({'type':'agent_end','messages':[],'willRetry':True})
        emit({'type':'auto_retry_start','attempt':1,'delayMs':0,'errorMessage':'overloaded'})
        for attempt in range(1,retry+1):
            emit({'type':'agent_start'})
            if attempt==retry: msg('assistant',output,stopReason='stop',usage={'input':100,'output':10,'totalTokens':110})
            else: msg('assistant','Transient failure: overloaded',stopReason='error',errorMessage='overloaded')
            emit({'type':'agent_end','messages':[],'willRetry':attempt<retry})
        emit({'type':'auto_retry_end','success':True,'attempt':retry})
    else:
        msg('assistant',output,stopReason='stop',usage={'input':100,'output':10,'totalTokens':110})
    emit({'type':'agent_end','messages':[]})
    # SDK work may continue after a low-level run ends; only the final managed
    # completion belongs to the daemon task.
    if settle: await asyncio.sleep(settle)
    for turn in range(1,resume+1):
        emit({'type':'agent_start'})
        msg('assistant',f'Continued {turn}: '+task,stopReason='stop',usage={'input':100,'output':10,'totalTokens':110})
        emit({'type':'agent_end','messages':[]})
    emit({'type':'managed_task_end','runId':rid})
    if opts.get('dupsettled'): emit({'type':'managed_task_end','runId':rid})

async def main():
    global current
    surface_report()
    reader=asyncio.StreamReader(); transport,_=await asyncio.get_running_loop().connect_read_pipe(lambda:asyncio.StreamReaderProtocol(reader),sys.stdin.buffer)
    while line:=await reader.readline():
        r=json.loads(line); kind=r['type']
        if kind=='get_state':
            # PI_TEST_PROBE_FILE: evidence channel for the env-binding chain test.
            # The probe runs a harmless interpreter found via PATH so the test can
            # prove the child's environment actually works (rc 127 proves it does
            # not). Only non-secret facts are recorded: rc, PATH value (test
            # fixture path), booleans for canary PRESENCE, never secret values.
            probe_file=os.environ.get('PI_TEST_PROBE_FILE')
            if probe_file and not Path(probe_file).exists():
                pc=os.environ.get('PI_TEST_PROBE_CMD')
                rc=127; out=''
                if pc:
                    exe=shutil.which(pc)
                    if exe:
                        proc=subprocess.run([exe],capture_output=True,text=True,timeout=10)
                        rc=proc.returncode; out=proc.stdout.strip()[:80]
                with open(probe_file,'w') as f:
                    json.dump({'rc':rc,'out':out,
                               'path':os.environ.get('PATH','')[:500],
                               'has_auth':'PI_TEST_AUTH' in os.environ,
                               'has_daemon_only':'PI_TEST_DAEMON_ONLY' in os.environ,
                               'home_tag':os.environ.get('PI_TEST_HOME_TAG',''),
                               'coding_agent_dir':os.environ.get('PI_CODING_AGENT_DIR',''),
                               'cwd':os.getcwd()},f)
            state={'sessionFile':str(path),'sessionId':'fake-session','isStreaming':bool(current and not current.done()),'pendingMessageCount':len(queue),'model':{'id':'fake','provider':'test'},'env_probe':{**{k:v for k,v in sorted(os.environ.items()) if k.startswith('PI_TEST_') and len(v)<=256},
                           # Non-secret location, asserted by the agent-dir binding tests:
                           **({'PI_CODING_AGENT_DIR':os.environ['PI_CODING_AGENT_DIR']} if os.environ.get('PI_CODING_AGENT_DIR') else {})},'path_probe':None if 'PI_TEST_PROBE_CMD' not in os.environ else {'rc':0}}
            if not a.no_managed_protocol: state['subagentProtocol']=1
            response(r,data=state)
        elif kind=='prompt':
            if r.get('message')=='REJECT_START': response(r,False,error='Explicit test prompt rejection')
            elif current and not current.done(): response(r,False,error='Already streaming')
            elif a.handle_prompt and MARK_OUTCOME in r.get('message',''):
                response(r)
                emit({'type':'managed_task_end','runId':r['runId'],'error':'Pi handled the input without producing an assistant result'})
            elif a.hold_prompt_ms:
                current=asyncio.create_task(held_prompt(r))
            else: response(r); current=asyncio.create_task(run(r['message'],r['runId']))
        elif kind=='steer': queue.append(r['message']); response(r)
        elif kind=='native_input': queue.append(r['message']); response(r)
        elif kind=='store_message':
            msg('custom',r['message'],customType='subagent-pi-message'); response(r,data={'stored':True})
        elif kind=='abort':
            if a.reject_abort: response(r,False,error='Uncooperative abort'); continue
            if current and not current.done():
                current.cancel()
                with contextlib.suppress(asyncio.CancelledError): await current
            queue.clear()
            for f in ui.values():
                if not f.done(): f.cancel()
            ui.clear()
            emit({'type':'managed_task_end','runId':r.get('runId'),'cancelled':True})
            response(r,data={'runId':r.get('runId'),'taskExited':True})
        elif kind=='get_commands':
            response(r,data={'commands':[{'name':'skill:'+n,'source':'skill','sourceInfo':{'path':p}}
                                         for n,p in sorted(SKILLS.items())]})
        elif kind=='extension_ui_response':
            f=ui.get(r['id'])
            if f and not f.done(): f.set_result(r.get('confirmed',False))
        else: response(r,False,error='Unknown command')
    if a.hold_eof: await asyncio.sleep(120)
    if current and not current.done():
        current.cancel()
        with contextlib.suppress(asyncio.CancelledError): await current
    transport.close()

asyncio.run(main())
