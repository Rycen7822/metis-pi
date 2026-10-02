"""Bounded read projections: what a client can see about an agent, a run trace and
a terminal result. Nothing here mutates state or acknowledges work."""
from __future__ import annotations
import asyncio
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

def listed_agent(store,a,w=None):
    result={k:a[k] for k in ('id','name','state')}
    result['agent_status']=agent_status(store,a)
    return result

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

def runs_for_ids(store, sid, ids):
    if not ids: return []
    store.scope(sid)
    marks=','.join('?' for _ in ids)
    rows=store.all(f'''SELECT r.*, a.name FROM runs r JOIN agents a ON a.id=r.agent_id
                         WHERE r.scope=? AND r.id IN ({marks})''',(sid,*ids))
    by_id={r['id']:r for r in rows}
    if len(by_id)!=len(ids): raise AgentError('run_not_found','Run not found in this scope')
    return [by_id[rid] for rid in ids]

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
            'acknowledged':bool(r['ack']),'result_truncated':usage.get('result_truncated',False)}


def wait_run_ids(store,p):
    sid=p['scope']
    ids=p.get('run_ids')
    if ids is None:
        ids=[r['id'] for r in store.all("SELECT id FROM runs WHERE scope=? AND ack=0 ORDER BY created LIMIT 100",(sid,))]
    if not isinstance(ids,list) or len(ids)>100: raise AgentError('invalid_argument','run_ids must be a list of at most 100 ids')
    ids=list(dict.fromkeys(identifier(x,'run_id') for x in ids))
    runs_for_ids(store,sid,ids)
    return ids

class ReadViews:
    """Read and wait using explicit data sources; no task control or mutations."""
    def __init__(self, store, worker_for, changed, max_wait_seconds):
        self.store = store
        self.worker_for = worker_for
        self.changed = changed
        self.max_wait_seconds = max_wait_seconds

    def outstanding(self, sid, limit=20):
        rows=self.store.all("""SELECT r.*, a.name FROM runs r JOIN agents a ON a.id=r.agent_id
                             WHERE r.scope=? AND r.ack=0 ORDER BY r.created DESC LIMIT ?""",(sid,limit))
        count=self.store.one("SELECT COUNT(*) n FROM runs WHERE scope=? AND ack=0",(sid,))['n']
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
                result['run'].update(artifact_path=run['result_path'],usage=json.loads(run['usage']),acknowledged=bool(run['ack']))
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
        r=runs_for_ids(self.store,p['scope'],[identifier(p.get('run_id'),'run_id')])[0]
        if r['state'] not in TERMINAL: raise AgentError('not_terminal','Result is not ready; use wait')
        limit=integer(p.get('max_bytes',4096),'max_bytes',256,16384)
        offset=integer(p.get('offset',0),'offset',0,2**40)
        return result_row(r,limit,offset)

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
                    # Share a fixed text budget across the page, never 100 full results.
                    budget=8192; runs=[]; questions=[]
                    for row in rows:
                        item=brief_run(row)
                        if row['state'] in TERMINAL and budget>=256:
                            page=result_row(row,min(2048,budget))
                            item['result']={k:page[k] for k in ('text','result_sha256','next_offset','has_more','total_bytes','result_truncated')}
                            budget-=max(256,len(page['text'].encode()))
                        elif row['state'] in TERMINAL:
                            item['result']={'result_sha256':row['result_sha'],'next_offset':0,'has_more':True}
                        if row['state']=='needs_input':
                            worker=self.worker_for(row['agent_id'])
                            if worker:
                                questions.extend({**question,'agent_id':row['agent_id'],'run_id':row['id'],'name':item['name']}
                                                 for question in list(worker.ui.values())[:4])
                        runs.append(item)
                    reason='timeout' if not ready else 'needs_input' if attention else 'failed_or_stopped' if failures else 'completed' if done else 'empty' if not ids else 'timeout'
                    return {'scope':sid,'timed_out':not ready,'reason':reason,'runs':runs,'questions':questions}
                try: await asyncio.wait_for(self.changed.wait(),until-time.monotonic())
                except asyncio.TimeoutError: pass
