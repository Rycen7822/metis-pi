from __future__ import annotations
import asyncio
import gc
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import stat as statmod
import subprocess
import sys
import tempfile
import unittest
import weakref
from unittest import mock as m

from paths import ROOT, TEST_ROOT, REPO_ROOT
from subagent_pi.common import AgentError, dumps, group_members, process_identity
from subagent_pi import worker
from subagent_pi import views
from subagent_pi.pi_parent import PiNotifications, bind
from subagent_pi.runtime import Runtime
from subagent_pi.worker import read_receipt
from subagent_pi.schema import TOOLS, validate_op
from subagent_pi.store import Store
from test_inheritance import make_codex_home
from runtime_harness import RuntimeHarness

# No env_vars: the receipt-failure receipt must not depend on client env resolution.
RECEIPT_TOML='''
[mcp_servers.filesrv]
command = "cat"
cwd = "servers/dir with space"
'''

class RuntimeTests(RuntimeHarness, unittest.IsolatedAsyncioTestCase):
    async def test_proxy_environment_follows_each_scope_and_never_persists(self):
        from subagent_pi.binding import ScopeBindings
        from subagent_pi.common import BASE_ENV_KEYS, PROXY_ENV_KEYS
        spec={'profile':'default','access':'read','cwd':str(self.workspace)}
        for native in (False,True):
            sid=(await self.rt.dispatch('scope_open',{'cwd':str(self.workspace)}))['scope']
            proxy='http://user:proxy-secret-canary@127.0.0.1:7897'
            env={key:proxy for key in PROXY_ENV_KEYS}
            env.update(PATH='/bin',OPENAI_API_KEY='auth-not-authorized',UNRELATED_SECRET='not-authorized')
            source={'env':env,**({'parent':{'kind':'pi'}} if native else {})}
            self.rt.bindings.bind_scope_source(sid,{},source)
            child=self.rt.bindings.child_env(sid,spec)
            self.assertTrue(all(child[key]==proxy for key in PROXY_ENV_KEYS))
            self.assertNotIn('OPENAI_API_KEY',child)
            self.assertNotIn('UNRELATED_SECRET',child)
            stored=json.loads(self.rt.store.scope(sid)['base_env'])
            self.assertEqual(stored,{'PATH':'/bin'})
            self.assertTrue(set(stored)<=set(BASE_ENV_KEYS))
            self.assertNotIn(b'proxy-secret-canary',(self.home/'registry.sqlite').read_bytes())
            restored=ScopeBindings(self.rt.store,self.rt.config)
            self.assertEqual(restored.child_env(sid,spec)['PATH'],'/bin')
            self.assertTrue(all(key not in restored.child_env(sid,spec) for key in PROXY_ENV_KEYS))
            restored.bind_scope_source(sid,{},source)
            self.assertEqual(restored.child_env(sid,spec)['HTTPS_PROXY'],proxy)
        other=(await self.rt.dispatch('scope_open',{'cwd':str(self.workspace)}))['scope']
        self.rt.bindings.bind_scope_source(other,{}, {'env':{'HTTPS_PROXY':'http://127.0.0.1:8888'}})
        self.assertEqual(self.rt.bindings.child_env(other,spec)['HTTPS_PROXY'],'http://127.0.0.1:8888')
        self.assertNotIn('HTTP_PROXY',self.rt.bindings.child_env(other,spec))
        self.rt.config['profiles']['default']['env']={'HTTPS_PROXY':''}
        self.assertEqual(self.rt.bindings.child_env(other,spec)['HTTPS_PROXY'],'')

    async def test_history_search_and_paging_put_reused_agents_first(self):
        older=await self.spawn('first',name='Review%Alpha'); await self.wait(older['run_id'])
        newer=await self.spawn('second',name='review-beta'); await self.wait(newer['run_id'])
        followup=await self.mutation('followup',older['agent_id'],message='third'); await self.wait(followup['run_id'])
        async def listing(**extra):
            return await self.rt.dispatch('list',{'scope':self.scope,'limit':1,**extra})
        first=await listing()
        self.assertEqual(first['agents'][0]['id'],older['agent_id'])
        self.assertEqual(first['agents'][0]['agent_status'],'completed')
        self.assertEqual((first['total'],first['matched'],first['omitted']),(2,2,1))
        self.assertTrue(first['has_more'])
        second=await listing(offset=first['next_offset'])
        self.assertEqual(second['agents'][0]['id'],newer['agent_id']); self.assertFalse(second['has_more'])
        self.assertLess(first['agents'][0]['created_at'],second['agents'][0]['created_at'])
        self.assertGreater(first['agents'][0]['updated_at'],second['agents'][0]['updated_at'])
        self.assertTrue(first['agents'][0]['updated_at'].endswith('Z'))
        self.assertEqual((await listing(sort='created'))['agents'][0]['id'],newer['agent_id'])
        for query in ('REVIEW%ALPHA','%',older['agent_id']):
            found=await listing(query=query)
            self.assertEqual([a['id'] for a in found['agents']],[older['agent_id']])
            self.assertEqual((found['total'],found['matched'],found['omitted']),(2,1,0))
            self.assertFalse(found['has_more'])
            self.assertEqual(found['outstanding']['total'],3)
        missing=await listing(query='absent')
        self.assertEqual((missing['agents'],missing['total'],missing['matched'],missing['has_more']),([],2,0,False))
        self.assertEqual(missing['outstanding']['runs'][0]['id'],followup['run_id'])
        self.assertEqual(views.delivered_events('list',missing),[])
        beyond=await listing(offset=20)
        self.assertFalse(beyond['has_more']); self.assertEqual(beyond['agents'],[])

    async def test_named_wait_freezes_task_and_result_preserves_byte_budget_and_input_issues(self):
        a=await self.spawn('simple',name='review')
        selection={'scope':self.scope,'agent_ids':['review']}
        token=self.rt.parent_notifications.reserve_delivery('wait',selection,None)
        await self.wait(a['run_id'])
        b=await self.mutation('followup','review',message='delay=120|next task')
        frozen=await self.rt.dispatch('wait',{**selection,'timeout_seconds':0})
        self.rt.parent_notifications.release_delivery(token,'wait')
        self.assertEqual(frozen['runs'][0]['id'],a['run_id'])
        current=await self.rt.dispatch('wait',{'scope':self.scope,'agent_ids':['review'],'timeout_seconds':0})
        self.assertEqual(current['runs'][0]['id'],b['run_id'])
        queued=await self.mutation('send','review',message='queued task',mode='follow_up')
        with self.assertRaises(AgentError) as ambiguous:
            await self.rt.dispatch('wait',{'scope':self.scope,'agent_ids':['review'],'timeout_seconds':0})
        self.assertEqual(ambiguous.exception.code,'ambiguous_run')
        await self.mutation('interrupt','review')
        self.assertEqual((await self.rt.dispatch('result',{'scope':self.scope,'agent_id':'review'}))['run']['id'],queued['run_id'])
        # A small UTF-8 report must fit completely, even beside a much larger report.
        owner=self.rt.store.agent(self.scope,a['agent_id'])
        small=self.rt.add_run(owner,'small report'); large=self.rt.add_run(owner,'large report')
        self.rt.store.finish(small,'completed','中'*1000); self.rt.store.finish(large,'completed','中'*5000)
        self.rt.store.execute('INSERT INTO receipts VALUES(?,?,?,?,?,?,?,?)',('missed',a['agent_id'],small,self.scope,'private message','not_consumed',1,1))
        page=await self.rt.dispatch('wait',{'scope':self.scope,'run_ids':[large,small],'timeout_seconds':0})
        self.assertEqual(page['runs'][1]['result']['text'],'中'*1000)
        self.assertFalse(page['runs'][1]['result']['has_more'])
        self.assertLessEqual(sum(len(r['result']['text'].encode()) for r in page['runs']),8192)
        self.assertTrue(page['runs'][0]['result']['has_more'])
        issues=page['runs'][1]['input_issues']
        self.assertEqual((issues['total'],issues['receipts'][0]['state']),(1,'not_consumed'))
        self.assertNotIn('message',issues['receipts'][0])

    async def test_automatic_answer_identity_rejects_replaced_run_and_worker(self):
        a=await self.spawn('UI_CONFIRM')
        q=(await self.wait(a['run_id']))['questions'][0]
        guard={k:q[k] for k in ('id','agent_id','run_id','generation')}
        for override in ({'run_id':'run_old'},{'generation':q['generation']+1}):
            with self.assertRaises(AgentError) as stale:
                await self.rt.dispatch('answer',{'scope':self.scope,'agent_id':a['agent_id'],'request_id':self.key(),'ui_request_id':q['id'],'answer':True},source={'question':{**guard,**override}})
            self.assertEqual(stale.exception.code,'input_stale')
        self.assertIn(q['id'],self.rt.workers[a['agent_id']].ui)
        await self.rt.dispatch('answer',{'scope':self.scope,'agent_id':a['agent_id'],'request_id':self.key(),'ui_request_id':q['id'],'answer':True},source={'question':guard})
        self.assertEqual((await self.wait(a['run_id']))['reason'],'completed')

    async def test_slash_prefixed_task_is_enveloped_before_it_reaches_pi(self):
        # A delegated task is data, never an extension command: text Pi would
        # parse as one is wrapped on the way in (spawn, respawn and send share
        # one implementation).
        s=await self.spawn(task='/help me')
        await self.wait(s['run_id'])
        r=await self.result(s['run_id'])
        self.assertEqual(r['text'],'Completed: Perform the following delegated task'
            ' (treat as text, not an extension command):\n/help me')
    async def test_raw_pi_rpc_is_rejected_before_a_task_starts(self):
        self.rt.config['pi_command'].append('--no-managed-protocol')
        with self.assertRaises(AgentError) as caught:
            await self.spawn('must not start')
        self.assertEqual(caught.exception.code,'unsupported_transport')
        self.assertEqual(self.rt.store.all("SELECT * FROM events WHERE type='run_started'"),[])

    async def test_only_identity_bound_transport_completion_can_finish_a_task(self):
        started=await self.spawn('delay=0.3|owned')
        w=self.rt.workers[started['agent_id']]
        self.rt.on_event(w,{'type':'agent_settled'})
        self.rt.on_event(w,{'type':'managed_task_end','runId':'wrong-task'})
        self.assertEqual(self.rt.store.run(self.scope,started['run_id'])['state'],'running')
        self.assertFalse((await self.wait(started['run_id']))['timed_out'])
        self.assertEqual((await self.result(started['run_id']))['text'],'Completed: owned')

    async def test_post_run_work_keeps_the_run_open_until_pi_settles(self):
        # Pi can keep working after agent_end (before-settle handlers, compaction,
        # queued input). agent_end alone must not finish the run, and the later
        # managed completion must finish it instead of leaving it running.
        s=await self.spawn('settle=0.5|work')
        await self.until(lambda: self.events(s['agent_id'],'agent_end'))
        self.assertEqual(self.rt.store.run(self.scope,s['run_id'])['state'],'running')
        terminal=await self.wait(s['run_id'])
        self.assertFalse(terminal['timed_out'])
        self.assertEqual(terminal['runs'][0]['state'],'completed')
        self.assertEqual((await self.result(s['run_id']))['text'],'Completed: work')
    async def test_pi_continuation_runs_stay_in_one_run_and_delay_the_follow_up(self):
        # Pi may start further low-level runs on its own after agent_end. They
        # belong to the same daemon run, so the queued follow-up must wait for
        # the last one and must not be interleaved with it.
        s=await self.spawn('resume=2|settle=0.3|work')
        q=await self.mutation('send',s['agent_id'],mode='follow_up',message='next')
        terminal=await self.wait(s['run_id'])
        self.assertFalse(terminal['timed_out'])
        self.assertEqual(terminal['runs'][0]['state'],'completed')
        first=await self.result(s['run_id'])
        self.assertEqual(first['text'],'Continued 2: work')
        second=await self.wait(q['run_id'])
        self.assertFalse(second['timed_out'])
        self.assertEqual((await self.result(q['run_id']))['text'],'Completed: next')
        runs={r['id']:r for r in self.rt.store.all('SELECT * FROM runs WHERE scope=?',(self.scope,))}
        self.assertGreaterEqual(runs[q['run_id']]['started'],runs[s['run_id']]['ended'])
        usage=json.loads(runs[s['run_id']]['usage'])
        self.assertEqual(usage['output'],30)
        self.assertEqual(usage['assistant_messages'],3)
        self.assertEqual(usage['last_message_output'],10)
        self.assertEqual(usage['max_message_output'],10)
    async def test_transient_failure_is_not_final_and_settles_after_retry(self):
        # Auto-retry: agent_end(willRetry) is not a terminal boundary, the
        # transient error must not become the run's result, and the run settles
        # after the retried run and its post-run work are done.
        s=await self.spawn('retry=2|settle=0.3|work')
        terminal=await self.wait(s['run_id'])
        self.assertFalse(terminal['timed_out'])
        self.assertEqual(terminal['runs'][0]['state'],'completed')
        self.assertNotIn('error',terminal['runs'][0])
        self.assertEqual((await self.result(s['run_id']))['text'],'Completed: work')
        retries=[json.loads(e['payload']) for e in self.events(s['agent_id'],'agent_end')]
        self.assertIn(True,[e.get('willRetry') for e in retries])
        usage=json.loads(self.rt.store.one('SELECT usage FROM runs WHERE id=?',(s['run_id'],))['usage'])
        self.assertEqual(usage.get('totalTokens'),110)
    async def test_auto_compaction_retry_does_not_end_the_run_early(self):
        # Auto-compaction also runs after agent_end: the overflow message and the
        # compaction boundary must not become the run's result, and the run must
        # settle only after the retried run and its post-run work are done.
        s=await self.spawn('compact=1|settle=0.3|work')
        terminal=await self.wait(s['run_id'])
        self.assertFalse(terminal['timed_out'])
        self.assertNotIn('error',terminal['runs'][0])
        self.assertEqual((await self.result(s['run_id']))['text'],'Completed: work')
        kinds=[e['type'] for e in self.rt.store.all('SELECT type FROM events WHERE agent_id=? ORDER BY created',(s['agent_id'],))]
        self.assertEqual(kinds.count('run_terminal'),1)
        self.assertIn('auto_compaction_end',kinds)

    async def test_output_limit_is_failed_without_stale_preambles_and_can_resume(self):
        for mode,body in [('thinking',''),('text','Incomplete answer')]:
            with self.subTest(mode=mode):
                s=await self.spawn(f'limit={mode}|work')
                terminal=await self.wait(s['run_id'])
                self.assertEqual(terminal['runs'][0]['state'],'failed')
                self.assertIn('output limit',terminal['runs'][0]['error'])
                self.assertEqual((await self.result(s['run_id']))['text'],body)
                run=self.rt.store.run(self.scope,s['run_id'])
                usage=json.loads(run['usage'])
                self.assertEqual(usage['stop_reason'],'length')
                self.assertEqual(usage['token_scope'],'run_total')
                self.assertEqual(usage['last_message_output'],8)
                self.assertEqual(usage['max_message_output'],8)
                q=await self.mutation('send',s['agent_id'],mode='follow_up',message='finish')
                resumed=await self.wait(q['run_id'])
                self.assertEqual(resumed['runs'][0]['state'],'completed')
                self.assertNotIn('error',resumed['runs'][0])
                self.assertEqual((await self.result(q['run_id']))['text'],'Completed: finish')
                resumed_usage=json.loads(self.rt.store.run(self.scope,q['run_id'])['usage'])
                self.assertEqual(resumed_usage['assistant_messages'],1)
                self.assertEqual(resumed_usage['output'],resumed_usage['last_message_output'])
    async def test_late_or_duplicate_settle_cannot_finish_another_run(self):
        # A settle callback scheduled for a finished run can run while the next
        # run already owns the worker; it must be a no-op, and repeated
        # boundaries must not finish, overwrite or restart anything.
        a=await self.spawn('settle=0.2|first')
        self.assertFalse((await self.wait(a['run_id']))['timed_out'])
        b=await self.mutation('send',a['agent_id'],mode='follow_up',message='second')
        w=self.rt.workers[a['agent_id']]
        await self.rt.settle(w,a['run_id']); await self.rt.settle(w,a['run_id'])
        self.assertEqual(self.rt.store.run(self.scope,b['run_id'])['state'],'running')
        self.assertFalse((await self.wait(b['run_id']))['timed_out'])
        self.assertEqual((await self.result(b['run_id']))['text'],'Completed: second')
        terminal=[json.loads(e['payload']) for e in self.events(a['agent_id'],'run_terminal')]
        self.assertEqual([e['state'] for e in terminal],['completed','completed'])
    async def test_late_boundary_after_interrupt_does_not_revive_the_run(self):
        s=await self.spawn('settle=0.3|late')
        await self.until(lambda: self.events(s['agent_id'],'agent_end'))
        old_worker=self.rt.workers[s['agent_id']]
        await self.mutation('interrupt',s['agent_id'])
        n=await self.mutation('respawn',s['agent_id'],message='delay=0.3|second')
        # A killed worker cannot emit more events. Inject an already buffered old
        # completion while the replacement runs to verify the generation guard.
        self.rt.on_event(old_worker,{'type':'managed_task_end','runId':s['run_id']})
        await self.rt.settle(old_worker,s['run_id'])
        self.assertEqual(self.rt.store.run(self.scope,n['run_id'])['state'],'running')
        self.assertFalse((await self.wait(n['run_id']))['timed_out'])
        self.assertEqual(self.rt.store.run(self.scope,s['run_id'])['state'],'interrupted')
        self.assertEqual((await self.result(n['run_id']))['text'],'Completed: second')
        terminal=[json.loads(e['payload']) for e in self.events(s['agent_id'],'run_terminal')]
        self.assertEqual([e['state'] for e in terminal],['interrupted','completed'])
    async def test_old_reader_failure_cannot_release_replacement_writer(self):
        # Hold the control lock with an unanswered steer; queue replacement
        # before a real oversized stdout frame schedules fail_worker behind it.
        release=self.root/'release-reader'
        fake=self.root/'broken-reader.py'
        source=self.fake.read_text()
        old="        elif kind=='steer': queue.append(r['message']); response(r)"
        self.assertEqual(source.count(old),1)
        fake.write_text(source.replace(old,"""        elif kind=='steer':
            emit({'type':'extension_error','error':'STEER_ACCEPTED'})
            while not os.path.exists(%r): await asyncio.sleep(.01)
            emit({'type':'tool_execution_update','result':'x'*(8*1024*1024+1024)})
            await asyncio.sleep(120)
""" % str(release)))
        self.rt.config['pi_command']=[sys.executable,str(fake)]
        self.rt.config['rpc_timeout_seconds']=1
        spawned=await self.spawn('delay=120|OLD',access='write')
        aid=spawned['agent_id']; old_worker=self.rt.workers[aid]
        finished=asyncio.Event(); original=self.rt.fail_worker
        async def observed(w,error):
            try: await original(w,error)
            finally: finished.set()
        old_worker.on_failure=observed
        steering=asyncio.create_task(self.mutation('send',aid,mode='steer',message='STEER'))
        replacement=None
        try:
            await self.until(lambda: self.events(aid,'extension_error'))
            replacement=asyncio.create_task(self.mutation('send',aid,interrupt=True,message='delay=1|NEW'))
            await self.until(lambda: self.rt.agent_locks[aid]._waiters)
            release.touch()
            with self.assertRaises(AgentError) as caught: await steering
            self.assertEqual(caught.exception.code,'rpc_timeout')
            new=await replacement
            await asyncio.wait_for(finished.wait(),5)
            current=self.rt.workers[aid]; row=self.rt.store.agent(self.scope,aid)
            self.assertEqual(current.generation,old_worker.generation+1)
            self.assertIsNone(current.proc.returncode)
            self.assertEqual(row['state'],'running')
            self.assertEqual(row['current_run'],new['run_id'])
            self.assertEqual(row['cleanup'],'not_checked')
            self.assertIn('transport limit',old_worker.error)
            with self.assertRaises(AgentError) as conflict: await self.spawn('MUST_NOT_START',access='write')
            self.assertEqual(conflict.exception.code,'writer_conflict')
            self.assertFalse((await self.wait(new['run_id']))['timed_out'])
            self.assertEqual((await self.result(new['run_id']))['text'],'Completed: NEW')
            self.assertEqual(self.rt.store.run(self.scope,spawned['run_id'])['state'],'interrupted')
        finally:
            for task in (steering,replacement):
                if task and not task.done(): task.cancel()
            await asyncio.gather(*(t for t in (steering,replacement) if t),return_exceptions=True)

    async def test_respawn_cannot_overtake_exit_accounting(self):
        for completed in (False,True):
            with self.subTest(completed=completed):
                release=self.root/f'release-exit-{completed}'
                fake=self.root/f'exiting-{completed}.py'
                source=self.fake.read_text().replace("        elif kind=='prompt':", "        elif kind=='prompt':\n            active_rid=r['runId']")
                old="        elif kind=='steer': queue.append(r['message']); response(r)"
                self.assertEqual(source.count(old),1)
                fake.write_text(source.replace(old,"""        elif kind=='steer':
            emit({'type':'extension_error','error':'STEER_ACCEPTED'})
            while not Path(%r).exists(): await asyncio.sleep(.01)
            if %r:
                msg('assistant','OLD_FINAL',stopReason='stop')
                emit({'type':'managed_task_end','runId':active_rid})
            os._exit(0)
""" % (str(release),completed)))
                self.rt.config['pi_command']=[sys.executable,str(fake)]
                spawned=await self.spawn('delay=120|OLD')
                aid=spawned['agent_id']; old_worker=self.rt.workers[aid]
                queued=await self.mutation('send',aid,mode='follow_up',message='MUST_NOT_CROSS_GENERATION')
                steering=asyncio.create_task(self.mutation('send',aid,mode='steer',message='STEER'))
                replacement=None
                try:
                    await self.until(lambda:self.events(aid,'extension_error'))
                    replacement=asyncio.create_task(self.mutation('respawn',aid,message='delay=1|NEW'))
                    await self.until(lambda:self.rt.agent_locks[aid]._waiters)
                    release.touch()
                    with self.assertRaises(AgentError) as error: await steering
                    self.assertEqual(error.exception.code,'worker_exited')
                    new=None
                    try: new=await replacement
                    except AgentError as error:
                        self.assertEqual(error.code,'worker_alive')
                    await self.until(lambda:all(t.done() for t in old_worker.tasks))
                    self.assertEqual(self.rt.store.run(self.scope,spawned['run_id'])['state'],'completed' if completed else 'crashed')
                    self.assertEqual(self.rt.store.run(self.scope,queued['run_id'])['state'],'cancelled')
                    # Retry only an explicit rejection, with a fresh request id,
                    # after reconciliation; uncertain RPCs are never replayed.
                    if new is None: new=await self.mutation('respawn',aid,message='delay=1|NEW')
                    current=self.rt.workers[aid]
                    await self.rt.settle(old_worker,spawned['run_id'])
                    self.assertEqual(self.rt.store.agent(self.scope,aid)['current_run'],new['run_id'])
                    self.assertEqual(current.run_id,new['run_id'])
                    self.assertFalse((await self.wait(new['run_id']))['timed_out'])
                    self.assertEqual((await self.result(new['run_id']))['text'],'Completed: NEW')
                    await self.mutation('close',aid)
                finally:
                    release.touch()
                    for task in (steering,replacement):
                        if task and not task.done(): task.cancel()
                    await asyncio.gather(*(t for t in (steering,replacement) if t),return_exceptions=True)

    async def test_reader_failure_cancels_queue_before_exposing_closed_worker(self):
        spawned=await self.spawn('delay=120|OLD')
        aid=spawned['agent_id']; w=self.rt.workers[aid]
        queued=await self.mutation('send',aid,mode='follow_up',message='MUST_NOT_RESUME')
        entered=asyncio.Event(); release=asyncio.Event()
        original=worker.terminate
        async def delayed_terminate(directory,current):
            entered.set(); await release.wait()
            return await original(directory,current)
        with m.patch('subagent_pi.runtime.terminate',delayed_terminate):
            failing=asyncio.create_task(self.rt.fail_worker(w,'reader failed'))
            replacing=None
            try:
                await entered.wait()
                replacing=asyncio.create_task(self.mutation('respawn',aid,message='delay=1|NEW'))
                await self.until(lambda:self.rt.agent_locks[aid]._waiters)
                release.set(); await failing
                new=await replacing
                self.assertEqual(self.rt.store.run(self.scope,queued['run_id'])['state'],'cancelled')
                self.assertEqual(self.rt.store.run(self.scope,spawned['run_id'])['state'],'failed')
                self.assertFalse((await self.wait(new['run_id']))['timed_out'])
            finally:
                release.set()
                for task in (failing,replacing):
                    if task and not task.done(): task.cancel()
                await asyncio.gather(*(t for t in (failing,replacing) if t),return_exceptions=True)

    async def test_replacement_and_spawn_share_the_resident_limit(self):
        self.rt.config['max_resident_agents']=1
        spawned=await self.spawn('delay=120|OLD')
        aid=spawned['agent_id']; gate=asyncio.Event(); release=asyncio.Event(); competing_fork=asyncio.Event()
        original=asyncio.create_subprocess_exec
        async def delayed_fork(*args,**kwargs):
            if any(str(arg).endswith('/'+aid+'/launch.json') for arg in args):
                gate.set(); await release.wait()
            else: competing_fork.set()
            return await original(*args,**kwargs)
        with m.patch('asyncio.create_subprocess_exec',delayed_fork):
            replacement=asyncio.create_task(self.mutation('send',aid,interrupt=True,message='delay=120|NEW'))
            competing=None
            try:
                await asyncio.wait_for(gate.wait(),5)
                competing=asyncio.create_task(self.spawn('delay=120|COMPETING'))
                try: await asyncio.wait_for(competing_fork.wait(),.2)
                except TimeoutError: pass
                release.set()
                outcomes=await asyncio.gather(replacement,competing,return_exceptions=True)
                live=[w for w in self.rt.workers.values() if not w.closed and w.proc.returncode is None]
                self.assertLessEqual(len(live),1)
                self.assertIsInstance(outcomes[0],dict)
                self.assertIsInstance(outcomes[1],AgentError)
                self.assertEqual(outcomes[1].code,'capacity_exceeded')
            finally:
                release.set()
                for task in (replacement,competing):
                    if task and not task.done():task.cancel()
                await asyncio.gather(*(t for t in (replacement,competing) if t),return_exceptions=True)

    async def test_scope_capacity_reuses_history_and_applies_to_wakeups(self):
        self.rt.config['max_agents_per_scope']=1
        self.rt.config['max_resident_agents']=2
        first=await self.spawn(); await self.wait(first['run_id'])
        second=await self.spawn(); await self.wait(second['run_id'])
        self.assertEqual(self.rt.store.agent(self.scope,first['agent_id'])['state'],'dormant')
        active=await self.spawn('delay=120|active')
        with self.assertRaises(AgentError) as blocked:
            await self.mutation('followup',first['agent_id'],message='must wait')
        self.assertEqual(blocked.exception.code,'scope_limit')
        with self.assertRaises(AgentError) as blocked:
            await self.spawn('must wait')
        self.assertEqual(blocked.exception.code,'scope_limit')
        await self.mutation('interrupt',active['agent_id'])
        resumed=await self.mutation('followup',first['agent_id'],message='after interrupt')
        self.assertEqual((await self.wait(resumed['run_id']))['runs'][0]['state'],'completed')
        await self.mutation('close',first['agent_id'])
        final=await self.spawn()
        self.assertEqual((await self.wait(final['run_id']))['runs'][0]['state'],'completed')

    async def test_pi_view_reads_complete_messages_without_consuming_attention_or_signatures(self):
        started=await self.spawn(); await self.wait(started['run_id'])
        a=self.rt.store.agent(self.scope,started['agent_id']); path=Path(a['session_file'])
        source={'parent':{'kind':'pi','session_id':'view-session','agent_dir':str(self.root),
            'session_file':'','sdk_path':str(self.root),'node_path':sys.executable,'lease':'lease_view','model':None}}
        bind(self.rt.store,self.scope,source)
        host=PiNotifications(self.rt.store,self.rt.workers.get,self.rt.changed)
        messages=[{'type':'message','id':'thought','message':{'role':'assistant','content':[
            {'type':'thinking','thinking':'检查依赖','thinkingSignature':'private-signature'},
            {'type':'toolCall','id':'call','name':'read','arguments':{'path':'file.ts'}}]}},
            {'type':'message','id':'result','message':{'role':'toolResult','toolCallId':'call','toolName':'read',
                'content':[{'type':'text','text':'file contents'},{'type':'image','data':'private-image','mimeType':'image/png'}]}}]
        raw=[(json.dumps(message,ensure_ascii=False)+'\n').encode() for message in messages]
        path.write_bytes(raw[0]+raw[1][:-1])
        params={'scope':self.scope,'agent_id':a['id']}; validate_op('pi_view',params)
        notifications=[dict(row) for row in self.rt.store.all('SELECT * FROM parent_notifications')]
        first=await host.dispatch('pi_view',params,source)
        self.assertEqual(first['next_cursor'],len(raw[0]))
        self.assertEqual(first['messages'][0]['message']['content'][0],{'type':'thinking','thinking':'检查依赖'})
        params['after']=first['next_cursor']
        self.assertEqual((await host.dispatch('pi_view',params,source))['messages'],[])
        with path.open('ab') as stream: stream.write(b'\n')
        final=await host.dispatch('pi_view',params,source)
        self.assertEqual(final['messages'][0]['message']['content'],[{'type':'text','text':'file contents'},{'type':'image'}])
        self.assertEqual(final['next_cursor'],sum(map(len,raw)))
        self.assertEqual([dict(row) for row in self.rt.store.all('SELECT * FROM parent_notifications')],notifications)
        self.assertFalse(self.rt.store.one("SELECT handled FROM parent_notifications WHERE run_id=? AND kind='terminal'", (started['run_id'],))['handled'])
        with self.assertRaises(AgentError) as stale:
            await host.dispatch('pi_view',params,{'parent':{**source['parent'],'lease':'lease_stale'}})
        self.assertEqual(stale.exception.code,'parent_stale')

    async def test_pi_watch_keeps_old_active_agents_and_wakes_for_tool_activity(self):
        started=await self.spawn('delay=120|old active task')
        a=self.rt.store.agent(self.scope,started['agent_id']); w=self.rt.workers[a['id']]
        await self.until(lambda: self.events(a['id'],'tool_execution_start'))
        for i in range(20):
            self.rt.store.execute('INSERT INTO agents(id,scope,name,cwd,state,session_file,launch,created,updated) VALUES(?,?,?,?,?,?,?,?,?)',
                (f'pi_history_{i}',self.scope,f'history-{i}',a['cwd'],'dormant',a['session_file'],a['launch'],a['created']+i+1,a['updated']))
        source={'parent':{'kind':'pi','session_id':'test-session','agent_dir':str(self.root),
            'session_file':'','sdk_path':str(self.root),'node_path':sys.executable,'lease':'lease_test','model':None}}
        bind(self.rt.store,self.scope,source)
        host=PiNotifications(self.rt.store,self.rt.workers.get,self.rt.changed)
        snapshot=await host.dispatch('pi_watch',{'scope':self.scope},source)
        self.assertEqual([a['id'] for a in snapshot['agents']],[started['agent_id']])
        self.assertGreater(snapshot['agents'][0]['started'],0)
        tool_uses=snapshot['agents'][0]['tool_uses']
        active_tools=snapshot['agents'][0]['active_tools']
        waiting=asyncio.create_task(host.dispatch('pi_watch',{'scope':self.scope,'after':snapshot['cursor']},source))
        await asyncio.sleep(0)
        self.rt.on_event(w,{'type':'tool_execution_start','toolCallId':'watch-probe','toolName':'grep'})
        snapshot=await asyncio.wait_for(waiting,1)
        self.assertEqual(snapshot['agents'][0]['active_tools'],active_tools+['grep'])
        self.assertEqual(snapshot['agents'][0]['tool_uses'],tool_uses+1)
        waiting=asyncio.create_task(host.dispatch('pi_watch',{'scope':self.scope,'after':snapshot['cursor']},source))
        await asyncio.sleep(0)
        self.rt.on_event(w,{'type':'tool_execution_end','toolCallId':'watch-probe','toolName':'grep'})
        self.assertEqual((await asyncio.wait_for(waiting,1))['agents'][0]['active_tools'],active_tools)

    async def test_capacity_evicts_the_least_recently_active_idle_agent(self):
        self.rt.config['max_resident_agents']=2
        first=await self.spawn('simple'); await self.wait(first['run_id'])
        second=await self.spawn('simple'); await self.wait(second['run_id'])
        self.rt.workers[first['agent_id']].last_activity-=10
        third=await self.spawn('simple')
        self.assertFalse((await self.wait(third['run_id']))['timed_out'])
        parked=self.rt.store.agent(self.scope,first['agent_id'])
        self.assertEqual((parked['state'],parked['cleanup']),('dormant','verified'))
        self.assertEqual(self.rt.store.agent(self.scope,second['agent_id'])['state'],'idle')
        event=json.loads(self.events(first['agent_id'],'evicted')[0]['payload'])
        self.assertEqual((event['reason'],event['cleanup']),('capacity','verified'))
        self.assertEqual(len([w for w in self.rt.workers.values() if not w.closed]),2)

    async def test_capacity_never_evicts_a_pending_question(self):
        self.rt.config['max_resident_agents']=2
        asking=await self.spawn('UI_CONFIRM')
        self.assertEqual((await self.wait(asking['run_id']))['runs'][0]['state'],'needs_input')
        idle=await self.spawn('simple'); await self.wait(idle['run_id'])
        self.rt.workers[asking['agent_id']].last_activity-=10
        third=await self.spawn('simple')
        await self.wait(third['run_id'])
        self.assertEqual(self.rt.store.agent(self.scope,asking['agent_id'])['state'],'needs_input')
        self.assertEqual(self.rt.store.agent(self.scope,idle['agent_id'])['state'],'dormant')
        self.assertEqual(len(self.events(asking['agent_id'],'evicted')),0)

    async def test_capacity_without_a_parkable_candidate_still_refuses(self):
        self.rt.config['max_resident_agents']=1
        asking=await self.spawn('UI_CONFIRM')
        self.assertEqual((await self.wait(asking['run_id']))['runs'][0]['state'],'needs_input')
        with self.assertRaises(AgentError) as cm: await self.spawn('simple')
        self.assertEqual(cm.exception.code,'capacity_exceeded')
        await self.mutation('answer',asking['agent_id'],ui_request_id='ui-1',answer=False)
        self.assertFalse((await self.wait(asking['run_id']))['timed_out'])

    async def test_eviction_with_unverified_cleanup_orphans_and_tries_the_next(self):
        self.rt.config['max_resident_agents']=2
        first=await self.spawn('simple'); await self.wait(first['run_id'])
        second=await self.spawn('simple'); await self.wait(second['run_id'])
        self.rt.workers[first['agent_id']].last_activity-=10
        original=worker.terminate
        async def unknown(directory,current):
            cleanup=await original(directory,current)
            return 'unknown' if current.agent['id']==first['agent_id'] else cleanup
        with m.patch('subagent_pi.runtime.terminate',unknown):
            third=await self.spawn('simple')
        await self.wait(third['run_id'])
        event=json.loads(self.events(first['agent_id'],'evicted')[0]['payload'])
        self.assertEqual((event['reason'],event['cleanup']),('capacity','unknown'))
        # worker_exited re-judges cleanup from the real process group afterwards,
        # so the agent must at least not be left parked as a clean dormant agent.
        parked=self.rt.store.agent(self.scope,first['agent_id'])
        self.assertIn(parked['state'],{'orphaned','crashed'})
        self.assertNotEqual((parked['state'],parked['cleanup']),('dormant','verified'))
        self.assertEqual(self.rt.store.agent(self.scope,second['agent_id'])['state'],'idle')
        self.assertEqual(len([w for w in self.rt.workers.values() if not w.closed]),2)

    async def test_reader_failure_after_interrupt_keeps_the_terminal_state(self):
        spawned=await self.spawn('delay=120|running')
        w=self.rt.workers[spawned['agent_id']]
        await self.mutation('interrupt',spawned['agent_id'])
        before=self.rt.store.agent(self.scope,spawned['agent_id'])
        await self.rt.fail_worker(w,'late reader failure')
        self.assertEqual(self.rt.store.agent(self.scope,spawned['agent_id']),before)
        self.assertEqual(self.rt.store.run(self.scope,spawned['run_id'])['state'],'interrupted')

    async def test_current_reader_failure_still_stops_its_worker(self):
        spawned=await self.spawn('delay=120|running')
        w=self.rt.workers[spawned['agent_id']]
        await self.rt.fail_worker(w,'reader failed')
        self.assertEqual(self.rt.store.run(self.scope,spawned['run_id'])['state'],'failed')
        self.assertEqual(self.rt.store.agent(self.scope,spawned['agent_id'])['state'],'crashed')
        self.assertFalse(group_members(w.proc.pid))

    async def test_duplicate_settled_does_not_start_the_follow_up_twice(self):
        s=await self.spawn('dupsettled=1|work')
        q=await self.mutation('send',s['agent_id'],mode='follow_up',message='next')
        self.assertFalse((await self.wait(s['run_id']))['timed_out'])
        self.assertFalse((await self.wait(q['run_id']))['timed_out'])
        runs=self.rt.store.all("SELECT id FROM runs WHERE agent_id=?",(s['agent_id'],))
        self.assertEqual(len(runs),2)
        terminal=[json.loads(e['payload']) for e in self.events(s['agent_id'],'run_terminal')]
        self.assertEqual([e['state'] for e in terminal],['completed','completed'])
    async def test_spawn_wait_result_is_repeatable(self):
        s=await self.spawn(); terminal=await self.wait(s['run_id'])
        self.assertFalse(terminal['timed_out']); self.assertEqual(terminal['runs'][0]['state'],'completed')
        r=await self.result(s['run_id']); self.assertEqual(r['text'],'Completed: simple')
        self.assertEqual((await self.result(s['run_id']))['result_sha256'],r['result_sha256'])
    async def test_spawn_idempotency(self):
        p={'scope':self.scope,'request_id':'same','cwd':str(self.workspace),'task':'simple','access':'read'}
        a=await self.rt.dispatch('spawn',p); b=await self.rt.dispatch('spawn',p)
        self.assertEqual(a['agent_id'],b['agent_id']); self.assertTrue(b['replayed'])
        self.assertEqual(len(self.rt.workers),1)
        with self.assertRaises(AgentError) as cm: await self.rt.dispatch('spawn',{**p,'task':'different'})
        self.assertEqual(cm.exception.code,'idempotency_conflict')
    async def test_concurrent_duplicate_spawns(self):
        p={'scope':self.scope,'request_id':'concurrent','cwd':str(self.workspace),'task':'simple','access':'read'}
        a,b=await asyncio.gather(self.rt.dispatch('spawn',p),self.rt.dispatch('spawn',p))
        self.assertEqual(a['agent_id'],b['agent_id'])
    async def test_steering_consumed_receipt(self):
        s=await self.spawn('delay=0.4|work')
        r=await self.mutation('send',s['agent_id'],mode='steer',message='Only inspect')
        await self.wait(s['run_id'])
        receipt=self.rt.store.one('SELECT * FROM receipts WHERE id=?',(r['receipt_id'],))
        self.assertEqual(receipt['state'],'consumed')
    async def test_unconsumed_steering_is_not_success(self):
        # The turn must still be running when the steer arrives, otherwise the
        # steer is rejected (agent_idle) or lands after the fake server dropped
        # its queue and the run can never finish; a 1s window keeps the steer
        # inside the turn and the wait outcome is asserted rather than implied.
        s=await self.spawn('delay=1.0|NO_CONSUME')
        r=await self.mutation('send',s['agent_id'],mode='steer',message='Too late')
        terminal=await self.wait(s['run_id'])
        self.assertFalse(terminal['timed_out'])
        state=self.rt.store.one('SELECT state FROM receipts WHERE id=?',(r['receipt_id'],))['state']
        self.assertEqual(state,'not_consumed')
    async def test_followup_is_separate_durable_run(self):
        s=await self.spawn('delay=0.2|first')
        f=await self.mutation('send',s['agent_id'],mode='follow_up',message='second')
        self.assertEqual(f['state'],'queued'); self.assertNotEqual(f['run_id'],s['run_id'])
        await self.wait(f['run_id'])
        self.assertEqual((await self.result(s['run_id']))['text'],'Completed: first')
        self.assertEqual((await self.result(f['run_id']))['text'],'Completed: second')
    async def test_send_busy_rejected(self):
        s=await self.spawn('delay=0.5|work')
        with self.assertRaises(AgentError) as cm: await self.mutation('send',s['agent_id'],mode='send',message='bad')
        self.assertEqual(cm.exception.code,'agent_busy')
    async def test_idle_steer_does_not_spawn(self):
        s=await self.spawn(); await self.wait(s['run_id'])
        with self.assertRaises(AgentError) as cm: await self.mutation('send',s['agent_id'],mode='steer',message='bad')
        self.assertEqual(cm.exception.code,'agent_idle'); self.assertEqual(len(self.rt.workers),1)
    async def test_interrupt_cancels_followups_and_verifies_process_exit(self):
        s=await self.spawn('delay=2|work')
        f=await self.mutation('send',s['agent_id'],mode='follow_up',message='queued')
        done=await self.mutation('interrupt',s['agent_id'])
        self.assertFalse(done['process_retained']); self.assertEqual(done['cleanup'],'verified')
        self.assertEqual(self.rt.store.run(self.scope,s['run_id'])['state'],'interrupted')
        self.assertEqual(self.rt.store.run(self.scope,f['run_id'])['state'],'cancelled')
        g=await self.mutation('respawn',s['agent_id'],message='new approach')
        await self.wait(g['run_id']); self.assertIn('new approach',(await self.result(g['run_id']))['text'])
    async def test_interrupt_then_send(self):
        s=await self.spawn('delay=2|old')
        f=await self.mutation('send',s['agent_id'],message='replacement',interrupt=True)
        await self.wait(f['run_id'])
        self.assertEqual((await self.result(s['run_id']))['run']['state'],'interrupted')
        self.assertEqual((await self.result(f['run_id']))['text'],'Completed: replacement')
    async def test_wait_timeout_never_cancels(self):
        s=await self.spawn('delay=2|work')
        start=asyncio.get_running_loop().time()
        result=await self.rt.dispatch('wait',{'scope':self.scope,'run_ids':[s['run_id']],'timeout_seconds':1})
        self.assertGreaterEqual(asyncio.get_running_loop().time()-start,.9)
        self.assertTrue(result['timed_out']); self.assertEqual(result['runs'][0]['state'],'running')
        await self.wait(s['run_id'])
    async def test_cancel_wait_never_cancels(self):
        s=await self.spawn('delay=0.3|work')
        task=asyncio.create_task(self.wait(s['run_id'])); await asyncio.sleep(.02); task.cancel()
        await asyncio.gather(task,return_exceptions=True)
        self.assertEqual(self.rt.store.run(self.scope,s['run_id'])['state'],'running')
        await self.wait(s['run_id'])
    async def test_wait_any_all(self):
        a=await self.spawn('delay=0.05|A'); b=await self.spawn('delay=0.4|B')
        ids=[a['run_id'],b['run_id']]
        first=await self.rt.dispatch('wait',{'scope':self.scope,'run_ids':ids,'mode':'any','timeout_seconds':3})
        self.assertTrue(any(r['state']=='completed' for r in first['runs']))
        last=await self.rt.dispatch('wait',{'scope':self.scope,'run_ids':ids,'mode':'all','timeout_seconds':3})
        self.assertTrue(all(r['state']=='completed' for r in last['runs']))
    async def test_foreign_scope_is_rejected(self):
        s=await self.spawn()
        other=(await self.rt.dispatch('scope_open',{'cwd':str(self.workspace)}))['scope']
        with self.assertRaises(AgentError): await self.rt.dispatch('inspect',{'scope':other,'agent_id':s['agent_id']})
    async def test_scope_cwd_validation(self):
        with self.assertRaises(AgentError): await self.rt.dispatch('scope_open',{'scope':self.scope,'cwd':str(self.root)})
        with self.assertRaises(AgentError) as cm: self.rt.store.scope('scope_missing')
        self.assertEqual(cm.exception.code,'scope_not_found')
        self.assertIn(str(self.home),cm.exception.message)
        self.assertIn('--home',cm.exception.message)
    async def test_spawn_outside_scope_uses_explicit_cwd(self):
        other=self.root/'other-workspace'; other.mkdir()
        spawned=await self.spawn(cwd=str(other))
        self.assertEqual(spawned['cwd'],str(other))
    async def test_writer_conflict(self):
        await self.spawn('delay=2|writer',access='write')
        with self.assertRaises(AgentError) as cm: await self.spawn('writer2',access='write')
        self.assertEqual(cm.exception.code,'writer_conflict')
    async def test_internal_projection_does_not_consume_delivery(self):
        s=await self.spawn(); await self.wait(s['run_id']); await self.result(s['run_id'])
        listing=await self.rt.dispatch('list',{'scope':self.scope})
        self.assertEqual(listing['outstanding']['total'],1)
    async def test_result_utf8_pagination_and_hash(self):
        s=await self.spawn('BIG'); await self.wait(s['run_id'])
        cursor=0; chunks=[]
        while True:
            r=await self.result(s['run_id'],offset=cursor,max_bytes=4096); chunks.append(r['text'])
            self.assertGreater(r['next_offset'],cursor)
            cursor=r['next_offset']
            if not r['has_more']: break
        body=''.join(chunks)
        self.assertEqual(hashlib.sha256(body.encode()).hexdigest(),r['result_sha256'])
        self.assertIn('\u2028',body)
    async def test_wait_result_budget_and_pagination_preserve_exact_hash(self):
        agents=[]
        for _ in range(6):
            agent=await self.spawn('BIG'); agents.append(agent)
            await self.wait(agent['run_id'])
            await self.mutation('close',agent['agent_id'])
        page=await self.rt.dispatch('wait',{'scope':self.scope,'run_ids':[a['run_id'] for a in agents],'mode':'all','timeout_seconds':0})
        self.assertLessEqual(sum(len(r['result'].get('text','').encode()) for r in page['runs']),8192)
        for run in page['runs']:
            preview=run['result']; text=preview.get('text',''); more=preview['has_more']; offset=preview['next_offset']
            while more:
                continuation=await self.result(run['id'],offset=offset)
                text+=continuation['text']; more=continuation['has_more']; offset=continuation['next_offset']
            self.assertEqual(hashlib.sha256(text.encode()).hexdigest(),preview['result_sha256'])

    async def test_wait_and_outstanding_use_bounded_scoped_reads(self):
        store=self.rt.store
        reader=views.ReadViews(store, lambda aid: None, asyncio.Condition(), 60)
        store.execute('''INSERT INTO agents(id,scope,name,cwd,state,session_file,launch,created,updated)
                         VALUES(?,?,?,?,?,?,?,?,?)''',
                      ('read-agent',self.scope,'query-agent',str(self.workspace),'idle','session','{}',0,0))
        ids=[f'read-run-{i}' for i in range(20)]
        for i,rid in enumerate(ids):
            store.execute('INSERT INTO runs(id,agent_id,scope,state,task,created) VALUES(?,?,?,?,?,?)',
                          (rid,'read-agent',self.scope,'running','query',i))
            store.finish(rid,'completed',f'answer {i}')
        selects=[]
        store.db.set_trace_callback(lambda sql: selects.append(sql) if sql.lstrip().upper().startswith('SELECT') else None)
        try:
            listing=reader.outstanding(self.scope)
            list_reads=len(selects); selects.clear()
            waited=await reader.wait({'scope':self.scope,'run_ids':list(reversed(ids)),
                                             'mode':'all','timeout_seconds':0})
            wait_reads=len(selects)
        finally:
            store.db.set_trace_callback(None)
        self.assertLessEqual(list_reads,5)
        self.assertLessEqual(wait_reads,6)
        self.assertEqual([r['id'] for r in waited['runs']],list(reversed(ids)))
        self.assertEqual({r['name'] for r in listing['runs']},{'query-agent'})
        self.assertFalse(waited['timed_out'])

    async def test_legacy_mutation_digest_still_replays_without_spawning_again(self):
        p={'scope':self.scope,'request_id':'old-digest','cwd':str(self.workspace),'task':'simple','access':'read'}
        created=await self.rt.dispatch('spawn',p)
        legacy=hashlib.sha256(dumps({'op':'spawn','params':p}).encode()).hexdigest()
        self.rt.store.execute('UPDATE requests SET digest=? WHERE scope=? AND key=?',(legacy,self.scope,p['request_id']))
        replay=await self.rt.dispatch('spawn',p)
        self.assertTrue(replay['replayed']); self.assertEqual(replay['run_id'],created['run_id'])
        self.assertEqual(len(self.rt.workers),1)

    async def test_bounded_inspection_and_stable_cursor(self):
        s=await self.spawn('BIG'); await self.wait(s['run_id'])
        seen=[]; cursor=0
        for _ in range(50):
            r=await self.rt.dispatch('inspect',{'scope':self.scope,'agent_id':s['agent_id'],'after':cursor,'limit':2,'max_bytes':4096,'detail':'full'})
            self.assertLessEqual(len(dumps(r).encode()),4096)
            seen += [e['seq'] for e in r['events']]; cursor=r['next_cursor']
            if not r['has_more']: break
        self.assertEqual(len(seen),len(set(seen))); self.assertGreater(len(seen),2)
    async def test_close_respawn_keeps_identity_and_session(self):
        s=await self.spawn(); await self.wait(s['run_id'])
        a=self.rt.store.agent(self.scope,s['agent_id']); session=a['session_file']
        await self.mutation('close',s['agent_id'])
        revived=await self.mutation('respawn',s['agent_id'],message='continued')
        self.assertEqual(revived['generation'],2)
        self.assertEqual(self.rt.store.agent(self.scope,s['agent_id'])['session_file'],session)
        await self.wait(revived['run_id'])
        self.assertIn('continued',(await self.result(revived['run_id']))['text'])
    async def test_closed_workers_are_collected_without_losing_results_or_replay(self):
        refs=[]; completed=[]
        for i in range(8):
            params={'scope':self.scope,'request_id':self.key(),'cwd':str(self.workspace),'task':'BIG','access':'read'}
            run=await self.rt.dispatch('spawn',params)
            refs.append(weakref.ref(self.rt.workers[run['agent_id']]))
            await self.wait(run['run_id'])
            result=await self.result(run['run_id'])
            self.assertEqual((await self.mutation('close',run['agent_id']))['cleanup'],'verified')
            completed.append((params,run,result['result_sha256']))
        await self.until(lambda: not self.rt.workers,timeout=2)
        gc.collect()
        self.assertTrue(all(ref() is None for ref in refs))
        self.assertEqual(len(self.rt.agent_locks),0)
        self.assertEqual(len(self.rt.request_locks),0)
        for params,run,sha in completed:
            self.assertEqual((await self.result(run['run_id']))['result_sha256'],sha)
            replay=await self.rt.dispatch('spawn',params)
            self.assertTrue(replay['replayed']); self.assertEqual(replay['agent_id'],run['agent_id'])
        revived=await self.mutation('respawn',completed[0][1]['agent_id'],message='after retirement')
        await self.wait(revived['run_id'])
        self.assertEqual((await self.result(revived['run_id']))['text'],'Completed: after retirement')

    async def test_old_exit_cleanup_cannot_retire_a_replacement_worker(self):
        run=await self.spawn(); await self.wait(run['run_id'])
        old=self.rt.workers[run['agent_id']]
        reached=asyncio.Event(); release=asyncio.Event()
        original=self.rt.worker_exited
        async def delayed(w,code):
            if w is old:
                reached.set(); await release.wait()
            await original(w,code)
        old.on_exit=delayed
        try:
            await self.mutation('close',run['agent_id'])
            await asyncio.wait_for(reached.wait(),3)
            revived=await self.mutation('respawn',run['agent_id'],message='delay=0.3|replacement')
            new=self.rt.workers[run['agent_id']]
            exit_task=old.tasks[2]; release.set()
            await asyncio.wait_for(exit_task,3)
            await self.wait(revived['run_id'])
            self.assertIs(self.rt.workers[run['agent_id']],new)
            self.assertEqual((await self.result(revived['run_id']))['text'],'Completed: replacement')
        finally: release.set()

    async def test_lock_waiters_keep_one_identity_and_idle_locks_are_reclaimed(self):
        for locks in (self.rt.agent_locks,self.rt.request_locks):
            entered=asyncio.Event(); release=asyncio.Event(); waiting=asyncio.Event()
            second=asyncio.Event(); release_second=asyncio.Event(); order=[]
            async def first():
                async with locks['shared']:
                    entered.set(); await release.wait()
            async def cancelled():
                waiting.set()
                async with locks['shared']: self.fail('Cancelled waiter entered')
            async def next_owner():
                async with locks['shared']:
                    order.append('second'); second.set(); await release_second.wait()
            async def last():
                async with locks['shared']: order.append('last')
            a=asyncio.create_task(first()); await entered.wait()
            b=asyncio.create_task(cancelled()); await waiting.wait()
            c=asyncio.create_task(next_owner()); await asyncio.sleep(0)
            b.cancel(); await asyncio.gather(b,return_exceptions=True)
            gc.collect(); release.set(); await second.wait()
            d=asyncio.create_task(last()); await asyncio.sleep(0)
            self.assertEqual(order,['second'])
            release_second.set(); await asyncio.gather(a,c,d)
            # A retained cancelled Task owns its exception traceback (and lock).
            # The daemon releases finished tasks; mirror that ownership here.
            del a,b,c,d
            gc.collect(); self.assertEqual(order,['second','last'])
            self.assertEqual(len(locks),0)
    async def test_rpc_timeout_includes_waiting_for_the_write_lock(self):
        run=await self.spawn(); await self.wait(run['run_id'])
        w=self.rt.workers[run['agent_id']]
        async with w.write_lock:
            with self.assertRaises(AgentError) as caught:
                await asyncio.wait_for(w.rpc('get_state',timeout=.1),1)
            self.assertEqual(caught.exception.code,'rpc_timeout')
            self.assertEqual(w.pending,{})
        self.assertFalse((await w.rpc('get_state'))['isStreaming'])
    async def test_repeated_write_timeouts_do_not_accumulate_buffered_commands(self):
        run=await self.spawn('delay=30|blocked')
        w=self.rt.workers[run['agent_id']]
        transport=w.proc.stdin.transport
        high=transport.get_write_buffer_limits()[1]
        os.killpg(w.proc.pid,signal.SIGSTOP)
        async def timed_out_write():
            with self.assertRaises(AgentError) as caught:
                await w.rpc('steer',timeout=.1,message='x'*60000)
            self.assertEqual(caught.exception.code,'rpc_timeout')
            self.assertEqual(w.pending,{})
        try:
            for _ in range(6):
                await timed_out_write()
                if transport.get_write_buffer_size()>high: break
            size=transport.get_write_buffer_size()
            self.assertGreater(size,high)
            for _ in range(4):
                await timed_out_write()
                self.assertEqual(transport.get_write_buffer_size(),size)
        finally:
            try: await self.mutation('close',run['agent_id'])
            finally:
                try: os.killpg(w.proc.pid,signal.SIGCONT)
                except ProcessLookupError: pass
    async def test_interrupt_leaves_a_verified_dormant_session_for_respawn(self):
        s=await self.spawn('delay=2|work')
        r=await self.mutation('interrupt',s['agent_id'])
        self.assertFalse(r['process_retained']); self.assertEqual(r['cleanup'],'verified')
        row=self.rt.store.agent(self.scope,s['agent_id'])
        self.assertEqual((row['state'],row['cleanup']),('dormant','verified'))
        # The stop is explicit and recoverable: respawn resumes the same session.
        revived=await self.mutation('respawn',s['agent_id'],message='after stop')
        await self.wait(revived['run_id'])
        self.assertIn('after stop',(await self.result(revived['run_id']))['text'])
    async def test_send_auto_wakes_a_dormant_agent(self):
        s=await self.spawn('simple'); await self.wait(s['run_id'])
        stopped=await self.mutation('interrupt',s['agent_id'])
        self.assertEqual(stopped['cleanup'],'verified')
        sent=await self.mutation('send',s['agent_id'],mode='send',message='after park')
        await self.wait(sent['run_id'])
        self.assertEqual((await self.result(sent['run_id']))['text'],'Completed: after park')
        self.assertEqual(self.rt.store.agent(self.scope,s['agent_id'])['generation'],2)
        self.assertEqual(len(self.events(s['agent_id'],'auto_wake')),1)
    async def test_send_auto_wakes_a_closed_agent(self):
        s=await self.spawn('simple'); await self.wait(s['run_id'])
        await self.mutation('close',s['agent_id'])
        sent=await self.mutation('send',s['agent_id'],mode='send',message='after close')
        await self.wait(sent['run_id'])
        self.assertIn('after close',(await self.result(sent['run_id']))['text'])
    async def test_send_never_auto_wakes_an_unverified_stop(self):
        s=await self.spawn('simple'); await self.wait(s['run_id'])
        original=worker.terminate
        async def unknown(directory,current):
            await original(directory,current)
            return 'unknown'
        with m.patch('subagent_pi.runtime.terminate',unknown):
            stopped=await self.mutation('interrupt',s['agent_id'])
        self.assertEqual(stopped['cleanup'],'unknown')
        with self.assertRaises(AgentError) as cm:
            await self.mutation('send',s['agent_id'],mode='send',message='must not boot')
        self.assertEqual(cm.exception.code,'worker_unavailable')
        self.assertIn('cleanup is unverified',cm.exception.message)
        self.assertIn('CLI close',cm.exception.message)
        self.assertEqual(self.rt.store.agent(self.scope,s['agent_id'])['generation'],1)
    async def test_steer_still_requires_a_live_worker_and_never_wakes(self):
        s=await self.spawn('simple'); await self.wait(s['run_id'])
        await self.mutation('interrupt',s['agent_id'])
        with self.assertRaises(AgentError) as cm:
            await self.mutation('send',s['agent_id'],mode='steer',message='too late')
        self.assertEqual(cm.exception.code,'worker_unavailable')
        self.assertIn('pi_followup_task',cm.exception.message)
    async def test_prompt_handled_without_a_run_is_reported_as_a_failed_run(self):
        # A handled input still gets a failed managed completion; the next task
        # can run without an empty success or a missing completion boundary.
        self.rt.config['pi_command'].append('--handle-prompt')
        s=await self.spawn('PI_MOCK_OUTCOME first')
        await self.wait(s['run_id'])
        q=await self.mutation('send',s['agent_id'],mode='follow_up',message='second')
        await self.wait(q['run_id'])
        first=self.rt.store.run(self.scope,s['run_id']); second=self.rt.store.run(self.scope,q['run_id'])
        self.assertEqual(first['state'],'failed',
            'a handled prompt was recorded as a completed task: '+json.dumps({k:first[k] for k in ('state','error')}))
        self.assertIn('handled',first['error'] or '')
        self.assertEqual(second['state'],'completed')
        self.assertIn('second',(await self.result(q['run_id']))['text'])
        # Only the handled run is a failure: the run queued behind it still runs.
        self.assertEqual(len([e for e in self.rt.store.all('SELECT type FROM events WHERE agent_id=?',(s['agent_id'],))
                              if e['type']=='run_terminal']),2)
    async def test_unacknowledged_prompt_is_stopped_without_replay(self):
        # A lost/delayed acceptance reply leaves execution uncertain. Stop the
        # owned process; neither resend the mutation nor trust a reported idle.
        self.rt.config['pi_command'].append('--hold-prompt-ms=60000')
        self.rt.config['rpc_timeout_seconds']=1
        with self.assertRaises(AgentError) as caught:
            await self.rt.dispatch('spawn',{'scope':self.scope,'request_id':self.key(),'cwd':str(self.workspace),
                                            'task':'work','access':'read'})
        self.assertEqual(caught.exception.code,'rpc_timeout')
        aid=caught.exception.details['agent_id']; rid=caught.exception.details['run_id']
        r=await self.mutation('interrupt',aid)
        self.assertFalse(r['process_retained'],
                         'the daemon treated an idle reading as proof that the accepted prompt had stopped')
        self.assertEqual(r['cleanup'],'verified')
        row=self.rt.store.agent(self.scope,aid)
        self.assertEqual((row['state'],row['cleanup']),('dormant','verified'))
        self.assertEqual(self.rt.store.run(self.scope,rid)['state'],'interrupted')
        self.assertEqual([e['type'] for e in self.rt.store.all('SELECT type FROM events WHERE agent_id=?',(aid,))].count('run_terminal'),1)
    async def test_respawn_live_noop_returns_current_state(self):
        # Codex-style resume: an alive worker is left alone and its effective
        # state is returned; only a new message (which would replace a live
        # writer) is still refused.
        s=await self.spawn(); await self.wait(s['run_id'])
        before=self.rt.store.agent(self.scope,s['agent_id'])
        noop=await self.mutation('respawn',s['agent_id'])
        self.assertTrue(noop['already_running'])
        self.assertEqual(noop['generation'],before['generation'])
        self.assertEqual(noop['state'],'idle'); self.assertIsNone(noop['run_id'])
        self.assertEqual(len(self.rt.store.all('SELECT id FROM runs WHERE agent_id=?',(s['agent_id'],))),1)
        with self.assertRaises(AgentError) as cm:
            await self.mutation('respawn',s['agent_id'],message='replace')
        self.assertEqual(cm.exception.code,'worker_alive')
    async def test_crash_not_completed(self):
        s=await self.spawn('CRASH'); r=await self.wait(s['run_id'])
        self.assertEqual(r['runs'][0]['state'],'crashed')
    async def test_event_retention_survives_short_worker_generations(self):
        s=await self.spawn()
        self.assertFalse((await self.wait(s['run_id']))['timed_out'])
        self.rt.config['event_max_count_per_agent']=100
        agent=self.rt.store.agent(self.scope,s['agent_id'])
        for generation in range(30):
            current=self.rt.make_worker({**agent,'generation':agent['generation']+generation+1},None)
            for event in range(10): self.rt.event(current,'synthetic',{'event':event})
        count=self.rt.store.one('SELECT count(*) AS n FROM events WHERE agent_id=?',(s['agent_id'],))['n']
        self.assertLessEqual(count,109)
    async def test_close_kills_owned_descendants(self):
        s=await self.spawn('SPAWN_CHILD'); await asyncio.sleep(.15)
        pid=self.rt.workers[s['agent_id']].proc.pid
        self.assertGreaterEqual(len(group_members(pid)),2)
        r=await self.mutation('close',s['agent_id'])
        self.assertEqual(r['cleanup'],'verified'); self.assertEqual(group_members(pid),[])
    async def test_exited_guard_reconciles_even_if_descendant_keeps_pipes_open(self):
        for task in ('SPAWN_CHILD','SPAWN_DETACHED_CHILD'):
            with self.subTest(task=task):
                s=await self.spawn(task)
                aid=s['agent_id']; w=self.rt.workers[aid]; pgid=w.proc.pid
                queued=await self.mutation('send',aid,mode='follow_up',message='MUST_NOT_RUN')
                events=await self.until(lambda:self.events(aid,'tool_execution_start'))
                child=json.loads(events[0]['payload'])['args']['pid']
                owner=json.loads((self.home/'agents'/aid/'owner.json').read_text())
                os.kill(owner['pi_pid'],signal.SIGKILL)
                await self.until(lambda: self.rt.store.run(self.scope,s['run_id'])['state']=='crashed',timeout=3)
                self.assertEqual(self.rt.store.run(self.scope,queued['run_id'])['state'],'cancelled')
                self.assertEqual(self.rt.store.agent(self.scope,aid)['cleanup'],'verified')
                self.assertIsNone(process_identity(child)); self.assertEqual(group_members(pgid),[])
                await self.until(lambda: w.closed and all(t.done() for t in w.tasks),timeout=3)
                self.assertNotIn(aid,self.rt.workers)
    async def test_killed_guard_cannot_claim_verified_cleanup(self):
        s=await self.spawn('SPAWN_DETACHED_CHILD')
        aid=s['agent_id']; w=self.rt.workers[aid]
        events=await self.until(lambda:self.events(aid,'tool_execution_start'))
        child=json.loads(events[0]['payload'])['args']['pid']
        owner=json.loads((self.home/'agents'/aid/'owner.json').read_text())
        identities={pid:process_identity(pid) for pid in (owner['pi_pid'],child)}
        try:
            with self.assertRaises(AgentError) as alive:
                await self.mutation('close',aid,confirm_cleanup=owner['generation'])
            self.assertEqual(alive.exception.code,'ownership_unknown')
            os.kill(w.proc.pid,signal.SIGKILL)
            await self.until(lambda:self.rt.store.run(self.scope,s['run_id'])['state']=='crashed',timeout=4)
            self.assertEqual(self.rt.store.agent(self.scope,aid)['cleanup'],'unknown')
            self.assertIsNotNone(process_identity(child))
            with self.assertRaises(AgentError) as blocked:
                await self.mutation('respawn',aid)
            self.assertEqual(blocked.exception.code,'orphaned_worker')
        finally:
            for pid,identity in identities.items():
                if process_identity(pid)==identity: os.kill(pid,signal.SIGKILL)
            await self.until(lambda:all(process_identity(pid) is None for pid in identities))
        with self.assertRaises(AgentError) as stale:
            await self.mutation('close',aid,confirm_cleanup=owner['generation']+1)
        self.assertEqual(stale.exception.code,'ownership_unknown')
        closed=await self.mutation('close',aid,confirm_cleanup=owner['generation'])
        self.assertEqual((closed['state'],closed['cleanup']),('closed','verified'))
        confirmed=json.loads((self.home/'agents'/aid/'owner.json').read_text())
        self.assertEqual(confirmed['cleanup_confirmation']['by'],'operator')
        revived=await self.mutation('respawn',aid)
        self.assertEqual(revived['generation'],owner['generation']+1)
    async def test_needs_input_and_explicit_answer(self):
        s=await self.spawn('UI_CONFIRM'); r=await self.wait(s['run_id'])
        self.assertEqual(r['runs'][0]['state'],'needs_input')
        with self.assertRaises(AgentError) as missing:
            await self.mutation('answer',s['agent_id'],ui_request_id='expired',answer=False)
        self.assertEqual(missing.exception.code,'input_not_found')
        await self.mutation('answer',s['agent_id'],ui_request_id='ui-1',answer=False)
        await self.wait(s['run_id']); self.assertIn('False',(await self.result(s['run_id']))['text'])
        generation=self.rt.store.agent(self.scope,s['agent_id'])['generation']
        for parked in (False,True):
            if parked: await self.mutation('interrupt',s['agent_id'])
            with self.assertRaises(AgentError) as expired:
                await self.mutation('answer',s['agent_id'],ui_request_id='ui-1',answer=False)
            self.assertEqual(expired.exception.code,'input_not_found')
            self.assertEqual(self.rt.store.agent(self.scope,s['agent_id'])['generation'],generation)
    async def test_select_answers_keep_original_option_identity(self):
        s=await self.spawn('UI_CONFIRM'); await self.wait(s['run_id'])
        w=self.rt.workers[s['agent_id']]
        long_option='a'*245
        options=[long_option,*[f'option-{i}' for i in range(1,13)]]
        self.rt.on_event(w,{'type':'extension_ui_request','id':'select-1',
                            'method':'select','options':options,'title':'Choose'})
        self.assertEqual(w.ui['select-1']['options'],options)
        with self.assertRaises(AgentError):
            await self.mutation('answer',s['agent_id'],ui_request_id='select-1',answer=long_option[:170])
        with m.patch.object(w,'raw',new_callable=m.AsyncMock) as send:
            await self.mutation('answer',s['agent_id'],ui_request_id='select-1',answer=options[-1])
            self.assertEqual(send.await_args.args[0]['value'],options[-1])
        self.rt.on_event(w,{'type':'extension_ui_request','id':'select-2',
                            'method':'select','options':options,'title':'Choose'})
        with m.patch.object(w,'raw',new_callable=m.AsyncMock) as send:
            await self.mutation('answer',s['agent_id'],ui_request_id='select-2',answer=long_option)
            self.assertEqual(send.await_args.args[0]['value'],long_option)
    async def test_model_silence_times_out_and_cancels_queued_work(self):
        loop=asyncio.create_task(self.rt.idle_loop())
        try:
            s=await self.spawn('model=silent|delay=5|work',idle_timeout_seconds=1)
            queued=await self.mutation('send',s['agent_id'],mode='follow_up',message='must not execute')
            pid=self.rt.workers[s['agent_id']].proc.pid
            r=await self.wait(s['run_id']); self.assertEqual(r['runs'][0]['state'],'timed_out')
            self.assertIn('No model output or thinking progress',(await self.result(s['run_id']))['run']['error'])
            self.assertEqual(self.rt.store.run(self.scope,queued['run_id'])['state'],'cancelled')
            self.assertEqual(group_members(pid),[])
        finally: loop.cancel(); await asyncio.gather(loop,return_exceptions=True)

    async def test_streaming_progress_has_no_total_deadline(self):
        loop=asyncio.create_task(self.rt.idle_loop())
        try:
            for kind in ('text','thinking','toolcall'):
                with self.subTest(kind=kind):
                    s=await self.spawn(f'model={kind}|delay=2.2|work',idle_timeout_seconds=1)
                    done=await self.wait(s['run_id'])
                    self.assertEqual(done['runs'][0]['state'],'completed',done)
                    self.assertEqual(self.events(s['agent_id'],'message_update'),[])
                    await self.mutation('close',s['agent_id'])
        finally: loop.cancel(); await asyncio.gather(loop,return_exceptions=True)

    async def test_notifications_do_not_hide_a_stalled_model(self):
        loop=asyncio.create_task(self.rt.idle_loop())
        try:
            s=await self.spawn('model=noise|delay=5|work',idle_timeout_seconds=1)
            self.assertEqual((await self.wait(s['run_id']))['runs'][0]['state'],'timed_out')
        finally: loop.cancel(); await asyncio.gather(loop,return_exceptions=True)

    async def test_silent_parallel_tools_are_not_model_silence(self):
        loop=asyncio.create_task(self.rt.idle_loop())
        try:
            s=await self.spawn('parallel=1|delay=3|work',idle_timeout_seconds=1)
            done=await self.wait(s['run_id'])
            self.assertEqual(done['runs'][0]['state'],'completed',done)
            self.assertEqual(self.rt.workers[s['agent_id']].active_tools,{})
        finally: loop.cancel(); await asyncio.gather(loop,return_exceptions=True)

    async def test_tool_exit_restarts_silence_budget(self):
        s=await self.spawn('delay=1|after_tool=120|work',idle_timeout_seconds=1)
        w=self.rt.workers[s['agent_id']]
        await self.until(lambda:w.active_tools)
        w.last_progress-=3600
        await self.rt.check_idle()
        self.assertEqual(self.rt.store.run(self.scope,s['run_id'])['state'],'running')
        await self.until(lambda:not w.active_tools)
        await self.rt.check_idle()
        self.assertEqual(self.rt.store.run(self.scope,s['run_id'])['state'],'running')
        w.last_progress-=2
        await self.rt.check_idle()
        self.assertEqual(self.rt.store.run(self.scope,s['run_id'])['state'],'timed_out')

    async def test_parent_wait_pauses_until_answer_or_ui_close(self):
        for answered in (True,False):
            with self.subTest(answered=answered):
                s=await self.spawn('UI_CONFIRM',idle_timeout_seconds=1)
                self.assertEqual((await self.wait(s['run_id']))['runs'][0]['state'],'needs_input')
                w=self.rt.workers[s['agent_id']]
                w.last_progress-=3600
                await self.rt.check_idle()
                self.assertEqual(self.rt.store.run(self.scope,s['run_id'])['state'],'needs_input')
                if answered:
                    await self.mutation('answer',s['agent_id'],ui_request_id='ui-1',answer=True)
                    self.assertEqual((await self.wait(s['run_id']))['runs'][0]['state'],'completed')
                else:
                    self.rt.on_event(w,{'type':'extension_ui_closed','id':'ui-1'})
                    await self.rt.check_idle()
                    self.assertEqual(self.rt.store.run(self.scope,s['run_id'])['state'],'running')
                    w.last_progress-=2
                    await self.rt.check_idle()
                    self.assertEqual(self.rt.store.run(self.scope,s['run_id'])['state'],'timed_out')
                await self.mutation('close',s['agent_id'])

    async def test_idle_observation_rechecked_after_control_lock(self):
        s=await self.spawn('model=silent|delay=120|work',idle_timeout_seconds=1)
        w=self.rt.workers[s['agent_id']]
        lock=self.rt.agent_locks[s['agent_id']]
        async with lock:
            w.last_progress-=2
            checking=asyncio.create_task(self.rt.check_idle())
            await asyncio.sleep(0)
            self.rt.on_event(w,{'type':'message_update','assistantMessageEvent':{'type':'thinking_delta','delta':'new'}})
        await checking
        self.assertEqual(self.rt.store.run(self.scope,s['run_id'])['state'],'running')

    async def test_retry_backoff_is_not_silence_and_empty_delta_is_not_progress(self):
        s=await self.spawn('model=silent|delay=120|work',idle_timeout_seconds=1)
        w=self.rt.workers[s['agent_id']]
        self.rt.on_event(w,{'type':'auto_retry_start','delayMs':5000})
        w.last_progress-=2
        await self.rt.check_idle()
        self.assertEqual(self.rt.store.run(self.scope,s['run_id'])['state'],'running')
        self.rt.on_event(w,{'type':'auto_retry_end'})
        w.last_progress-=2
        self.rt.on_event(w,{'type':'message_update','assistantMessageEvent':{'type':'thinking_delta','delta':''}})
        await self.rt.check_idle()
        self.assertEqual(self.rt.store.run(self.scope,s['run_id'])['state'],'timed_out')

    async def test_v4_ledger_keeps_results_and_does_not_reuse_old_deadlines(self):
        s=await self.spawn('persisted result'); await self.wait(s['run_id'])
        before=await self.result(s['run_id'])
        await self.mutation('close',s['agent_id'])
        await self.rt.shutdown()
        import sqlite3
        with sqlite3.connect(self.home/'registry.sqlite') as db:
            db.execute('ALTER TABLE runs DROP COLUMN idle_timeout_seconds')
            db.execute("UPDATE meta SET value='4' WHERE key='schema'")
            db.execute('UPDATE runs SET deadline=1')
        self.rt=Runtime(self.home)
        after=await self.result(s['run_id'])
        self.assertEqual((after['text'],after['result_sha256']),(before['text'],before['result_sha256']))
        row=self.rt.store.run(self.scope,s['run_id'])
        self.assertEqual(row['deadline'],1)  # history retained, not reused
        self.assertIsNone(row['idle_timeout_seconds'])
        await self.mutation('respawn',s['agent_id'])
        queued=await self.mutation('send',s['agent_id'],mode='follow_up',message='new work')
        self.assertEqual((await self.wait(queued['run_id']))['runs'][0]['state'],'completed')
        self.assertEqual(self.rt.store.run(self.scope,queued['run_id'])['idle_timeout_seconds'],1800)
    async def test_missing_pi_reports_startup_failure(self):
        self.rt.config['pi_command']=['/definitely/missing/pi']
        with self.assertRaises(AgentError) as cm: await self.spawn()
        self.assertEqual(cm.exception.code,'pi_not_found')
    async def test_failed_worker_registration_only_stops_its_verified_guard(self):
        with m.patch.object(self.rt,'make_worker',side_effect=RuntimeError('registration refused')):
            with self.assertRaisesRegex(RuntimeError,'registration refused'):
                await self.spawn()
        agent=self.rt.store.one('SELECT * FROM agents WHERE scope=?',(self.scope,))
        self.assertEqual(agent['cleanup'],'verified')
        self.assertFalse(group_members(agent['pid']))
        self.assertNotIn(agent['id'],self.rt.workers)
    async def test_unverified_boot_process_group_is_never_signalled(self):
        with m.patch('subagent_pi.worker.live_identity',return_value=None), \
             m.patch('subagent_pi.worker.ownership',return_value={'status':'unknown'}), \
             m.patch('subagent_pi.worker.group_members',return_value=[123]), \
             m.patch('subagent_pi.worker.stop_group') as stop:
            self.assertEqual(await worker.stop_owned_process(self.home,{'identity':'old'},m.Mock(pid=123)),
                             ('unknown',False))
            stop.assert_not_called()
    async def test_schema_validation(self):
        with self.assertRaises(AgentError): validate_op('spawn',{'scope':self.scope,'task':'x'})
        with self.assertRaises(AgentError): validate_op('list',{'scope':self.scope,'limit':True})
        with self.assertRaises(AgentError): validate_op('list',{'scope':self.scope,'unexpected':1})
        self.assertEqual(len({t['name'] for t in TOOLS}),len(TOOLS))

    async def test_respawn_cannot_bypass_new_writer(self):
        a=await self.spawn('first',access='write'); await self.wait(a['run_id'])
        await self.mutation('close',a['agent_id'])
        b=await self.spawn('delay=1|second',access='write')
        with self.assertRaises(AgentError) as cm: await self.mutation('respawn',a['agent_id'])
        self.assertEqual(cm.exception.code,'writer_conflict')
    async def test_relative_scope_cwd_rejected(self):
        with self.assertRaises(AgentError): await self.rt.dispatch('scope_open',{'cwd':'.'})
    async def test_mid_codepoint_result_offset_rejected(self):
        a=await self.spawn('BIG'); await self.wait(a['run_id'])
        with self.assertRaises(AgentError) as cm: await self.result(a['run_id'],offset=1)
        self.assertEqual(cm.exception.code,'invalid_offset')
    async def test_inspection_strict_small_budget(self):
        a=await self.spawn('BIG'); await self.wait(a['run_id'])
        r=await self.rt.dispatch('inspect',{'scope':self.scope,'agent_id':a['agent_id'],'max_bytes':1024,'detail':'full'})
        self.assertLessEqual(len(dumps(r).encode()),1024)
        # Stored diagnostics can be much larger than the requested event page.
        self.rt.store.execute('UPDATE runs SET usage=? WHERE id=?',(dumps({'large':'x'*20000}),a['run_id']))
        r=await self.rt.dispatch('inspect',{'scope':self.scope,'agent_id':a['agent_id'],'max_bytes':1024,'detail':'full'})
        self.assertLessEqual(len(dumps(r).encode()),1024)
        self.assertTrue(r['diagnostics_truncated'])
        self.assertEqual(r['run']['id'],a['run_id'])
    async def test_pending_request_never_blindly_reexecutes(self):
        params={'scope':self.scope,'request_id':'uncertain','cwd':str(self.workspace),'task':'simple','access':'read'}
        self.rt.store.request_begin(self.scope,'uncertain','spawn',params)
        with self.assertRaises(AgentError) as cm: await self.rt.dispatch('spawn',params)
        self.assertEqual(cm.exception.code,'request_uncertain')


class ReceiptFdOwnership(unittest.IsolatedAsyncioTestCase):
    """P1 (0.2.2): the receipt read end must have exactly ONE closer.

    When the receipt reports a failed required server, read_receipt raises
    after its transport already closed the fd. The old caller kept its own
    reference across `await terminate(rt, w)` and closed the same number
    again in `finally` — by then the freed number could belong to another
    connection (another agent's RPC pipe, a CLI/MCP IPC socket), and
    suppress(OSError) does not protect a reused-but-valid fd.
    """

    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='subagent-pi-fd-')
        self.root=Path(self.tmp.name); self.home=self.root/'state'; self.home.mkdir()
        self.workspace=self.root/'workspace'; self.workspace.mkdir()
        codex=make_codex_home(self.root/'src',config=RECEIPT_TOML)
        (codex/'servers'/'dir with space').mkdir(parents=True)
        (self.home/'config.toml').write_text(
            'pi_command = '+json.dumps([sys.executable,str(TEST_ROOT/'fake_pi.py')])+
            '\nrpc_timeout_seconds = 8\nstartup_timeout_seconds = 10\n\n[inheritance]\nenabled = true\n'
            'child_env = ["PI_TEST_RECEIPT_STATUS"]\n')
        self.rt=Runtime(self.home)
        opened=await self.rt.dispatch('scope_open',{'cwd':str(self.workspace)},
            {'env':{'PATH':os.environ.get('PATH',''),'CODEX_HOME':str(codex),'PI_TEST_RECEIPT_STATUS':'failed_required'}})
        self.scope=opened['scope']
        self.pipes=[]
        self._real_pipe=os.pipe

    async def asyncTearDown(self):
        for pair in getattr(self,'spares',[])+([self.pair] if getattr(self,'pair',None) else []):
            for s in pair:
                # Close only if the number still refers to the socket we created;
                # after a red double-close the number may have been freed again.
                try:
                    st=os.fstat(s.fileno())
                    if statmod.S_ISSOCK(st.st_mode): s.close()
                except OSError: pass
        await self.rt.shutdown()
        self.tmp.cleanup()

    def recording_pipe(self):
        r=self._real_pipe(); self.pipes.append(r); return r

    async def test_boot_failure_does_not_close_reused_receipt_fd(self):
        # Spy on os.pipe: boot_worker creates bootstrap pipe then receipt pipe,
        # synchronously and before any await, so the second recorded pipe is
        # the receipt channel.
        with m.patch('os.pipe',self.recording_pipe):
            real_terminate=worker.terminate
            async def parked_terminate(directory,w):
                target=self.pipes[1][0]  # receipt read end
                # Ordering evidence: read_receipt's transport already closed it.
                for _ in range(200):
                    try: os.fstat(target); await asyncio.sleep(0.01)
                    except OSError: break
                else: self.fail('receipt fd still open when terminate started')
                # Re-occupy the freed number with a live connection. No awaits
                # inside this loop, so the event loop cannot steal the number.
                self.spares=[]; self.pair=None
                for _ in range(128):
                    a,b=socket.socketpair()
                    if a.fileno()==target: self.pair=(a,b); break
                    if b.fileno()==target: self.pair=(b,a); break
                    self.spares.append((a,b))
                self.assertIsNotNone(self.pair,'could not reoccupy receipt fd %d'%target)
                return await real_terminate(directory,w)
            with m.patch('subagent_pi.runtime.terminate',parked_terminate):
                with self.assertRaises(AgentError) as cm:
                    await self.rt.dispatch('spawn',{'scope':self.scope,'request_id':'fd-reuse','cwd':str(self.workspace),'task':'simple','access':'read'})
        self.assertEqual(cm.exception.code,'inheritance_required_server_failed')
        # The socket that reclaimed the receipt fd number during the cleanup
        # window must be untouched by the failure path.
        holder,peer=self.pair
        target=holder.fileno()
        self.assertEqual(target,self.pipes[1][0])
        os.write(target,b'ping')  # raises OSError (EBADF) on the old double-close
        self.assertEqual(peer.recv(4),b'ping')

    async def test_read_receipt_closes_fd_on_timeout(self):
        r,w=os.pipe()
        try:
            with self.assertRaises(AgentError) as cm:
                await read_receipt(r,'a',1,0.05)
            self.assertEqual(cm.exception.code,'bridge_unavailable')
            for _ in range(10): await asyncio.sleep(0)  # transport close is loop-scheduled
            with self.assertRaises(OSError): os.fstat(r)  # closed exactly once
        finally: os.close(w)

    async def test_read_receipt_closes_fd_on_cancellation(self):
        r,w=os.pipe()
        try:
            t=asyncio.create_task(read_receipt(r,'a',1,5))
            await asyncio.sleep(0.05); t.cancel()
            with self.assertRaises(asyncio.CancelledError): await t
            for _ in range(10): await asyncio.sleep(0)
            with self.assertRaises(OSError): os.fstat(r)
        finally: os.close(w)

    async def test_read_receipt_closes_fd_when_transport_creation_fails(self):
        r,w=os.pipe()
        try:
            loop=asyncio.get_running_loop()
            with m.patch.object(loop,'connect_read_pipe',side_effect=OSError('transport refused')):
                with self.assertRaises(OSError):
                    await read_receipt(r,'a',1,1)
            with self.assertRaises(OSError): os.fstat(r)
        finally: os.close(w)

def seed_owner_row(owner=None, *, pid=None, identity=None, state='running', cleanup='pending'):
    """Seed one old worker ledger row and its optional guard owner record."""
    tmp=tempfile.TemporaryDirectory(prefix='restart-owner-')
    home=Path(tmp.name)/'state'; home.mkdir()
    ws=Path(tmp.name)/'ws'; ws.mkdir()
    (home/'config.toml').write_text('[inheritance]\nenabled = false\n')
    directory=home/'agents'/'pi_seed'; (directory/'sessions').mkdir(parents=True)
    (directory/'session.jsonl').write_text('{}\n')
    if owner is not None: (directory/'owner.json').write_text(json.dumps(owner))
    store=Store(home)
    store.execute('INSERT INTO scopes(id,cwd,label,created) VALUES(?,?,?,?)',('s1',str(ws),'t',1.0))
    store.execute('INSERT INTO agents(id,scope,name,cwd,state,session_file,launch,created,updated,pid,identity,cleanup) '
                  'VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        ('pi_seed','s1','pi_seed',str(ws),state,str(directory/'session.jsonl'),
         json.dumps({'argv':['x'],'cwd':str(ws),'access':'read'}),1.0,1.0,pid,identity,cleanup))
    store.close()
    return tmp, home

class RestartOwnershipVerdict(unittest.TestCase):
    """A ledger row whose owner record never landed must not be reported as a
    verified cleanup while a live process may still hold the session."""
    def test_live_pid_without_owner_record_is_orphaned_not_verified(self):
        alive=subprocess.Popen(['sleep','60'])
        try:
            tmp,home=seed_owner_row(pid=alive.pid,identity=process_identity(alive.pid))
            rt=Runtime(home)
            row=rt.store.one('SELECT * FROM agents WHERE id=?',('pi_seed',))
            self.assertNotEqual(row['cleanup'],'verified',
                'a live, unverifiable process was reported as a verified cleanup')
            self.assertEqual(row['state'],'orphaned')
        finally:
            alive.kill(); alive.wait(); tmp.cleanup()

    def test_dead_pid_without_owner_record_may_be_verified(self):
        tmp,home=seed_owner_row(pid=999999,identity='boot:gone')
        rt=Runtime(home)
        row=rt.store.one('SELECT * FROM agents WHERE id=?',('pi_seed',))
        self.assertEqual(row['cleanup'],'verified')
        tmp.cleanup()

    def test_unreadable_owner_record_is_never_verified(self):
        tmp,home=seed_owner_row(pid=999999,identity='boot:gone')
        (home/'agents'/'pi_seed'/'owner.json').write_text('{not json')
        rt=Runtime(home)
        row=rt.store.one('SELECT * FROM agents WHERE id=?',('pi_seed',))
        self.assertEqual(row['cleanup'],'unknown')
        tmp.cleanup()

    def test_never_launched_row_is_verified_not_a_phantom_orphan(self):
        # cleanup='verified' means no child was ever marked pending: there is no
        # owner record to expect, so the row must not stay unresolvable forever.
        tmp,home=seed_owner_row(pid=None,identity=None)
        store=Store(home); store.agent_update('pi_seed',cleanup='verified'); store.close()
        rt=Runtime(home)
        row=rt.store.one('SELECT * FROM agents WHERE id=?',('pi_seed',))
        self.assertEqual((row['state'],row['cleanup']),('dormant','verified'))
        tmp.cleanup()

    def test_pending_launch_without_owner_record_stays_unknown(self):
        # cleanup='pending' is set before the fork, so a missing record cannot
        # prove the child never started.
        tmp,home=seed_owner_row(pid=None,identity=None)
        store=Store(home); store.agent_update('pi_seed',cleanup='pending'); store.close()
        rt=Runtime(home)
        row=rt.store.one('SELECT * FROM agents WHERE id=?',('pi_seed',))
        self.assertEqual((row['state'],row['cleanup']),('orphaned','unknown'))
        tmp.cleanup()

class ReconcileAndReapAgree(unittest.TestCase):
    """Crash reconciliation and orphan reaping must reach the same verdict on the
    same owner record: a divergence would let `close` reap a session the restart
    path called unknown, or leave a row unresolvable after a clean shutdown."""
    def test_both_paths_refuse_an_unverifiable_owner(self):
        tmp,home=seed_owner_row({'guard_pid':4081,'guard_identity':'boot:stale','spawning':True})
        rt=Runtime(home)
        row=rt.store.one('SELECT * FROM agents WHERE id=?',('pi_seed',))
        self.assertEqual(row['cleanup'],'unknown')
        with self.assertRaises(AgentError) as cm:
            asyncio.run(worker.reap_orphan(home/'agents'/'pi_seed',rt.store.one('SELECT * FROM agents WHERE id=?',('pi_seed',))))
        self.assertEqual(cm.exception.code,'ownership_unknown')
        tmp.cleanup()

    def test_both_paths_clear_a_verified_gone_owner(self):
        tmp,home=seed_owner_row({'guard_pid':999999,'guard_identity':'boot:gone',
                            'pi_pid':999998,'pi_identity':'boot:gone','spawning':False})
        rt=Runtime(home)
        row=rt.store.one('SELECT * FROM agents WHERE id=?',('pi_seed',))
        self.assertEqual((row['state'],row['cleanup']),('dormant','verified'))
        verdict=asyncio.run(worker.reap_orphan(home/'agents'/'pi_seed',rt.store.one('SELECT * FROM agents WHERE id=?',('pi_seed',))))
        self.assertEqual(verdict,'verified')
        tmp.cleanup()

if __name__=='__main__': unittest.main()
