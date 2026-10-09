"""Pi parent leases and attention in the existing ledger; no model/UI owner."""
from __future__ import annotations
import asyncio
import hashlib
import json
from pathlib import Path
from .common import AgentError, dumps, identifier, new_id, now, text

LEASE_SECONDS = 90

def is_pi(parent):
    return isinstance(parent, dict) and parent.get('kind') == 'pi'

def bound_parent(store, sid):
    raw = store.scope(sid)['parent']
    return json.loads(raw) if raw else None

def bind(store, sid, source, allow_new=True):
    parent = (source or {}).get('parent')
    fields = {'kind','session_id','agent_dir','session_file','sdk_path','node_path','lease','model'}
    if not is_pi(parent) or set(parent) != fields:
        raise AgentError('invalid_parent', 'Invalid trusted Pi parent binding')
    for key in fields - {'model','session_file'}:
        text(parent[key], key, 16384)
    identifier(parent['lease'], 'lease')
    for key in ('agent_dir','sdk_path','node_path'):
        if not Path(parent[key]).is_absolute():
            raise AgentError('invalid_parent', f'{key} must be absolute')
    if not isinstance(parent['session_file'],str) or len(parent['session_file'])>16384 or '\x00' in parent['session_file']:
        raise AgentError('invalid_parent', 'Invalid session_file')
    if parent['session_file'] and not Path(parent['session_file']).is_absolute():
        raise AgentError('invalid_parent', 'session_file must be absolute')
    model = parent['model']
    if model is not None and (not isinstance(model, dict) or set(model) != {'provider','id'} or
                             any(not isinstance(v,str) or not v or len(v)>512 for v in model.values())):
        raise AgentError('invalid_parent', 'Invalid Pi model identity')
    previous = bound_parent(store, sid)
    if previous and (not is_pi(previous) or
                     any(previous[k] != parent[k] for k in ('session_id','agent_dir'))):
        raise AgentError('parent_conflict', 'Scope belongs to a different parent session')
    if not allow_new and (not previous or previous['lease'] != parent['lease']):
        raise AgentError('parent_stale', 'Pi frontend lease was replaced; reattach this session')
    if previous and previous['lease'] != parent['lease']:
        store.execute("UPDATE parent_notifications SET state='unknown',error='Pi frontend replaced; reconcile session receipts before delivery' WHERE scope=? AND state IN ('pi_waiting','pi_claimed')", (sid,))
    store.execute('UPDATE scopes SET parent=? WHERE id=?', (dumps({**parent, 'expires':now()+LEASE_SECONDS}), sid))

def status(store, sid, compact=False):
    parent = bound_parent(store,sid)
    result = {'enabled':bool(parent and parent['expires']>now()), 'transport':'pi_native'}
    if not compact:
        result.update(session_id=parent['session_id'], recent=store.recent_notifications(sid))
    failed = store.one("SELECT COUNT(*) n FROM parent_notifications WHERE scope=? AND state='unknown'", (sid,))['n']
    if failed: result['failed'] = failed
    return result

class PiNotifications:
    def __init__(self, store, worker_for, changed):
        self.store, self.worker_for, self.changed = store, worker_for, changed
        self.waits = {}
        self.draining = False

    def reserve_delivery(self, op, params, source):
        from .views import wait_run_ids
        bind(self.store,params['scope'],source,False)
        ids = wait_run_ids(self.store,params) if op=='wait' else None
        if op=='wait':
            params['run_ids'] = ids
            params.pop('agent_ids',None)
        token = object()
        self.waits[token] = (params['scope'], frozenset(ids) if ids is not None else None, source['parent']['lease'])
        return token

    def prepare_delivery(self, token, op, response):
        sid, ids, lease = self.waits[token]
        parent = bound_parent(self.store,sid)
        if parent['lease'] != lease:
            raise AgentError('parent_stale', 'Parent changed before result delivery')
        from .views import delivered_events
        events = [e for e in delivered_events(op,response) if ids is None or e[0] in ids]
        selected = []; receipts = []
        for rid,kind,ui_id in events:
            row = self.store.one('SELECT id,state,handled FROM parent_notifications WHERE scope=? AND run_id=? AND kind=? AND ui_id IS ?', (sid,rid,kind,ui_id))
            if row and not row['handled'] and row['state'] != 'pi_claimed':
                previous=self.store.one('SELECT pi_receipt,pi_owner FROM parent_notifications WHERE id=?',(row['id'],))
                receipt=previous['pi_receipt'] if row['state']=='pi_waiting' and previous['pi_owner']==lease else new_id('delivery_')
                self.store.execute("UPDATE parent_notifications SET state='pi_waiting',pi_receipt=?,pi_owner=?,error=NULL WHERE id=?", (receipt,lease,row['id']))
                selected.append(row['id'])
                receipts.append(receipt)
        questions=response.get('questions',[])
        if selected or questions:
            response['_pi_delivery'] = {'id':receipts[0] if receipts else new_id('delivery_'),'events':selected,
                'receipts':list(dict.fromkeys(receipts)), 'questions':questions}

    def release_delivery(self, token):
        # IPC output is not a Pi result receipt. Prepared tickets stay reserved
        # until the native frontend confirms, releases or reconciles them.
        self.waits.pop(token,None)

    def pending(self, sid):
        rows = self.store.all("SELECT n.*,r.agent_id,r.state AS run_state,a.name FROM parent_notifications n JOIN runs r ON r.id=n.run_id JOIN agents a ON a.id=r.agent_id WHERE n.scope=? AND n.state='pending' AND n.handled=0 ORDER BY n.created,n.id LIMIT 50", (sid,))
        result = []
        for row in rows:
            w = self.worker_for(row['agent_id'])
            relevant = row['kind']=='terminal' or bool(w and w.run_id==row['run_id'] and row['ui_id'] in w.ui)
            if not relevant:
                self.store.execute("UPDATE parent_notifications SET state='superseded' WHERE id=?", (row['id'],))
                continue
            if any(scope==sid and (ids is None or row['run_id'] in ids) for scope,ids,_ in self.waits.values()): continue
            result.append({'notification_id':row['id'],'run_id':row['run_id'],'agent_id':row['agent_id'],
                           'name':row['name'],'event':row['kind'],'state':row['run_state'],
                           **({'ui_request_id':row['ui_id']} if row['ui_id'] else {})})
        return result

    async def dispatch(self, op, p, source):
        sid = identifier(p.get('scope'),'scope')
        bind(self.store,sid,source,False)
        lease = source['parent']['lease']
        if op == 'pi_view':
            from .views import conversation
            return conversation(self.store,self.worker_for,p)
        if op == 'pi_watch':
            after = p.get('after')
            until = asyncio.get_running_loop().time()+25
            async with self.changed:
                while True:
                    if self.draining:
                        raise AgentError('daemon_idle','Idle daemon is parked; background watching does not wake it')
                    parent = bound_parent(self.store,sid)
                    if parent['lease'] != lease: raise AgentError('parent_stale','Parent lease replaced')
                    notifications = self.pending(sid)
                    states = self.store.all("""SELECT a.id,a.name,a.state,a.current_run,a.cwd,COALESCE(r.started,r.created,a.updated) AS started
                        FROM agents a LEFT JOIN runs r ON r.id=a.current_run
                        WHERE a.scope=? AND a.state IN ('starting','running','needs_input','stopping')
                        ORDER BY a.created,a.id""",(sid,))
                    for agent in states:
                        w = self.worker_for(agent['id'])
                        if w and not w.closed:
                            agent.update(active_tools=list(w.active_tools.values()),tool_uses=w.tool_uses,
                                         total_tokens=w.usage.get('totalTokens',0),response_preview=w.last_text[:200])
                    cursor = hashlib.sha256(dumps([notifications,states]).encode()).hexdigest()
                    remaining = until-asyncio.get_running_loop().time()
                    if cursor != after or remaining<=0:
                        return {'cursor':cursor,'notifications':notifications,'agents':states,'parent_notifications':status(self.store,sid,True)}
                    try: await asyncio.wait_for(self.changed.wait(),remaining)
                    except asyncio.TimeoutError: pass
        if op == 'pi_claim':
            eligible = {e['notification_id']:e for e in self.pending(sid)}
            ids = p.get('events', list(eligible)[:20])
            if not ids and 'events' not in p: return {'events':[], 'runs':[], 'questions':[]}
            if not isinstance(ids,list) or not 1<=len(ids)<=20 or any(not isinstance(k,str) or len(k)!=64 for k in ids):
                raise AgentError('invalid_argument','events must contain 1-20 notification IDs')
            events = [eligible[k] for k in dict.fromkeys(ids) if k in eligible]
            from .views import runs_for_ids,run_page
            rows=runs_for_ids(self.store,sid,list(dict.fromkeys(e['run_id'] for e in events)))
            page=run_page(self.store,self.worker_for,rows,{(e['run_id'],e['ui_request_id']) for e in events if e.get('ui_request_id')})
            receipt = new_id('delivery_')
            for event in events:
                self.store.execute("UPDATE parent_notifications SET state='pi_claimed',pi_receipt=?,pi_owner=? WHERE id=?", (receipt,lease,event['notification_id']))
            return {'id':receipt,'events':events,**page}
        if op in {'pi_observe','pi_release','pi_uncertain'}:
            receipt = identifier(p.get('receipt'),'receipt')
            rows = self.store.all('SELECT id,state,pi_owner FROM parent_notifications WHERE scope=? AND pi_receipt=?',(sid,receipt))
            for row in rows:
                if op=='pi_observe':
                    self.store.execute("UPDATE parent_notifications SET state='observed',handled=1,error=NULL WHERE id=?",(row['id'],))
                elif row['pi_owner']==lease and row['state'] in ('pi_waiting','pi_claimed'):
                    state = 'pending' if op=='pi_release' else 'unknown'
                    self.store.execute('UPDATE parent_notifications SET state=?,error=? WHERE id=?', (state,None if state=='pending' else 'Pi submission outcome uncertain; reconcile before retrying',row['id']))
            return {'receipt':receipt,'count':len(rows)}
        if op=='pi_detach':
            self.store.execute("UPDATE parent_notifications SET state='unknown',error='Pi frontend detached before delivery confirmation' WHERE scope=? AND pi_owner=? AND state IN ('pi_waiting','pi_claimed')", (sid,lease))
            parent=bound_parent(self.store,sid)
            self.store.execute('UPDATE scopes SET parent=? WHERE id=?',(dumps({**parent,'lease':new_id('detached_'),'expires':0}),sid))
            return {'detached':True}
        raise AgentError('unknown_operation','Unknown Pi host operation')
