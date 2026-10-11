"""Parent identity and durable attention through real MCP/IPC/subprocess boundaries."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest import mock

from paths import ROOT, TEST_ROOT, REPO_ROOT
from subagent_pi import parent
from subagent_pi.client import request
from subagent_pi.common import AgentError, dumps, group_members
from subagent_pi.runtime import Runtime
from test_transport import McpHarness


class ParentNotifications(McpHarness, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.codex_home=self.root/'codex'; self.codex_home.mkdir()
        self.log=self.codex_home/'queue.jsonl'
        bindir=self.root/'bin'; bindir.mkdir()
        command=bindir/'codex'
        command.write_text('#!'+sys.executable+'\n'+"""
import json,os,sys,time,uuid
from pathlib import Path
home=Path(os.environ['CODEX_HOME']); args=sys.argv[1:]
if args[0]=='queue':
    thread=args[args.index('--thread')+1]; message=args[args.index('--message')+1]; queued_id=str(uuid.uuid4())
    with (home/'queue.jsonl').open('a') as f: f.write(json.dumps({'id':queued_id,'thread':thread,'message':message})+'\\n')
    while (home/('hold-'+thread)).exists(): time.sleep(.01)
    if (home/'reject').exists(): sys.exit(2)
    print('Queued message '+queued_id+' for thread '+thread+'.')
else:
    assert args==['app-server','--stdio']
    for line in sys.stdin:
        request=json.loads(line)
        if request['method']=='initialized': continue
        if request['method']=='initialize': result={}
        else:
            assert request['method']=='thread/queue/delete'
            params=request['params']
            with (home/'recalls.jsonl').open('a') as f: f.write(json.dumps(params)+'\\n')
            if (home/'recall-reject').exists():
                print(json.dumps({'id':request['id'],'error':{'code':-32601,'message':'unsupported'}}),flush=True); continue
            result={'deleted':not (home/'already-consumed').exists()}
        print(json.dumps({'id':request['id'],'result':result}),flush=True)
""")
        command.chmod(0o755)
        self.mcp_env={'CODEX_HOME':str(self.codex_home),'HOME':str(self.root),
                      'PATH':str(bindir)+os.pathsep+os.environ['PATH']}
        self.parent=str(uuid.uuid4())
        await self.initialize()

    async def parent_tool(self,name,args,thread=None,error=False):
        response=await self.rpc('tools/call',{'name':name,'arguments':args,'_meta':{'threadId':thread or self.parent}})
        value=self.unpack(response)
        self.assertEqual(bool(response['result'].get('isError')),error,value)
        return value

    async def settled_notifications(self,sid,count):
        until=asyncio.get_running_loop().time()+8
        while asyncio.get_running_loop().time()<until:
            state=await self.tool('pi_context',{'cwd':str(self.workspace),'scope':sid})
            rows=state['parent_notifications']['recent']
            if len(rows)>=count and all(n['state'] not in ('pending','sending','recalling') for n in rows): return rows
            await asyncio.sleep(.02)
        self.fail('Notifications did not settle')

    def queued(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    async def open_parent(self):
        return (await self.parent_tool('pi_context',{'cwd':str(self.workspace)}))['scope']

    async def test_all_barrier_keeps_partial_completion_attention_until_handoff(self):
        # Exercise Pi and Codex queue subprocesses while controlling reservation
        # order directly; both MCP and CLI use the same Runtime barrier.
        rt=Runtime(self.home); token=None; waiting=None
        gates=[self.root/'release-first',self.root/'release-second']
        try:
            source=self.trusted_source()
            sid=(await rt.dispatch('scope_open',{'cwd':str(self.workspace)},source))['scope']
            runs=[await rt.dispatch('spawn',{'scope':sid,'task':f'gate={gate}|run-{i}',
                'access':'read','request_id':f'barrier-{i}'},source) for i,gate in enumerate(gates)]
            params={'scope':sid,'run_ids':[r['run_id'] for r in runs],'mode':'all','timeout_seconds':4}
            token=rt.parent_notifications.reserve_delivery('wait',params,source)
            waiting=asyncio.create_task(rt.dispatch('wait',params,source))
            gates[0].touch()
            async with asyncio.timeout(2):
                while not self.queued(): await asyncio.sleep(.01)
            self.assertFalse(waiting.done(),'all must retain its explicit barrier semantics')
            self.assertEqual(rt.store.run(sid,runs[1]['run_id'])['state'],'running')
            first_notice=self.queued()[0]
            self.assertIn(runs[0]['run_id'],first_notice['message'])
            gates[1].touch()
            response=await waiting
            await rt.parent_notifications.settle_delivery(token,'wait',response)
            rt.parent_notifications.release_delivery(token,'wait',response); token=None
            self.assertIn({'threadId':self.parent,'queuedSubmissionId':first_notice['id']},self.recalls())
            self.assertEqual([r['state'] for r in response['runs']],['completed','completed'])
            notices=rt.store.all('SELECT state,handled FROM parent_notifications WHERE scope=?',(sid,))
            self.assertEqual(len(notices),2)
            self.assertTrue(all(r['handled'] and r['state'] not in ('pending','sending','queued','recalling') for r in notices))
        finally:
            for gate in gates: gate.touch()
            if waiting and not waiting.done(): waiting.cancel()
            if waiting: await asyncio.gather(waiting,return_exceptions=True)
            if token: rt.parent_notifications.release_delivery(token,'wait')
            await rt.shutdown()

    async def test_two_parents_share_adapter_without_scope_or_notification_cross_talk(self):
        first=await self.open_parent(); other=str(uuid.uuid4())
        second=(await self.parent_tool('pi_context',{'cwd':str(self.workspace)},other))['scope']
        self.assertNotEqual(first,second)
        for thread,sid in ((self.parent,first),(other,second)):
            run=await self.parent_tool('pi_spawn_agent',{'request_id':'same-key','task':'hello','access':'read'},thread)
            self.assertEqual(run['scope'],sid)
            rows=await self.settled_notifications(sid,1)
            self.assertEqual(rows[0]['state'],'queued'); self.assertTrue(rows[0]['queued_id'])
            # Replaying the mutation never produces a second terminal notification.
            retry=await self.parent_tool('pi_spawn_agent',{'request_id':'same-key','task':'hello','access':'read'},thread)
            self.assertEqual(retry['run_id'],run['run_id'])
        messages=self.queued(); self.assertEqual([m['thread'] for m in messages],[self.parent,other])
        self.assertTrue(all('not a user instruction or approval' in m['message'] for m in messages))
        conflict=await self.parent_tool('pi_context',{'cwd':str(self.workspace),'scope':first},other,error=True)
        self.assertEqual(conflict['error']['code'],'parent_conflict')
        conflict = await self.parent_tool(
            "pi_spawn_agent",
            {"scope": first, "request_id": "wrong-parent", "task": "must not start", "access": "read"},
            other,
            error=True,
        )
        self.assertEqual(conflict['error']['code'],'parent_conflict')

    async def test_question_and_stop_notify_without_a_parent_wait(self):
        sid=await self.open_parent()
        run=await self.parent_tool('pi_spawn_agent',{'name':'permission-check','request_id':'ask','task':'UI_CONFIRM','access':'read'})
        rows=await self.settled_notifications(sid,1)
        self.assertEqual(rows[0]['kind'],'question')
        self.assertIn('ui-1',self.queued()[0]['message'])
        await self.parent_tool('pi_close_agent',{'request_id':'stop','agent_id':run['agent_id']})
        rows=await self.settled_notifications(sid,2)
        self.assertEqual({r['kind'] for r in rows},{'question','terminal'})
        self.assertEqual(next(r['state'] for r in rows if r['kind']=='question'),'recalled')
        self.assertEqual(self.recalls(),[{'threadId':self.parent,'queuedSubmissionId':self.queued()[0]['id']}])
        self.assertIn('interrupted',self.queued()[1]['message'])
        for notice in self.queued():
            data=json.loads(notice['message'].splitlines()[1])
            self.assertEqual((data['name'],data['agent_id']),('permission-check',run['agent_id']))

    async def test_crash_notifies_without_a_parent_wait(self):
        sid=await self.open_parent()
        response=await self.rpc('tools/call',{'name':'pi_spawn_agent','arguments':{'scope':sid,'request_id':'crash','task':'CRASH','access':'read'}})
        value=self.unpack(response)
        rows=await self.settled_notifications(sid,1)
        self.assertEqual(rows[0]['state'],'queued',value)
        self.assertRegex(self.queued()[0]['message'],'crashed|failed')

    async def test_uncertain_queue_is_durable_and_never_retried(self):
        (self.codex_home/'reject').touch()
        sid=await self.open_parent()
        run=await self.parent_tool('pi_spawn_agent',{'request_id':'finish','task':'done','access':'read'})
        rows=await self.settled_notifications(sid,1)
        self.assertEqual(rows[0]['state'],'unknown'); self.assertIn('not retried',rows[0]['error'])
        await request(self.home,'shutdown',{'force':True})
        from subagent_pi.common import socket_path
        until=asyncio.get_running_loop().time()+5
        while socket_path(self.home).exists() and asyncio.get_running_loop().time()<until: await asyncio.sleep(.02)
        (self.codex_home/'reject').unlink()
        await self.tool('pi_list_agents',{'scope':sid})  # restarts daemon
        rows=await self.settled_notifications(sid,1)
        self.assertEqual(rows[0]['state'],'unknown'); self.assertEqual(len(self.queued()),1)

    async def restart_daemon(self):
        await request(self.home,'shutdown',{'force':True})
        from subagent_pi.common import socket_path
        until=asyncio.get_running_loop().time()+5
        while socket_path(self.home).exists() and asyncio.get_running_loop().time()<until: await asyncio.sleep(.02)
        await request(self.home,'ping',{})

    async def test_pending_stop_survives_daemon_restart(self):
        sid=await self.open_parent()
        await self.parent_tool('pi_spawn_agent',{'request_id':'slow','task':'delay=30|work','access':'read'})
        await self.restart_daemon()
        rows=await self.settled_notifications(sid,1)
        self.assertEqual(rows[0]['state'],'queued'); self.assertEqual(len(self.queued()),1)
        self.assertIn('interrupted',self.queued()[0]['message'])

    async def test_crash_in_sending_window_is_not_retried(self):
        sid=await self.open_parent()
        run=await self.parent_tool('pi_spawn_agent',{'request_id':'once','task':'once','access':'read'})
        await self.settled_notifications(sid,1)
        # Reconstruct the on-disk state of a daemon killed after enqueue but
        # before receipt persistence. The external side effect already happened.
        import sqlite3
        with sqlite3.connect(self.home/'registry.sqlite') as db:
            db.execute("UPDATE parent_notifications SET state='sending',queued_id=NULL")
        await self.restart_daemon()
        rows=await self.settled_notifications(sid,1)
        self.assertEqual(rows[0]['state'],'unknown'); self.assertEqual(len(self.queued()),1)

    async def test_interrupted_recall_resumes_without_resending(self):
        sid=await self.open_parent()
        run=await self.parent_tool('pi_spawn_agent',{'request_id':'done','task':'done','access':'read'})
        notice=(await self.settled_notifications(sid,1))[0]
        # A delivered wait had requested recall, then the daemon died before
        # recording the host response. Retrying this exact deletion is safe.
        import sqlite3
        with sqlite3.connect(self.home/'registry.sqlite') as db:
            db.execute("UPDATE parent_notifications SET state='recalling',handled=1")
        await self.restart_daemon()
        await self.wait_notice_state(sid,'recalled')
        self.assertEqual(self.recalls(),[{'threadId':self.parent,'queuedSubmissionId':notice['queued_id']}])
        result=await self.parent_tool('pi_agent_result',{'run_id':run['run_id']})
        self.assertEqual(result['text'],'Completed: done'); self.assertEqual(len(self.queued()),1)

    async def test_consumed_queue_is_recalled_on_restart(self):
        sid=await self.open_parent()
        await self.parent_tool('pi_spawn_agent',{'request_id':'done','task':'done','access':'read'})
        notice=(await self.settled_notifications(sid,1))[0]
        import sqlite3
        with sqlite3.connect(self.home/'registry.sqlite') as db:
            db.execute('UPDATE parent_notifications SET handled=1')
        await self.restart_daemon()
        await self.wait_notice_state(sid,'recalled')
        self.assertEqual(self.recalls(),[{'threadId':self.parent,'queuedSubmissionId':notice['queued_id']}])
        self.assertEqual(len(self.queued()),1)

    async def test_restart_during_unconsumed_wait_withdrawal_restores_wakeup(self):
        sid=await self.open_parent()
        await self.parent_tool('pi_spawn_agent',{'request_id':'done','task':'done','access':'read'})
        notice=(await self.settled_notifications(sid,1))[0]
        import sqlite3
        with sqlite3.connect(self.home/'registry.sqlite') as db:
            db.execute("UPDATE parent_notifications SET state='recalling',handled=0")
        await self.restart_daemon()
        rows=await self.wait_notice_state(sid,'queued')
        self.assertNotEqual(rows[0]['queued_id'],notice['queued_id'])
        self.assertEqual(self.recalls(),[{'threadId':self.parent,'queuedSubmissionId':notice['queued_id']}])

    async def test_unbound_clients_never_guess_the_parent(self):
        scope=await self.tool('pi_context',{'cwd':str(self.workspace)})
        self.assertFalse(scope['parent_notifications']['enabled'])
        run=await self.tool('pi_spawn_agent',{'request_id':'plain','task':'plain','access':'read'})
        await self.tool('pi_wait_agent',{'run_ids':[run['run_id']],'timeout_seconds':4})
        self.assertFalse(self.log.exists())
        bad=await self.rpc('tools/call',{'name':'pi_context','arguments':{'cwd':str(self.workspace),'parent_thread_id':self.parent}})
        self.assertTrue(bad['result']['isError'])

    def trusted_source(self):
        from subagent_pi.parent import capture
        return {'env':{},'parent':capture(self.mcp_env,self.parent)}

    def recalls(self):
        path=self.codex_home/'recalls.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    async def wait_notice_state(self,sid,state):
        async with asyncio.timeout(8):
            while True:
                rows=(await self.tool('pi_context',{'cwd':str(self.workspace),'scope':sid}))['parent_notifications']['recent']
                if rows and rows[0]['state']==state: return rows
                await asyncio.sleep(.02)

    async def test_result_read_recalls_only_its_queued_message_and_preserves_the_result(self):
        sid=await self.open_parent()
        run=await self.parent_tool('pi_spawn_agent',{'request_id':'finish','task':'done','access':'read'})
        notice=(await self.settled_notifications(sid,1))[0]
        result=await self.parent_tool('pi_agent_result',{'run_id':run['run_id']})
        rows=await self.wait_notice_state(sid,'observed')
        self.assertEqual(self.recalls(),[{'threadId':self.parent,'queuedSubmissionId':notice['queued_id']}])
        again=await self.parent_tool('pi_agent_result',{'run_id':run['run_id']})
        self.assertEqual(again['result_sha256'],result['result_sha256'])
        await self.restart_daemon()
        await self.tool('pi_list_agents',{'scope':sid})
        self.assertEqual(len(self.queued()),1)
        self.assertEqual(len(self.recalls()),1)

    async def test_late_wait_recalls_queue_and_consumes_delivery(self):
        sid=await self.open_parent()
        run=await self.parent_tool('pi_spawn_agent',{'request_id':'finish','task':'done','access':'read'})
        notice=(await self.settled_notifications(sid,1))[0]
        result=await self.parent_tool('pi_wait_agent',{'run_ids':[run['run_id']]})
        self.assertEqual(self.recalls(),[{'threadId':self.parent,'queuedSubmissionId':notice['queued_id']}])
        await self.wait_notice_state(sid,'observed')

    async def test_wait_during_enqueue_preserves_observation_until_receipt_arrives(self):
        sid=await self.open_parent(); hold=self.codex_home/('hold-'+self.parent); hold.touch()
        waiting=None
        try:
            run=await self.parent_tool('pi_spawn_agent',{'request_id':'finish','task':'done','access':'read'})
            async with asyncio.timeout(8):
                while not self.queued(): await asyncio.sleep(.02)
            async def output(value):
                self.assertEqual(len(self.recalls()),1,'withdraw the earlier wakeup before delivering a wait result')
            waiting = asyncio.create_task(
                request(
                    self.home,
                    "wait",
                    {"scope": sid, "run_ids": [run["run_id"]]},
                    source=self.trusted_source(),
                    on_result=output,
                )
            )
            await asyncio.sleep(.05)
            self.assertFalse(waiting.done())
            hold.unlink()
            result=await waiting
            await self.wait_notice_state(sid,'observed')
            self.assertEqual(len(self.queued()),1)
            self.assertEqual(self.recalls(),[{'threadId':self.parent,'queuedSubmissionId':self.queued()[0]['id']}])
        finally:
            hold.unlink(missing_ok=True)
            if waiting: await asyncio.gather(waiting,return_exceptions=True)

    async def test_wait_recall_failure_withholds_result_and_retry_can_consume_once(self):
        sid=await self.open_parent()
        run=await self.parent_tool('pi_spawn_agent',{'request_id':'finish','task':'done','access':'read'})
        await self.settled_notifications(sid,1)
        reject=self.codex_home/'recall-reject'; reject.touch(); outputs=[]
        async def output(value): outputs.append(value)
        params={'scope':sid,'run_ids':[run['run_id']]}
        with self.assertRaises(AgentError) as error:
            await request(self.home,'wait',params,source=self.trusted_source(),on_result=output)
        self.assertEqual(error.exception.code,'notification_handoff_failed')
        self.assertEqual(outputs,[])
        reject.unlink()
        await request(self.home,'wait',params,source=self.trusted_source(),on_result=output)
        await self.wait_notice_state(sid,'observed')
        self.assertEqual(len(outputs),1); self.assertEqual(len(self.queued()),1)

    async def test_failed_read_output_after_recall_restores_automatic_wakeup(self):
        sid=await self.open_parent()
        run=await self.parent_tool('pi_spawn_agent',{'request_id':'finish','task':'done','access':'read'})
        await self.settled_notifications(sid,1)
        for index,(op,args) in enumerate((('wait',{'run_ids':[run['run_id']]}), ('result',{'run_id':run['run_id']}),
                                         ('inspect',{'agent_id':run['agent_id']})),1):
            with self.subTest(op=op):
                notice=(await self.wait_notice_state(sid,'queued'))[0]
                async def output(value):
                    self.assertEqual(self.recalls()[-1],{'threadId':self.parent,'queuedSubmissionId':notice['queued_id']})
                    raise BrokenPipeError('output closed after withdrawal')
                with self.assertRaises(BrokenPipeError):
                    await request(self.home,op,{'scope':sid,**args},source=self.trusted_source(),on_result=output)
                rows=await self.wait_notice_state(sid,'queued')
                self.assertNotEqual(rows[0]['queued_id'],notice['queued_id'])
                self.assertEqual(len(self.queued()),index+1,'only the replacement can wake the parent')

    async def test_result_during_enqueue_waits_for_receipt_then_recalls_it(self):
        sid=await self.open_parent(); hold=self.codex_home/('hold-'+self.parent); hold.touch()
        reading=None
        try:
            run=await self.parent_tool('pi_spawn_agent',{'request_id':'finish','task':'done','access':'read'})
            async with asyncio.timeout(8):
                while not self.queued(): await asyncio.sleep(.02)
            async def output(value): self.assertEqual(value['text'],'Completed: done')
            reading = asyncio.create_task(
                request(
                    self.home,
                    "result",
                    {"scope": sid, "run_id": run["run_id"]},
                    source=self.trusted_source(),
                    on_result=output,
                )
            )
            await asyncio.sleep(.05)
            self.assertFalse(reading.done(),'result delivery must settle its in-flight notification')
            hold.unlink()
            self.assertEqual((await reading)['text'],'Completed: done')
            await self.wait_notice_state(sid,'observed')
            self.assertEqual(len(self.queued()),1);self.assertEqual(len(self.recalls()),1)
        finally:
            hold.unlink(missing_ok=True)
            if reading: await asyncio.gather(reading,return_exceptions=True)

    async def test_unavailable_recall_is_reported_without_resending(self):
        (self.codex_home/'recall-reject').touch()
        sid=await self.open_parent()
        run=await self.parent_tool('pi_spawn_agent',{'request_id':'finish','task':'done','access':'read'})
        await self.settled_notifications(sid,1)
        error=await self.parent_tool('pi_agent_result',{'run_id':run['run_id']},error=True)
        self.assertEqual(error['error']['code'],'notification_handoff_failed')
        rows=await self.wait_notice_state(sid,'recall_failed')
        self.assertTrue(rows[0]['error']); self.assertEqual(len(self.queued()),1)
        listing=await self.tool('pi_list_agents',{'scope':sid})
        self.assertEqual(listing['parent_notifications'],{'enabled':True,'failed':1})
        full=await self.tool('pi_inspect_agent',{'scope':sid,'agent_id':run['agent_id'],'detail':'full','max_bytes':16384})
        self.assertEqual(full['parent_notifications']['recent'][0]['state'],'recall_failed')

    async def test_consumed_message_is_not_claimed_recalled_or_reenqueued(self):
        (self.codex_home/'already-consumed').touch()
        sid=await self.open_parent()
        run=await self.parent_tool('pi_spawn_agent',{'request_id':'finish','task':'done','access':'read'})
        await self.settled_notifications(sid,1)
        result=await self.parent_tool('pi_agent_result',{'run_id':run['run_id']})
        await self.wait_notice_state(sid,'delivered')
        self.assertEqual(len(self.queued()),1);self.assertEqual(len(self.recalls()),1)

    async def test_active_parent_wait_delivers_once_and_preserves_rereads(self):
        sid=await self.open_parent()
        run=await self.parent_tool('pi_spawn_agent',{'request_id':'finish','task':'delay=0.3|done','access':'read'})
        result=await self.parent_tool('pi_wait_agent',{'run_ids':[run['run_id']]})
        self.assertEqual(result['reason'],'completed')
        rows=await self.settled_notifications(sid,1)
        self.assertEqual(rows[0]['state'],'observed'); self.assertEqual(self.queued(),[])
        await self.restart_daemon()
        again=await self.parent_tool('pi_wait_agent',{'scope':sid,'run_ids':[run['run_id']],'timeout_seconds':0})
        self.assertEqual(again['runs'][0]['result']['result_sha256'],result['runs'][0]['result']['result_sha256'])
        self.assertEqual(
            (await self.parent_tool("pi_agent_result", {"scope": sid, "run_id": run["run_id"]}))["result_sha256"],
            result["runs"][0]["result"]["result_sha256"],
        )
        self.assertEqual(self.queued(),[])

    async def test_question_receipt_does_not_hide_later_completion(self):
        sid=await self.open_parent()
        run=await self.parent_tool('pi_spawn_agent',{'request_id':'ask','task':'delay=0.3|UI_CONFIRM','access':'read'})
        result=await self.parent_tool('pi_wait_agent',{'run_ids':[run['run_id']]})
        self.assertEqual(result['reason'],'needs_input')
        rows=await self.settled_notifications(sid,1)
        self.assertEqual(rows[0]['state'],'observed'); self.assertEqual(self.queued(),[])
        await self.parent_tool('pi_answer_agent',{'agent_id':run['agent_id'],'request_id':'answer',
            'ui_request_id':result['questions'][0]['id'],'answer':True})
        rows=await self.settled_notifications(sid,2)
        self.assertEqual({n['kind']:n['state'] for n in rows},{'question':'observed','terminal':'queued'})
        self.assertEqual(len(self.queued()),1)

    async def test_cancelled_mcp_wait_restores_automatic_wakeup(self):
        sid=await self.open_parent()
        run=await self.parent_tool('pi_spawn_agent',{'request_id':'finish','task':'delay=0.5|done','access':'read'})
        rid=await self.send('tools/call',{'name':'pi_wait_agent','arguments':{'run_ids':[run['run_id']]},'_meta':{'threadId':self.parent}})
        ping=await self.send('ping'); self.assertEqual((await self.receive())['id'],ping)
        await self.send('notifications/cancelled',{'requestId':rid})
        rows=await self.settled_notifications(sid,1)
        self.assertEqual(rows[0]['state'],'queued'); self.assertEqual(len(self.queued()),1)

    async def test_failed_adapter_write_restores_pending_attention(self):
        sid=await self.open_parent()
        run=await self.parent_tool('pi_spawn_agent',{'request_id':'finish','task':'delay=0.3|done','access':'read'})
        async def broken_output(value):
            self.assertEqual(value['reason'],'completed')
            self.assertEqual(self.queued(),[])
            raise BrokenPipeError('Parent output closed before delivery')
        with self.assertRaises(BrokenPipeError):
            await request(self.home,'wait',{'scope':sid,'run_ids':[run['run_id']]},source=self.trusted_source(),on_result=broken_output)
        rows=await self.settled_notifications(sid,1)
        self.assertEqual(rows[0]['state'],'queued'); self.assertEqual(len(self.queued()),1)

    async def test_overlapping_wait_failure_cannot_cancel_another_delivery(self):
        sid=await self.open_parent()
        run=await self.parent_tool('pi_spawn_agent',{'request_id':'finish','task':'delay=0.5|done','access':'read'})
        arrived=asyncio.Event(); release=asyncio.Event()
        async def slow_output(value):
            arrived.set(); await release.wait()
        async def broken_output(value):
            await arrived.wait(); raise BrokenPipeError('One disconnected reader')
        params={'scope':sid,'run_ids':[run['run_id']]}
        first=asyncio.create_task(request(self.home,'wait',params,source=self.trusted_source(),on_result=slow_output))
        try:
            with self.assertRaises(BrokenPipeError):
                await request(self.home,'wait',params,source=self.trusted_source(),on_result=broken_output)
            state=await self.tool('pi_context',{'cwd':str(self.workspace),'scope':sid})
            self.assertEqual(state['parent_notifications']['recent'][0]['state'],'pending')
            self.assertEqual(self.queued(),[])
        finally:
            release.set(); await first
        rows=await self.settled_notifications(sid,1)
        self.assertEqual(rows[0]['state'],'observed'); self.assertEqual(self.queued(),[])

    async def test_foreign_parent_read_does_not_suppress_owner_notification(self):
        sid=await self.open_parent()
        run=await self.parent_tool('pi_spawn_agent',{'request_id':'finish','task':'delay=0.3|done','access':'read'})
        result=await self.parent_tool('pi_wait_agent',{'scope':sid,'run_ids':[run['run_id']]},str(uuid.uuid4()))
        self.assertEqual(result['reason'],'completed')
        rows=await self.settled_notifications(sid,1)
        self.assertEqual(rows[0]['state'],'queued'); self.assertEqual(self.queued()[0]['thread'],self.parent)

    async def test_immediate_wait_does_not_hide_future_completion(self):
        sid=await self.open_parent()
        run=await self.parent_tool('pi_spawn_agent',{'request_id':'finish','task':'delay=0.3|done','access':'read'})
        result=await self.parent_tool('pi_wait_agent',{'run_ids':[run['run_id']],'timeout_seconds':0})
        self.assertTrue(result['timed_out'])
        rows=await self.settled_notifications(sid,1)
        self.assertEqual(rows[0]['state'],'queued')

    async def test_blocked_queue_does_not_block_another_parent_question(self):
        sid=await self.open_parent()
        hold=self.codex_home/('hold-'+self.parent); hold.touch()
        try:
            await self.parent_tool('pi_spawn_agent',{'request_id':'blocked','task':'done','access':'read'})
            until=asyncio.get_running_loop().time()+5
            while not self.queued() and asyncio.get_running_loop().time()<until: await asyncio.sleep(.02)
            self.assertEqual(len(self.queued()),1)
            other=str(uuid.uuid4())
            second=(await self.parent_tool('pi_context',{'cwd':str(self.workspace)},other))['scope']
            await self.parent_tool('pi_spawn_agent',{'name':'permission-check','request_id':'ask','task':'UI_CONFIRM','access':'read'},other)
            rows=await self.settled_notifications(second,1)
            self.assertEqual(rows[0]['state'],'queued')
            self.assertEqual([m['thread'] for m in self.queued()],[self.parent,other])
            state=await self.tool('pi_context',{'cwd':str(self.workspace),'scope':sid})
            self.assertEqual(state['parent_notifications']['recent'][0]['state'],'sending')
        finally: hold.unlink()
        await self.settled_notifications(sid,1)

    async def test_wait_only_suppresses_selected_runs(self):
        sid=await self.open_parent()
        watched=await self.parent_tool('pi_spawn_agent',{'request_id':'watched','task':'delay=0.5|watched','access':'read'})
        other=await self.parent_tool('pi_spawn_agent',{'request_id':'other','task':'delay=0.2|other','access':'read'})
        await self.parent_tool('pi_wait_agent',{'run_ids':[watched['run_id']]})
        rows=await self.settled_notifications(sid,2)
        self.assertEqual({n['run_id']:n['state'] for n in rows},{watched['run_id']:'observed',other['run_id']:'queued'})
        self.assertEqual(len(self.queued()),1)
        self.assertIn(other['run_id'],self.queued()[0]['message'])


class ParentScheduleBounds(unittest.TestCase):
    def test_shutdown_done_callback_does_not_start_another_delivery(self):
        binding={'codex_home':'/tmp/codex','thread_id':str(uuid.uuid4())}
        notice={'id':'n1','scope':'s','run_id':'r','agent_id':'a','run_state':'completed',
                'kind':'terminal','ui_id':None,'parent':dumps(binding),'priority':2,'created':0,'state':'pending','handled':0}
        class StoreStub:
            queries=0
            def all(self,sql,args=()):
                self.queries+=1
                return [notice] if self.queries==1 else []
            def execute(self,*args): pass
        class TaskStub:
            def add_done_callback(self,callback): self.done=callback
        store=StoreStub(); tasks=[]
        def spawn(coro):
            coro.close()
            task=TaskStub(); tasks.append(task); return task
        notifications=parent.ParentNotifications(store,spawn,lambda _aid: None)
        notifications.schedule()
        self.assertEqual(len(tasks),1)
        before=store.queries
        notifications.closing=True
        tasks[0].done(tasks[0])
        self.assertEqual(notifications.deliveries,{})
        self.assertEqual(store.queries,before)

    def test_busy_parent_backlog_stays_bounded_and_reserved_page_is_skipped(self):
        with tempfile.TemporaryDirectory(prefix='subagent-pi-parent-page-') as directory:
            rt=Runtime(Path(directory))
            sid='scope_page'; aid='pi_page'; thread=str(uuid.uuid4()); codex_home=str(Path(directory)/'codex')
            binding={'thread_id':thread,'codex_home':codex_home,'command':'/bin/true',
                     'home':directory,'path':'/bin'}
            ids=[f'run_{i:03d}' for i in range(140)]
            try:
                rt.store.execute('BEGIN')
                rt.store.execute('INSERT INTO scopes(id,cwd,label,created,parent) VALUES(?,?,?,?,?)',
                                 (sid,directory,'test',0,dumps(binding)))
                rt.store.execute('INSERT INTO agents(id,scope,name,cwd,state,session_file,launch,created,updated) '
                                 'VALUES(?,?,?,?,?,?,?,?,?)',(aid,sid,'test',directory,'idle','session','{}',0,0))
                for i,rid in enumerate(ids):
                    rt.store.execute('INSERT INTO runs(id,agent_id,scope,state,task,created) VALUES(?,?,?,?,?,?)',
                                     (rid,aid,sid,'completed','test',i))
                    rt.store.execute('INSERT INTO parent_notifications(id,scope,run_id,kind,created) VALUES(?,?,?,?,?)',
                                     (f'notice_{i:03d}',sid,rid,'terminal',i))
                rt.store.execute('COMMIT')
                key=(codex_home,thread); rt.parent_notifications.deliveries[key]=object()
                seen=[]; original=rt.store.all
                def traced(sql,args=()):
                    rows=original(sql,args)
                    if 'parent_notifications n' in sql: seen.append(len(rows))
                    return rows
                with mock.patch.object(rt.store,'all',side_effect=traced), \
                     mock.patch.object(rt.store,'run',wraps=rt.store.run) as run:
                    rt.parent_notifications.schedule()
                    self.assertLessEqual(max(seen,default=0),64)
                    self.assertEqual(run.call_count,0)

                del rt.parent_notifications.deliveries[key]
                class UnstartedTask:
                    def add_done_callback(self,_callback): pass
                def capture_delivery(coro):
                    coro.close()  # The test checks selection, not Codex delivery.
                    return UnstartedTask()
                seen.clear()
                with mock.patch.object(rt.store,'all',side_effect=traced), \
                     mock.patch.object(rt.parent_notifications,'spawn_task',side_effect=capture_delivery):
                    rt.parent_notifications.schedule()
                self.assertLessEqual(sum(seen),64)
                rt.store.execute("UPDATE parent_notifications SET state='pending' WHERE id='notice_000'")
                rt.parent_notifications.deliveries.clear()
                rt.parent_notifications.waits[object()]=(sid,frozenset(ids[:100]),True)
                with mock.patch.object(rt.parent_notifications,'spawn_task',side_effect=capture_delivery):
                    rt.parent_notifications.schedule()
                selected=rt.store.one("SELECT run_id FROM parent_notifications WHERE state='sending'")
                self.assertEqual(selected['run_id'],ids[100])
            finally:
                rt.store.close()


class ParentDeliveryProcessTests(unittest.IsolatedAsyncioTestCase):
    async def test_sender_rechecks_consumption_and_wait_before_starting_queue(self):
        run={'id':'r','agent_id':'a','state':'completed'}
        notice={'id':'n','scope':'s','run_id':'r','kind':'terminal','ui_id':None}
        class Store:
            handled=0
            def one(self,*_args): return {'handled':self.handled}
            def run(self,*_args): return run
            def execute(self,_sql,values): self.state=values[0]
        for winner in ('delivery_receipt','wait_reservation'):
            with self.subTest(winner=winner):
                store=Store(); store.handled=int(winner=='delivery_receipt')
                notifications=parent.ParentNotifications(store,None,lambda _aid: None)
                if winner=='wait_reservation': notifications.waits[object()]=('s',frozenset({'r'}),True)
                with mock.patch.object(parent,'enqueue',new_callable=mock.AsyncMock) as enqueue:
                    await notifications.deliver(notice,run,{})
                    enqueue.assert_not_awaited()
                self.assertEqual(store.state,'pending' if winner=='wait_reservation' else 'superseded')

    async def test_invalid_or_stalled_recall_is_bounded_and_reaps_its_process(self):
        for failure in ("print('x'*100000,flush=True)","os.close(1)","pass"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(prefix='parent-recall-') as tmp:
                root=Path(tmp); wrapper=root/'codex'; pidfile=root/'pid'
                wrapper.write_text('#!'+sys.executable+'\nimport os,time\nfrom pathlib import Path\n'
                    +f'Path({str(pidfile)!r}).write_text(str(os.getpid()))\n{failure}\ntime.sleep(30)\n')
                wrapper.chmod(0o755)
                bound={'command':str(wrapper),'home':tmp,'codex_home':tmp,
                       'path':os.environ.get('PATH',''),'thread_id':str(uuid.uuid4())}
                with mock.patch.object(parent,'RECALL_TIMEOUT_SECONDS',.3):
                    deleted,error=await asyncio.wait_for(parent.recall(bound,str(uuid.uuid4())),5)
                self.assertIsNone(deleted); self.assertIn('notification may still arrive',error)
                self.assertEqual(group_members(int(pidfile.read_text())),[])

    async def test_exited_queue_wrapper_cannot_leave_pipe_holding_child(self):
        with tempfile.TemporaryDirectory(prefix='parent-queue-group-') as tmp:
            root=Path(tmp); codex_home=root/'codex'; codex_home.mkdir()
            child=root/'child.py'
            child.write_text('''import json,os,time
from pathlib import Path
Path(os.environ['CODEX_HOME'],'child.json').write_text(json.dumps({'pid':os.getpid(),'pgid':os.getpgrp()}))
time.sleep(30)
''')
            bindir=root/'bin'; bindir.mkdir()
            wrapper=bindir/'codex'; wrapper.write_text(
                '#!'+sys.executable+'\nimport subprocess,sys\n'
                f'child=subprocess.Popen([sys.executable,{str(child)!r}],stdout=sys.stdout,stderr=sys.stderr)\n')
            wrapper.chmod(0o755)
            class StoreStub:
                saved=None
                def agent(self,*_args): return {'name':'child'}
                def one(self,*_args): return {'handled':0}
                def run(self,*_args): return run
                def execute(self,_sql,values): self.saved=values
            store=StoreStub()
            notifications=parent.ParentNotifications(store,None,lambda _aid: None)
            notice={'id':'notice-1','scope':'scope-1','run_id':'run-1','kind':'terminal','ui_id':None}
            run={'agent_id':'agent-1','id':'run-1','state':'completed'}
            bound={'command':str(wrapper),'home':str(root),'codex_home':str(codex_home),
                   'path':os.environ.get('PATH',''),'thread_id':str(uuid.uuid4())}
            pgid=None
            try:
                with mock.patch.object(parent,'QUEUE_TIMEOUT_SECONDS',.3):
                    await asyncio.wait_for(notifications.deliver(notice,run,bound),5)
                child_info=json.loads((codex_home/'child.json').read_text())
                pgid=child_info['pgid']
                self.assertEqual(store.saved[0],'unknown')
                self.assertIn('not retried',store.saved[2])
                self.assertEqual(group_members(pgid),[])
            finally:
                if pgid and group_members(pgid): os.killpg(pgid,9)
