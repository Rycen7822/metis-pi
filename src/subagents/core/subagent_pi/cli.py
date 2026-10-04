from __future__ import annotations
import argparse
import asyncio
import json
import os
from pathlib import Path
import shutil
import sys
from . import __version__
from .common import AgentError, DELIVERY_OPS, dumps, new_id, state_home
from .client import call_timeout, request

DOC_ROOT=Path(__file__).resolve().parents[4]/'docs'/'subagents'

def parser():
    p=argparse.ArgumentParser(prog='subagent-pi',description='Persistent Pi subagents: MCP + CLI, Linux/WSL2, no hooks.')
    p.add_argument('--version',action='version',version=__version__)
    p.add_argument('--home',type=Path,help='State directory (or PI_AGENTS_HOME)')
    sub=p.add_subparsers(dest='command',required=True)
    sub.add_parser('mcp',help='Run the MCP stdio adapter (stdout is protocol only)')
    sub.add_parser('pi-host',help='Run the trusted native Pi stdio adapter')
    d=sub.add_parser('daemon'); ds=d.add_subparsers(dest='action',required=True)
    for x in ('run','start','status'): ds.add_parser(x)
    ds.add_parser('stop').add_argument('--force',action='store_true')
    s=sub.add_parser('scope'); ss=s.add_subparsers(dest='action',required=True)
    so=ss.add_parser('open'); so.add_argument('--cwd',default=os.getcwd()); so.add_argument('--scope'); so.add_argument('--label',default='CLI delegation')
    ss.add_parser('list')
    for name in ('list','spawn','send','steer','follow-up','send-message','followup-task','wait','inspect','result','interrupt','close','respawn','resume','answer'):
        q=sub.add_parser(name)
        q.add_argument('--scope',default=os.environ.get('PI_AGENTS_SCOPE'))
        if name in {'spawn','send','steer','follow-up','send-message','followup-task','interrupt','close','respawn','resume','answer'}:
            q.add_argument('--request-id',default=None,help='Stable key for safe retries; generated if omitted')
        if name in {'send','steer','follow-up','send-message','followup-task','inspect','interrupt','close','respawn','resume','answer'}: q.add_argument('agent_id')
        if name=='close': q.add_argument('--confirm-cleanup',type=int,metavar='GENERATION',help='After manually inspecting and removing all descendants, confirm cleanup for this dead owner generation')
        if name=='spawn':
            q.add_argument('--cwd',default=os.getcwd()); q.add_argument('--name'); q.add_argument('--profile'); q.add_argument('--model'); q.add_argument('--thinking',help='A level supported by the selected Pi model; defaults to Pi settings')
            q.add_argument('--access',choices=['read','write'],default='write'); q.add_argument('--idle-timeout-seconds',type=int,help='Model inactivity limit; active tools and parent questions pause it. No total task deadline')
            g=q.add_mutually_exclusive_group(required=True); g.add_argument('--task'); g.add_argument('--task-file',help='UTF-8 file, or - for stdin')
        if name in {'send','steer','follow-up','send-message','followup-task','respawn','resume'}:
            g=q.add_mutually_exclusive_group(required=name in {'send','steer','follow-up','send-message','followup-task'}); g.add_argument('--message'); g.add_argument('--message-file')
            if name=='send': q.add_argument('--interrupt',action='store_true')
        if name=='list':
            q.add_argument('--limit',type=int,default=20); q.add_argument('--query')
            q.add_argument('--sort',choices=['updated','created'],default='updated'); q.add_argument('--offset',type=int,default=0)
        if name=='wait':
            q.add_argument('run_ids',nargs='*'); q.add_argument('--mode',choices=['any','all'],default='any'); q.add_argument('--timeout-seconds',type=int,help='Maximum wait in seconds, not a fixed delay; default 10 minutes, max 1 hour, 0 checks immediately')
        if name=='inspect':
            q.add_argument('--after',type=int,default=0); q.add_argument('--limit',type=int,default=20); q.add_argument('--max-bytes',type=int,default=4096); q.add_argument('--detail',choices=['tools','full'],default='tools')
        if name=='result': q.add_argument('run_id')
        if name=='result': q.add_argument('--offset',type=int,default=0); q.add_argument('--max-bytes',type=int,default=4096)
        if name=='answer':
            q.add_argument('ui_request_id'); q.add_argument('--answer',required=True,help='Text, or JSON true/false for confirmation')
    d=sub.add_parser('doctor',help='Diagnostics; add --inheritance for source/skill/server names only')
    d.add_argument('--inheritance',action='store_true',help='Include Codex inheritance diagnostics (names only, no values)')
    g=sub.add_parser('guide'); g.add_argument('topic',nargs='?',default='getting-started'); g.add_argument('--section'); g.add_argument('--offset',type=int,default=0); g.add_argument('--max-bytes',type=int,default=4096)
    sub.add_parser('schemas',help='Print the exact MCP tool definitions')
    c=sub.add_parser('call',help='Generic CLI/IPC API for scripts; accepts a JSON object'); c.add_argument('operation'); c.add_argument('--json',default='-',help='JSON text or - for stdin')
    cx=sub.add_parser('codex',help='Launch Codex with a durable scope (not a hook)'); cx.add_argument('codex_args',nargs=argparse.REMAINDER)
    return p

def read_input(path):
    return sys.stdin.read(65537) if path=='-' else Path(path).expanduser().read_text(encoding='utf-8')

def split_codex_cwd(tail):
    """Read-only scan for Codex's -C/--cd (also --cd=DIR / -CDIR) before the first
    `--`; last occurrence wins. Arguments are returned VERBATIM: Codex applies the
    chdir itself, so stripping the flag would leave it in the wrong project."""
    cwd=None; i=0
    while i<len(tail):
        a=tail[i]
        if a=='--': break
        if a in ('-C','--cd') and i+1<len(tail): cwd=tail[i+1]; i+=2; continue
        if a.startswith('--cd='): cwd=a[5:]; i+=1; continue
        if a.startswith('-C') and len(a)>2: cwd=a[2:]; i+=1; continue
        i+=1
    return cwd,list(tail)

def source_snapshot(home):
    """Trusted client-side env snapshot for scope binding; never model-visible."""
    from .inheritance import scope_source_snapshot
    from .parent import capture
    environ = dict(os.environ)
    source = scope_source_snapshot(home, environ)
    source['parent'] = capture(environ, environ.get('CODEX_THREAD_ID'))
    return source

def guide(args):
    files={p.stem:p for p in DOC_ROOT.glob('*.md')}
    if args.topic not in files: raise AgentError('unknown_topic','Available guide topics: '+', '.join(sorted(files)))
    content=files[args.topic].read_text()
    if args.section:
        lines=content.splitlines(keepends=True); found=[]; capturing=False; level=0
        for line in lines:
            if line.startswith('#'):
                title=line.lstrip('#').strip(); this_level=len(line)-len(line.lstrip('#'))
                if not capturing and (args.section.lower() in title.lower() or args.section.lower()==title.lower().replace(' ','-')):
                    capturing=True; level=this_level
                elif capturing and this_level<=level: break
            if capturing: found.append(line)
        if not found: raise AgentError('section_not_found','Section not found in the installed documentation')
        content=''.join(found)
    data=content.encode(); offset=max(0,args.offset); limit=max(256,min(args.max_bytes,16384))
    fragment=data[offset:offset+limit].decode('utf-8','ignore'); following=offset+len(fragment.encode())
    return {'topic':args.topic,'section':args.section,'text':fragment,'next_offset':following,'has_more':following<len(data),'version':__version__}

async def execute(args):
    home=(args.home.expanduser().resolve() if args.home else state_home())
    cmd=args.command
    if cmd=='pi-host':
        from .pi_host import serve_pi
        await serve_pi(home); return None
    if cmd=='mcp':
        from .mcp import serve_mcp
        await serve_mcp(home); return None
    if cmd=='daemon':
        if args.action=='run':
            from .daemon import serve
            await serve(home); return None
        if args.action=='stop': return await request(home,'shutdown',{'force':args.force},autostart=False)
        return await request(home,'ping',{},autostart=args.action=='start')
    if cmd=='scope':
        return await request(home,'scope_open',{'cwd':str(Path(args.cwd).expanduser().resolve()),'label':args.label,**({'scope':args.scope} if args.scope else {})},source=source_snapshot(home)) if args.action=='open' else await request(home,'scope_list',{})
    if cmd=='doctor': return await request(home,'doctor',{'inheritance':getattr(args,'inheritance',False)})
    if cmd=='guide': return guide(args)
    if cmd=='schemas':
        from .schema import TOOLS
        return [{k:v for k,v in t.items() if k!='_op'} for t in TOOLS]
    if cmd=='call':
        raw=sys.stdin.read() if args.json=='-' else args.json
        payload=json.loads(raw)
        if args.operation in DELIVERY_OPS:
            from .parent import capture
            async def write_result(value): print(dumps(value),flush=True)
            source={'env':{},'parent':capture(os.environ,os.environ.get('CODEX_THREAD_ID'))}
            await request(home,args.operation,payload,timeout=call_timeout(args.operation,payload,home),source=source,on_result=write_result)
            return None
        return await request(home,args.operation,payload,timeout=call_timeout(args.operation,payload,home))
    if cmd=='codex':
        exe=shutil.which('codex')
        if not exe: raise AgentError('codex_not_found','codex was not found on PATH')
        tail=args.codex_args[1:] if args.codex_args[:1]==['--'] else args.codex_args
        found,rest=split_codex_cwd(tail)  # bind the scope to Codex's actual cwd; exec Codex verbatim
        cwd=os.getcwd()
        if found is not None:
            candidate=Path(found).expanduser()
            cwd=str(candidate.resolve() if candidate.is_absolute() else (Path(cwd)/candidate).resolve())
            if not Path(cwd).is_dir(): raise AgentError('invalid_cwd',f'codex -C/--cd directory does not exist: {cwd}')
        opened=await request(home,'scope_open',{'cwd':cwd,'label':'Codex CLI',**({'scope':os.environ['PI_AGENTS_SCOPE']} if os.environ.get('PI_AGENTS_SCOPE') else {})},source=source_snapshot(home))
        env=os.environ.copy(); env.update(PI_AGENTS_SCOPE=opened['scope'],PI_AGENTS_CWD=cwd,PI_AGENTS_HOME=str(home))
        print('Pi scope: '+opened['scope'],file=sys.stderr)
        os.execvpe(exe,[exe,*rest],env)
    data=vars(args).copy()
    for k in ('command','home'): data.pop(k,None)
    if 'cwd' in data: data['cwd']=str(Path(data['cwd']).expanduser().resolve())
    if not data.get('scope'):
        if cmd=='spawn':
            data['scope']=(await request(home,'scope_open',{'cwd':data['cwd'],'label':'CLI spawn'},source=source_snapshot(home)))['scope']
        else: raise AgentError('scope_required','Pass --scope or PI_AGENTS_SCOPE; use scope list to recover known scopes')
    if 'request_id' in data and not data['request_id']: data['request_id']=new_id('cli_')
    if data.get('task_file'): data['task']=read_input(data['task_file'])
    if data.get('message_file'): data['message']=read_input(data['message_file'])
    data.pop('task_file',None); data.pop('message_file',None)
    if cmd in {'send','steer','follow-up'}: data['mode']={'send':'send','steer':'steer','follow-up':'follow_up'}[cmd]
    if cmd=='answer' and data['answer'] in {'true','false'}: data['answer']=data['answer']=='true'
    if cmd=='wait' and not data['run_ids']: data.pop('run_ids')
    data={k:v for k,v in data.items() if v is not None}
    op={'steer':'send','follow-up':'send','send-message':'message','followup-task':'followup','interrupt':'soft_interrupt','resume':'respawn'}.get(cmd,cmd)
    if op in DELIVERY_OPS:
        from .parent import capture
        async def write_result(value):
            if 'request_id' in data: value={**value,'request_id':data['request_id']}
            print(dumps(value),flush=True)
        source={'env':{},'parent':capture(os.environ,os.environ.get('CODEX_THREAD_ID'))}
        await request(home,op,data,timeout=call_timeout(op,data,home),source=source,on_result=write_result)
        return None
    result=await request(home,op,data,timeout=call_timeout(op,data,home))
    if 'request_id' in data: result={**result,'request_id':data['request_id']}
    return result

def main():
    argv=sys.argv[1:]
    if argv[:1]==['codex'] and argv[1:2] and argv[1].startswith('-') and argv[1] not in ('--','-h','--help'):
        argv=['codex','--',*argv[1:]]  # argparse REMAINDER cannot capture a leading flag (bpo-17050)
    args=parser().parse_args(argv)
    try:
        result=asyncio.run(execute(args))
        if result is not None: print(dumps(result))
    except AgentError as exc:
        print(dumps({'error':exc.as_dict()})); sys.exit(2)
    except KeyboardInterrupt: sys.exit(130)
    except (OSError,ValueError) as exc:
        print(dumps({'error':{'code':'local_error','message':str(exc)}})); sys.exit(2)
