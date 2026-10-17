from __future__ import annotations
import asyncio
import hashlib
from pathlib import Path
import json
import time
import unittest
from runtime_harness import RuntimeHarness
from test_transport import IpcHarness
from metis_subagent.common import AgentError
from metis_subagent.schema import BY_NAME
from schema_oracle import validate_contract
from jsonschema.exceptions import ValidationError

class V2RuntimeTests(RuntimeHarness, unittest.IsolatedAsyncioTestCase):
    async def test_indexed_read_paths(self):
        a = await self.spawn()
        await self.wait(a['run_id'])
        self.assertNotIn('revision', (await self.rt.dispatch('scope_list', {}))['scopes'][0])
        queries = [
            ("SELECT id FROM receipts WHERE agent_id=? AND state IN ('sending','queued')", a['agent_id']),
            ('SELECT id FROM receipts WHERE agent_id=? ORDER BY created DESC LIMIT 5', a['agent_id']),
            ("SELECT state FROM runs WHERE agent_id=? AND state!='queued' ORDER BY created DESC LIMIT 1", a['agent_id']),
            ('SELECT run_id FROM parent_notifications WHERE scope=? ORDER BY created DESC LIMIT 6', self.scope),
        ]
        for query, target in queries:
            with self.subTest(query=query):
                plan = self.rt.store.all('EXPLAIN QUERY PLAN '+query, (target,))
                self.assertTrue(all('SEARCH ' in row['detail'] for row in plan), plan)
                self.assertFalse(any('TEMP B-TREE' in row['detail'] for row in plan), plan)


    async def test_rejected_idle_start_restores_expiry(self):
        with self.assertRaises(AgentError) as caught:
            await self.spawn('REJECT_START')
        aid = caught.exception.details['agent_id']
        rid = caught.exception.details['run_id']
        w = self.rt.workers[aid]
        self.assertEqual((await self.result(rid))['run']['state'], 'failed')
        self.assertIsNotNone(w.idle_since)
        w.idle_since = time.monotonic() - 1801
        await self.rt.park_expired()
        self.assertEqual(self.rt.store.agent(self.scope, aid)['state'], 'dormant')


    async def test_soft_interrupt_retains_worker_and_reuses_session(self):
        a=await self.spawn('delay=1|first',name='worker')
        w=self.rt.workers[a['agent_id']]; pid=w.proc.pid; generation=w.generation
        interrupted=await self.mutation('soft_interrupt','worker')
        self.assertTrue(interrupted['runtime_retained']); self.assertEqual(interrupted['previous_status'],'running')
        self.assertEqual((await self.result(a['run_id']))['run']['state'],'interrupted')
        b=await self.mutation('followup','worker',message='replacement')
        await self.wait(b['run_id'])
        self.assertNotEqual(a['run_id'],b['run_id']); self.assertEqual((w.proc.pid,w.generation),(pid,generation))
        self.assertEqual((await self.result(b['run_id']))['text'],'Completed: replacement')


    async def test_abort_rejection_falls_back_to_verified_termination(self):
        self.command.append('--reject-abort')
        a=await self.spawn('delay=1|first')
        stopped=await self.mutation('soft_interrupt',a['agent_id'])
        self.assertFalse(stopped['runtime_retained']); self.assertTrue(stopped['forced'])
        self.assertEqual(self.rt.store.agent(self.scope,a['agent_id'])['cleanup'],'verified')
        self.assertEqual((await self.result(a['run_id']))['run']['state'],'interrupted')


    async def test_question_interrupt_retains_worker_and_rejects_old_answer(self):
        a=await self.spawn('UI_CONFIRM')
        await self.until(lambda: self.rt.workers[a['agent_id']].run.ui)
        stopped=await self.mutation('soft_interrupt',a['agent_id'])
        self.assertTrue(stopped['runtime_retained'])
        with self.assertRaises(AgentError):
            await self.mutation('answer',a['agent_id'],ui_request_id='ui-1',answer=True)
        self.assertFalse(self.rt.workers[a['agent_id']].run.ui)


    async def test_native_followup_joins_current_run(self):
        a=await self.spawn('delay=1|first')
        b=await self.mutation('followup',a['agent_id'],message='native message')
        self.assertEqual(a['run_id'],b['run_id'])
        await self.wait(a['run_id'])
        messages=[json.loads(e['payload']) for e in self.events(a['agent_id'],'message')]
        self.assertTrue(any(e['role']=='user' and e['text']=='native message' for e in messages))
        self.assertEqual(self.rt.store.one('SELECT COUNT(*) n FROM runs')['n'],1)


    async def test_idle_message_is_durable_without_a_model_turn(self):
        a=await self.spawn(); await self.wait(a['run_id'])
        sent=await self.mutation('message',a['agent_id'],message='remember this')
        self.assertEqual((sent['delivery'],sent['run_id']),('stored',None))
        self.assertEqual(self.rt.store.one('SELECT COUNT(*) n FROM runs')['n'],1)
        path=self.rt.store.agent(self.scope,a['agent_id'])['session_file']
        self.assertIn('remember this',Path(path).read_text())
        w=self.rt.workers[a['agent_id']]; w.idle_since=time.monotonic()-1801
        await self.rt.park_expired()
        b=await self.mutation('followup',a['agent_id'],message='next')
        await self.wait(b['run_id'])
        self.assertIn('remember this',Path(path).read_text())


    async def test_idle_timer_ignores_telemetry_and_preserves_result(self):
        a=await self.spawn(); await self.wait(a['run_id'])
        w=self.rt.workers[a['agent_id']]; stamp=time.monotonic()-1801; w.idle_since=stamp
        self.rt.on_event(w,{'type':'extension_ui_request','method':'notify','message':'telemetry'})
        await self.rt.dispatch('inspect',{'scope':self.scope,'agent_id':a['agent_id']})
        self.assertEqual(w.idle_since,stamp)
        await self.rt.park_expired()
        self.assertEqual(self.rt.store.agent(self.scope,a['agent_id'])['state'],'dormant')
        self.assertEqual((await self.result(a['run_id']))['text'],'Completed: simple')
        listing=await self.rt.dispatch('list',{'scope':self.scope})
        self.assertEqual(listing['agents'][0]['agent_status'],'completed')


    async def test_idle_timer_excludes_active_task_and_question(self):
        a=await self.spawn('UI_CONFIRM')
        await self.until(lambda: self.rt.workers[a['agent_id']].run.ui)
        w=self.rt.workers[a['agent_id']]; w.idle_since=time.monotonic()-1801
        await self.rt.park_expired()
        self.assertFalse(w.closed); self.assertTrue(w.run.ui)


    async def test_expiry_rechecks_idle_epoch_after_waiting_for_lock(self):
        a=await self.spawn(); await self.wait(a['run_id'])
        w=self.rt.workers[a['agent_id']]; w.idle_since=time.monotonic()-1801
        lock=self.rt.agent_locks[a['agent_id']]; await lock.acquire()
        t=asyncio.create_task(self.rt.park_expired()); await asyncio.sleep(0)
        w.idle_since=time.monotonic(); lock.release(); await t
        self.assertFalse(w.closed)


    async def test_idle_writer_is_parked_for_replacement_but_busy_writer_rejects(self):
        a=await self.spawn(access='write'); await self.wait(a['run_id'])
        b=await self.spawn('delay=1|new writer',access='write')
        self.assertEqual(self.rt.store.agent(self.scope,a['agent_id'])['cleanup'],'verified')
        with self.assertRaises(AgentError) as err: await self.spawn(access='write')
        self.assertEqual(err.exception.code,'writer_conflict')
        await self.wait(b['run_id'])


    async def test_target_collision_rejects_public_reference_without_breaking_internal_lookup(self):
        a=await self.spawn(name='original'); await self.wait(a['run_id'])
        b=await self.spawn(name=a['agent_id']); await self.wait(b['run_id'])
        with self.assertRaises(AgentError) as err:
            await self.mutation('followup',a['agent_id'],message='ambiguous')
        self.assertEqual(err.exception.code,'ambiguous_agent')
        self.assertEqual(self.rt.store.agent(self.scope,a['agent_id'])['id'],a['agent_id'])


    async def test_interrupt_unloaded_agent_does_not_boot(self):
        a=await self.spawn(); await self.wait(a['run_id'])
        await self.mutation('close',a['agent_id'])
        generation=self.rt.store.agent(self.scope,a['agent_id'])['generation']
        stopped=await self.mutation('soft_interrupt',a['agent_id'])
        self.assertFalse(stopped['runtime_retained']); self.assertEqual(stopped['previous_status'],'completed')
        self.assertEqual(self.rt.store.agent(self.scope,a['agent_id'])['generation'],generation)



class V2TransportTests(IpcHarness, unittest.IsolatedAsyncioTestCase):
    async def test_identifier_and_text_guards_match_tool_contract(self):
        await self.initialize()
        schema=BY_NAME['pi_spawn_agent']['inputSchema']
        for key in ['检查-1','trailing\n']:
            args={'cwd':str(self.workspace),'task':'first','access':'read','request_id':key}
            with self.assertRaises(ValidationError):
                validate_contract(args,schema)
            with self.assertRaises(AgentError) as caught:
                await self.call('spawn',args)
            self.assertEqual(caught.exception.code,'invalid_argument')
        self.assertEqual(schema['properties']['task']['x-maxBytes'],65536)
        with self.assertRaises(AgentError) as caught:
            await self.call('spawn',{'task':'你'*22000,'access':'read','request_id':'bytes'})
        self.assertEqual(caught.exception.code,'invalid_argument')
        self.assertEqual((await self.call('list',{}))['total'],0)

    async def test_compact_read_contract_preserves_paging_delivery_and_diagnostics(self):
        await self.initialize()
        async def checked(name,args):
            definition=BY_NAME[name]
            value=await self.call(definition['_op'],args)
            validate_contract(value,definition['outputSchema'])
            return value
        args={'cwd':str(self.workspace),'task':'BIG','name':'results','access':'read','request_id':'big'}
        a=await checked('pi_spawn_agent',args)
        retried=await checked('pi_spawn_agent',args)
        self.assertEqual(retried['run_id'],a['run_id']); self.assertTrue(retried['replayed'])
        done=await checked('pi_wait_agent',{'run_ids':[a['run_id']],'timeout_seconds':8})
        summary=done['runs'][0]
        self.assertEqual(summary['state'],'completed')
        self.assertNotIn('result_sha',summary); self.assertNotIn('error',summary)
        preview=summary['result']; self.assertTrue(preview['has_more'])
        page=await checked('pi_agent_result',{'run_id':a['run_id'],'offset':preview['next_offset'],'max_bytes':16384})
        self.assertNotIn('offset',page)
        self.assertNotIn('usage',page); self.assertNotIn('artifact_path',page)
        self.assertNotIn('created',page['run'])
        contents=preview['text']+page['text']
        while page['has_more']:
            page=await checked('pi_agent_result',{'run_id':a['run_id'],'offset':page['next_offset'],'max_bytes':16384})
            contents+=page['text']
        self.assertEqual(hashlib.sha256(contents.encode()).hexdigest(),page['result_sha256'])
        self.assertEqual(preview['result_sha256'],page['result_sha256'])
        listing=await checked('pi_list_agents',{})
        self.assertEqual(listing['parent_notifications'],{'enabled':True,'transport':'pi_native'})
        self.assertNotIn('resolved_model',listing['agents'][0]); self.assertNotIn('thinking',listing['agents'][0])
        self.assertEqual(listing['outstanding']['total'],0)
        found=await checked('pi_list_agents',{'query':'RESULT','sort':'created','limit':1,'offset':0})
        self.assertEqual(found['agents'][0]['id'],a['agent_id'])
        self.assertEqual((found['total'],found['matched'],found['next_offset'],found['has_more']),(1,1,1,False))
        normal=await checked('pi_inspect_agent',{'agent_id':'results','max_bytes':16384})
        self.assertNotIn('parent_notifications',normal)
        self.assertEqual(normal['agent']['resolved_model'],a['resolved_model'])
        self.assertEqual(normal['agent'].get('thinking'),a.get('thinking'))
        full=await checked('pi_inspect_agent',{'agent_id':'results','detail':'full','max_bytes':16384})
        self.assertEqual(full['run']['id'],a['run_id']); self.assertEqual(full['run']['state'],'completed')
        self.assertIsNotNone(full['run']['ended'])
        self.assertTrue(full['run']['usage'])
        self.assertEqual(Path(full['run']['artifact_path']).read_text(),contents)
        self.assertIn('parent_notifications',full)
        self.assertEqual((await checked('pi_agent_result',{'run_id':a['run_id']}))['result_sha256'],page['result_sha256'])
        self.assertEqual((await checked('pi_list_agents',{}))['outstanding']['total'],0)
        await checked('pi_send_message',{'agent_id':'results','message':'idle history','request_id':'idle-msg'})
        asking=await checked('pi_followup_task',{'agent_id':'results','message':'UI_CONFIRM','request_id':'ask'})
        question=(await checked('pi_wait_agent',{'run_ids':[asking['run_id']],'timeout_seconds':8}))['questions'][0]
        await checked('pi_answer_agent',{'agent_id':'results','ui_request_id':question['id'],'answer':True,'request_id':'answer'})
        await checked('pi_wait_agent',{'run_ids':[asking['run_id']],'timeout_seconds':8})
        await checked('pi_interrupt_agent',{'agent_id':'results','request_id':'idle-stop'})
