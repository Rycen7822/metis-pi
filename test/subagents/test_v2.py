from __future__ import annotations
import asyncio
import hashlib
from pathlib import Path
import json
import os
import sys
import time
import unittest
from unittest import mock
from runtime_harness import RuntimeHarness
from test_transport import McpHarness, ROOT
from subagent_pi.common import AgentError
from subagent_pi.schema import BY_NAME, validate
from schema_oracle import validate_contract
from jsonschema.exceptions import ValidationError

class V2RuntimeTests(RuntimeHarness, unittest.IsolatedAsyncioTestCase):
    async def test_retired_revision_and_indexed_read_paths(self):
        self.rt.store.execute('UPDATE scopes SET revision=11 WHERE id=?', (self.scope,))
        statements = []
        self.rt.store.db.set_trace_callback(statements.append)
        a = await self.spawn()
        await self.wait(a['run_id'])
        page = await self.result(a['run_id'])
        self.rt.store.db.set_trace_callback(None)
        self.assertEqual(self.rt.store.scope(self.scope)['revision'], 11)
        self.assertFalse(any('SET revision=' in sql for sql in statements))
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

    async def test_rejected_queued_start_advances_successor(self):
        first = await self.spawn('delay=0.5|first')
        rejected = await self.mutation('send', first['agent_id'], mode='follow_up', message='REJECT_START')
        successor = await self.mutation('send', first['agent_id'], mode='follow_up', message='successor')
        done = await self.wait(successor['run_id'])
        self.assertFalse(done['timed_out'])
        self.assertEqual((await self.result(rejected['run_id']))['run']['state'], 'failed')
        self.assertEqual((await self.result(successor['run_id']))['text'], 'Completed: successor')
        self.assertIsNotNone(self.rt.workers[first['agent_id']].idle_since)

    async def test_soft_interrupt_retains_worker_cancels_queue_and_reuses_session(self):
        a=await self.spawn('delay=1|first',name='worker')
        w=self.rt.workers[a['agent_id']]; pid=w.proc.pid; generation=w.generation
        q=await self.mutation('send',a['agent_id'],mode='follow_up',message='must not run')
        interrupted=await self.mutation('soft_interrupt','worker')
        self.assertTrue(interrupted['runtime_retained']); self.assertEqual(interrupted['previous_status'],'running')
        self.assertEqual((await self.result(a['run_id']))['run']['state'],'interrupted')
        self.assertEqual((await self.result(q['run_id']))['run']['state'],'cancelled')
        b=await self.mutation('followup','worker',message='replacement')
        await self.wait(b['run_id'])
        self.assertNotEqual(a['run_id'],b['run_id']); self.assertEqual((w.proc.pid,w.generation),(pid,generation))
        self.assertEqual((await self.result(b['run_id']))['text'],'Completed: replacement')

    async def test_abort_rejection_falls_back_to_verified_termination(self):
        self.rt.config['pi_command'].append('--reject-abort')
        a=await self.spawn('delay=1|first')
        stopped=await self.mutation('soft_interrupt',a['agent_id'])
        self.assertFalse(stopped['runtime_retained']); self.assertTrue(stopped['forced'])
        self.assertEqual(self.rt.store.agent(self.scope,a['agent_id'])['cleanup'],'verified')
        self.assertEqual((await self.result(a['run_id']))['run']['state'],'interrupted')

    async def test_question_interrupt_retains_worker_and_rejects_old_answer(self):
        a=await self.spawn('UI_CONFIRM')
        await self.until(lambda: self.rt.workers[a['agent_id']].ui)
        stopped=await self.mutation('soft_interrupt',a['agent_id'])
        self.assertTrue(stopped['runtime_retained'])
        with self.assertRaises(AgentError):
            await self.mutation('answer',a['agent_id'],ui_request_id='ui-1',answer=True)
        self.assertFalse(self.rt.workers[a['agent_id']].ui)

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
        await self.until(lambda: self.rt.workers[a['agent_id']].ui)
        w=self.rt.workers[a['agent_id']]; w.idle_since=time.monotonic()-1801
        await self.rt.park_expired()
        self.assertFalse(w.closed); self.assertTrue(w.ui)

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

class V2TransportTests(McpHarness,unittest.IsolatedAsyncioTestCase):
    async def test_cli_v2_operations_share_mcp_ledger_and_projections(self):
        await self.initialize()
        target='审'*128
        a=await self.tool('pi_spawn_agent',{'cwd':str(self.workspace),'task':'first','access':'read',
            'name':target,'request_id':'spawn'})
        await self.tool('pi_wait_agent',{'run_ids':[a['run_id']],'timeout_seconds':8})
        env=os.environ.copy(); env['PI_AGENTS_HOME']=str(self.home)
        env.pop('CODEX_THREAD_ID',None); env.pop('CODEX_SESSION_ID',None)
        async def cli(command,*extra):
            proc=await asyncio.create_subprocess_exec(sys.executable,str(ROOT/'bin/subagent-pi'),
                command,target,'--scope',a['scope'],*extra,
                stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,env=env)
            out,err=await asyncio.wait_for(proc.communicate(),10)
            self.assertEqual(proc.returncode,0,err.decode()); return json.loads(out)
        stored=await cli('send-message','--message','idle text','--request-id','msg')
        validate_contract(stored,BY_NAME['pi_send_message']['outputSchema']); self.assertIsNone(stored['run_id'])
        inspected=await self.tool('pi_inspect_agent',{'agent_id':target})
        self.assertEqual(inspected['agent']['id'],a['agent_id'])
        await self.tool('pi_send_message',{'agent_id':target,'message':'MCP Unicode target','request_id':'mcp-msg'})
        next_run=await cli('followup-task','--message','delay=1|next','--request-id','next')
        stopped=await cli('interrupt','--request-id','stop')
        validate_contract(stopped,BY_NAME['pi_interrupt_agent']['outputSchema']); self.assertTrue(stopped['runtime_retained'])
        result=await self.tool('pi_agent_result',{'run_id':next_run['run_id']})
        self.assertEqual(result['run']['state'],'interrupted')

    async def test_identifier_and_text_guards_match_tool_contract(self):
        await self.initialize()
        await self.tool('pi_context', {'cwd':str(self.workspace)})
        schema = BY_NAME['pi_spawn_agent']['inputSchema']
        for key in ['检查-1', 'trailing\n']:
            args = {'cwd':str(self.workspace), 'task':'first', 'access':'read', 'request_id':key}
            with self.assertRaises(ValidationError):
                validate_contract(args, schema)
            response = await self.rpc('tools/call', {'name':'pi_spawn_agent','arguments':args})
            self.assertTrue(response['result']['isError'])
        args = {'cwd':str(self.workspace), 'task':'你'*22000, 'access':'read', 'request_id':'bytes'}
        # Standard JSON Schema has no byte-length keyword; the advertised
        # x-maxBytes resource guard is enforced by both adapters and Runtime.
        self.assertEqual(schema['properties']['task']['x-maxBytes'], 65536)
        response = await self.rpc('tools/call', {'name':'pi_spawn_agent','arguments':args})
        self.assertTrue(response['result']['isError'])
        listed = await self.rpc('tools/call', {'name':'pi_list_agents','arguments':{}})
        self.assertEqual(self.unpack(listed)['total'], 0)

    async def test_discovery_and_structured_output_contracts(self):
        await self.initialize()
        listed=await self.rpc('tools/list')
        names={t['name'] for t in listed['result']['tools']}
        self.assertIn('pi_interrupt_agent',names); self.assertNotIn('pi_close_agent',names)
        self.assertNotIn('pi_send_input',names); self.assertNotIn('pi_respawn_agent',names)
        self.assertTrue(all('outputSchema' in t for t in listed['result']['tools']))
        calls=[('pi_spawn_agent',{'cwd':str(self.workspace),'task':'delay=1|first','access':'read','name':'named','request_id':'a'})]
        run=None
        for name,args in calls:
            r=await self.rpc('tools/call',{'name':name,'arguments':args}); value=self.unpack(r)
            self.assertFalse(r['result']['isError'],value); self.assertEqual(value,r['result']['structuredContent'])
            validate_contract(value,BY_NAME[name]['outputSchema']); run=value
        for name,args in [('pi_followup_task',{'agent_id':'named','message':'native','request_id':'b'}),
                          ('pi_interrupt_agent',{'agent_id':'named','request_id':'c'}),
                          ('pi_list_agents',{}),
                          ('pi_wait_agent',{'run_ids':[run['run_id']],'timeout_seconds':0})]:
            r=await self.rpc('tools/call',{'name':name,'arguments':args}); value=self.unpack(r)
            self.assertFalse(r['result']['isError'],value); self.assertEqual(value,r['result']['structuredContent'])
            validate_contract(value,BY_NAME[name]['outputSchema'])

    async def test_compact_read_contract_preserves_paging_delivery_and_diagnostics(self):
        await self.initialize()
        async def checked(name,args):
            response=await self.rpc('tools/call',{'name':name,'arguments':args})
            value=self.unpack(response)
            self.assertFalse(response['result']['isError'],value)
            self.assertEqual(value,response['result']['structuredContent'])
            validate_contract(value,BY_NAME[name]['outputSchema'])
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
        self.assertEqual(listing['parent_notifications'],{'enabled':False})
        self.assertNotIn('resolved_model',listing['agents'][0]); self.assertNotIn('thinking',listing['agents'][0])
        self.assertEqual(listing['outstanding']['total'],0)
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
