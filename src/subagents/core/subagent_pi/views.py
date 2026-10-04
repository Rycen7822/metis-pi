"""Bounded read projections: what a client can see about an agent, a run trace and
a terminal result. Delivery consumption belongs to the transport receipt."""
from __future__ import annotations
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import time

from . import parent
from .common import TERMINAL, DEFAULT_WAIT_SECONDS, AgentError, crop, dumps, identifier, integer, label

def model_settings(a):
    spec=json.loads(a['launch'])
    return {k:spec[k] for k in ('resolved_model','thinking','available_thinking') if k in spec}

def agent_status(store,a):
    row=store.one("SELECT state FROM runs WHERE id=?",(a['current_run'],)) if a['current_run'] else store.latest_run(a['id'])
    return row['state'] if row else 'idle'

def brief_agent(a, w=None):
    result={k:a[k] for k in ('id','name','scope','cwd','state','generation','current_run','cleanup')}
    result.update(model_settings(a))
    if w and not w.closed:
        result.update(current_tool=w.current_tool,active_tools=list(w.active_tools.values()),last_activity=w.last_activity,
                      idle_seconds=w.idle_seconds(),idle_timeout_seconds=w.idle_timeout_seconds)
        if w.ui: result['pending_input']=list(w.ui.values())[:4]
    return result

def brief_run(r):
    result={k:r[k] for k in ('id','agent_id','name','state')}
    if r['error']: result['error']=r['error']
    return result

def conversation(store, worker_for, p):
    """Private Pi UI projection; reasoning never enters public inspect events."""
    a=store.resolve_agent(p['scope'],label(p.get('agent_id'),'agent_id'))
    after=integer(p.get('after',0),'after',0,2**53-1)
    run=store.run(p['scope'],a['current_run']) if a['current_run'] else store.latest_run(a['id'])
    result={'agent':brief_agent(a,worker_for(a['id'])),'messages':[], 'next_cursor':after,
            'has_more':False,'session_file':a['session_file'],'history_pruned':False}
    if run: result['run']=brief_run({**run,'name':a['name']})
    try:
        with Path(a['session_file']).open('rb') as stream:
            size=stream.seek(0,2)
            if after>size: after=0; result.update(reset=True,next_cursor=0)
            stream.seek(max(0,after-1))
            continued=bool(after and stream.read(1)!=b'\n')
            stream.seek(after)
            raw=stream.read(262144)
    except FileNotFoundError: return result
    end=raw.rfind(b'\n')+1
    if not end:
        if len(raw)==262144:
            result.update(next_cursor=after+len(raw),has_more=True,history_pruned=True)
        return result
    lines=raw[:end].split(b'\n')[:-1]
    if continued: lines=lines[1:]; result['history_pruned']=True
    for line in lines:
        try: entry=json.loads(line)
        except (ValueError,UnicodeDecodeError): result['history_pruned']=True; continue
        if not isinstance(entry,dict) or entry.get('type')!='message': continue
        message=entry.get('message',{})
        if not isinstance(message,dict): continue
        content=message.get('content',[])
        if isinstance(content,list):
            content=[{k:block[k] for k in ('type','text','thinking','id','name','arguments') if k in block}
                     for block in content if isinstance(block,dict)]
        display={k:message[k] for k in ('role','toolCallId','toolName','isError','details','errorMessage') if k in message}
        display['content']=content
        result['messages'].append({'id':entry.get('id'),'message':display})
    result.update(next_cursor=after+end,has_more=len(raw)==262144 and after+end<size)
    return result

def runs_for_ids(store, sid, ids):
    if not ids: return []
    store.scope(sid)
    marks=','.join('?' for _ in ids)
    rows=store.all(f'''SELECT r.*, a.name FROM runs r JOIN agents a ON a.id=r.agent_id
                         WHERE r.scope=? AND r.id IN ({marks})''',(sid,*ids))
    by_id={r['id']:r for r in rows}
    if len(by_id)!=len(ids): raise AgentError('run_not_found','Run not found in this scope')
    return [by_id[rid] for rid in ids]

def agent_run_ids(store, sid, targets):
    ids=[]
    for target in targets:
        a=store.resolve_agent(sid,label(target,'agent_id'))
        active=store.all("SELECT id FROM runs WHERE agent_id=? AND state NOT IN ('completed','failed','interrupted','crashed','cancelled','timed_out') ORDER BY created",(a['id'],))
        if len(active)>1: raise AgentError('ambiguous_run','Agent has multiple active/queued tasks; use explicit run IDs')
        r=active[0] if active else store.latest_run(a['id'])
        if not r: raise AgentError('run_not_found','Agent has no task')
        ids.append(r['id'])
    return list(dict.fromkeys(ids))

def input_issues(store, ids):
    result={rid:{'receipts':[],'total':0,'omitted':0} for rid in ids}
    if not ids: return result
    marks=','.join('?' for _ in ids)
    rows=store.all(f'''WITH issues AS (SELECT id,run_id,state,updated,
        COUNT(*) OVER (PARTITION BY run_id) total,
        ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY created DESC,id) position
        FROM receipts WHERE run_id IN ({marks}) AND state IN ('sending','queued','unknown','not_consumed','failed'))
        SELECT * FROM issues WHERE position<=5''',ids)
    for row in rows:
        item=result[row['run_id']]
        item['receipts'].append({k:row[k] for k in ('id','state','updated')})
        item.update(total=row['total'],omitted=max(0,row['total']-5))
    return result

def result_row(r, limit, offset=0):
    path=Path(r['result_path'])
    size=path.stat().st_size
    if offset>size: raise AgentError('invalid_offset','Offset is beyond the result file')
    with path.open('rb') as f:
        f.seek(offset); raw=f.read(limit)
    if raw and (raw[0] & 0xC0)==0x80:
        raise AgentError('invalid_offset','Offset must be a UTF-8 boundary returned by this tool')
    # Bytes cursors never split UTF-8 in server-generated pagination.
    if offset+len(raw)<size:
        content=raw.decode('utf-8','ignore'); used=len(content.encode())
    else:
        try: content=raw.decode('utf-8'); used=len(raw)
        except UnicodeDecodeError: raise AgentError('invalid_offset','Offset must be a UTF-8 boundary returned by this tool')
    usage=json.loads(r['usage'])
    return {'run':brief_run(r),'text':content,'result_sha256':r['result_sha'],
            'next_offset':offset+used,'has_more':offset+used<size,'total_bytes':size,
            'result_truncated':usage.get('result_truncated',False)}


def wait_run_ids(store,p):
    sid=p['scope']
    ids=p.get('run_ids')
    if 'agent_ids' in p:
        if ids is not None: raise AgentError('invalid_argument','Choose agent_ids or run_ids, not both')
        targets=p['agent_ids']
        if not isinstance(targets,list) or len(targets)>100: raise AgentError('invalid_argument','agent_ids must be a list of at most 100 names/IDs')
        ids=agent_run_ids(store,sid,targets)
    if ids is None:
        ids=[r['id'] for r in store.all("""SELECT r.id FROM runs r LEFT JOIN parent_notifications n
            ON n.run_id=r.id AND n.kind='terminal' WHERE r.scope=?
            AND (r.state NOT IN ('completed','failed','interrupted','crashed','cancelled','timed_out') OR COALESCE(n.handled,0)=0)
            ORDER BY r.created LIMIT 100""",(sid,))]
    if not isinstance(ids,list) or len(ids)>100: raise AgentError('invalid_argument','run_ids must be a list of at most 100 ids')
    ids=list(dict.fromkeys(identifier(x,'run_id') for x in ids))
    runs_for_ids(store,sid,ids)
    return ids

def run_page(store, worker_for, rows, question_ids=None):
    # Complete small results first; long results share the remaining UTF-8 budget.
    budget=8192; pages={}; runs=[]; questions=[]
    done=sorted((r for r in rows if r['state'] in TERMINAL),key=lambda r:Path(r['result_path']).stat().st_size)
    issues=input_issues(store,[r['id'] for r in done])
    for row in done:
        page=result_row(row,budget)
        pages[row['id']]={k:page[k] for k in ('text','result_sha256','next_offset','has_more','total_bytes','result_truncated')}
        budget-=len(page['text'].encode())
    for row in rows:
        item=brief_run(row)
        if row['state'] in TERMINAL:
            item.update(result=pages[row['id']],input_issues=issues[row['id']])
        if row['state']=='needs_input':
            w=worker_for(row['agent_id'])
            if w:
                questions.extend({**q,'agent_id':row['agent_id'],'run_id':row['id'],'name':item['name'],'generation':w.generation}
                    for q in list(w.ui.values())[:4] if question_ids is None or (row['id'],q['id']) in question_ids)
        runs.append(item)
    return {'runs':runs,'questions':questions}

def delivered_events(op, response):
    if op=='wait': runs=response['runs']
    elif op=='list': return []  # Status discovery is not delivery of a task result.
    elif op in {'result','inspect'}: runs=[response.get('run',{})]
    else: runs=[{'id':response.get('run_id'),'state':'interrupted'}]
    events=[(r['id'],'terminal',None) for r in runs if r.get('id') and r.get('state') in TERMINAL]
    if op=='wait': events.extend((q['run_id'],'question',q['id']) for q in response['questions'])
    return list(dict.fromkeys(events))

class ReadViews:
    """Read and wait using explicit data sources; no task control or mutations."""
    def __init__(self, store, worker_for, changed, max_wait_seconds):
        self.store = store
        self.worker_for = worker_for
        self.changed = changed
        self.max_wait_seconds = max_wait_seconds

    def list(self,p):
        sid=p['scope']; limit=integer(p.get('limit',20),'limit',1,50)
        offset=integer(p.get('offset',0),'offset',0,2**31-1)
        order=p.get('sort','updated')
        if order not in {'updated','created'}: raise AgentError('invalid_argument','sort must be updated or created')
        selection='FROM agents a WHERE a.scope=?'; params=(sid,)
        query=p.get('query','')
        if query:
            selection+=' AND (instr(lower(a.name),lower(?))>0 OR instr(lower(a.id),lower(?))>0)'
            params+=(query,query)
        total=self.store.one('SELECT COUNT(*) n FROM agents WHERE scope=?',(sid,))['n']
        matched=self.store.one('SELECT COUNT(*) n '+selection,params)['n'] if query else total
        rows=self.store.all("""SELECT a.id,a.name,a.state,a.created,a.updated,
            COALESCE((SELECT state FROM runs WHERE id=a.current_run),
                (SELECT state FROM runs WHERE agent_id=a.id AND state!='queued' ORDER BY created DESC LIMIT 1),'idle') agent_status
            """+selection+f' ORDER BY a.{order} DESC,a.created DESC,a.id DESC LIMIT ? OFFSET ?',(*params,limit,offset))
        agents=[]
        for a in rows:
            agents.append({**{k:a[k] for k in ('id','name','state','agent_status')},
                **{k+'_at':datetime.fromtimestamp(a[k],timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z') for k in ('created','updated')}})
        next_offset=offset+len(agents)
        return {'scope':sid,'agents':agents,'total':total,'matched':matched,'omitted':max(0,matched-len(agents)),
            'next_offset':next_offset,'has_more':next_offset<matched,
            'outstanding':self.outstanding(sid,limit),'parent_notifications':parent.status(self.store,sid,compact=True)}

    def outstanding(self, sid, limit=20):
        selection="""FROM runs r LEFT JOIN parent_notifications n ON n.run_id=r.id AND n.kind='terminal'
            WHERE r.scope=? AND (r.state NOT IN ('completed','failed','interrupted','crashed','cancelled','timed_out') OR COALESCE(n.handled,0)=0)"""
        rows=self.store.all("SELECT r.*, (SELECT name FROM agents WHERE id=r.agent_id) name "+selection+" ORDER BY r.created DESC LIMIT ?",(sid,limit))
        count=self.store.one("SELECT COUNT(*) n "+selection,(sid,))['n']
        return {'runs':[brief_run(r) for r in rows], 'total':count,'omitted':max(0,count-len(rows))}

    def inspect(self,p):
        a=self.store.resolve_agent(p['scope'],label(p.get('agent_id'), 'agent_id'))
        limit=integer(p.get('limit',20),'limit',1,100)
        budget=integer(p.get('max_bytes',4096),'max_bytes',1024,16384)
        after=integer(p.get('after',0),'after',0,2**63-1)
        detail=p.get('detail','tools')
        if detail not in {'tools','full'}: raise AgentError('invalid_argument','detail must be tools or full')
        sql='SELECT * FROM events WHERE agent_id=? AND seq>?'
        if detail=='tools': sql+=" AND type!='message'"
        rows=self.store.all(sql+' ORDER BY seq LIMIT ?',(a['id'],after,limit+1))
        receipts=self.store.recent_receipts(a['id'])
        result={'agent':brief_agent(a,self.worker_for(a['id'])),'events':[],'next_cursor':after,'has_more':False,'receipts':receipts}
        run=self.store.run(p['scope'],a['current_run']) if a['current_run'] else self.store.latest_run(a['id'])
        if run:
            result['run']={k:run[k] for k in ('id','state')}
            if detail=='full':
                result['run'].update({k:run[k] for k in ('created','started','ended','idle_timeout_seconds')})
                result['run'].update(artifact_path=run['result_path'],usage=json.loads(run['usage']))
        if detail=='full': result['parent_notifications']=parent.status(self.store,p['scope'])
        # Large diagnostic metadata must not consume the event page's budget.
        if len(dumps(result).encode())>budget:
            if run: result['run']={k:run[k] for k in ('id','state')}
            result.pop('parent_notifications',None)
            result['diagnostics_truncated']=True
        earliest=self.store.one('SELECT MIN(seq) n FROM events WHERE agent_id=?',(a['id'],))['n']
        result['history_pruned']=bool(after and earliest and after<earliest-1)
        # Grow the page one event at a time and measure the increment, so the byte
        # budget costs one encode per event instead of re-encoding the whole page.
        envelope=len(dumps({**result,'events':[]}).encode())
        for row in rows[:limit]:
            event={k:row[k] for k in ('seq','run_id','generation','type','created')}
            event['data']=json.loads(row['payload'])
            size=len(dumps(event).encode())+(1 if result['events'] else 0)  # + separator
            if envelope+size>budget-100:
                if not result['events']:
                    event['data']={'preview':crop(dumps(event['data']),max(80,budget//4)),'truncated':True}
                    result['events'].append(event); result['next_cursor']=row['seq']
                result['has_more']=True; break
            envelope+=size
            result['events'].append(event); result['next_cursor']=row['seq']
        if len(rows)>len(result['events']): result['has_more']=True
        if len(dumps(result).encode())>budget:
            result['agent']={k:a[k] for k in ('id','state','generation','current_run')}
            result['receipts']=result['receipts'][:1]
            if detail=='full':
                if run: result['run']={k:run[k] for k in ('id','state')}
                result.pop('parent_notifications',None)
                result['diagnostics_truncated']=True
        while len(dumps(result).encode())>budget and result['events']:
            if len(result['events'])==1:
                result['events'][0]['data']={'truncated':True}
                break
            result['events'].pop()
            result['next_cursor']=result['events'][-1]['seq']
            result['has_more']=True
        return result

    def result(self,p):
        if ('run_id' in p)==('agent_id' in p): raise AgentError('invalid_argument','Choose exactly one of run_id or agent_id')
        rid=identifier(p['run_id'],'run_id') if 'run_id' in p else agent_run_ids(self.store,p['scope'],[p['agent_id']])[0]
        r=runs_for_ids(self.store,p['scope'],[rid])[0]
        if r['state'] not in TERMINAL: raise AgentError('not_terminal','Result is not ready; use wait')
        limit=integer(p.get('max_bytes',4096),'max_bytes',256,16384)
        offset=integer(p.get('offset',0),'offset',0,2**40)
        if 'agent_id' in p and offset:
            raise AgentError('invalid_offset','Continuation requires the returned run.id; an agent may have started a new task')
        return {**result_row(r,limit,offset),'input_issues':input_issues(self.store,[rid])[rid]}

    async def wait(self,p):
        sid=p['scope']; limit=self.max_wait_seconds
        seconds=integer(p.get('timeout_seconds',min(DEFAULT_WAIT_SECONDS,limit)),'timeout_seconds',0,limit)
        mode=p.get('mode','any')
        if mode not in {'any','all'}: raise AgentError('invalid_argument','mode must be any or all')
        ids=wait_run_ids(self.store,p)
        until=time.monotonic()+seconds
        async with self.changed:
            while True:
                rows=runs_for_ids(self.store,sid,ids)
                done=[r for r in rows if r['state'] in TERMINAL]
                attention=[r for r in rows if r['state']=='needs_input']
                failures=[r for r in done if r['state']!='completed']
                ready=not ids or bool(attention) or (bool(done) if mode=='any' else len(done)==len(ids))
                if ready or time.monotonic()>=until:
                    reason='timeout' if not ready else 'needs_input' if attention else 'failed_or_stopped' if failures else 'completed' if done else 'empty' if not ids else 'timeout'
                    return {'scope':sid,'timed_out':not ready,'reason':reason,**run_page(self.store,self.worker_for,rows)}
                try: await asyncio.wait_for(self.changed.wait(),until-time.monotonic())
                except asyncio.TimeoutError: pass
