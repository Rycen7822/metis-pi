"""Real Codex queue -> original idle parent turn, with local-only mock models.
Opt in with SUBAGENT_PI_LIVE_CODEX=1; never uses user settings or authentication.
"""
import asyncio
import json
import os
from pathlib import Path
import shutil
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest

from test_transport import McpHarness, ROOT


class LiveParentWakeup(McpHarness, unittest.IsolatedAsyncioTestCase):
    READ_TIMEOUT=45

    async def asyncSetUp(self):
        if os.environ.get('SUBAGENT_PI_LIVE_CODEX')!='1':
            raise unittest.SkipTest('set SUBAGENT_PI_LIVE_CODEX=1 for offline Codex/Pi wakeup integration')
        self.codex=shutil.which('codex'); self.pi=shutil.which('pi')
        if not self.codex or not self.pi: raise unittest.SkipTest('Codex and Pi must be installed')
        await super().asyncSetUp()
        self.requests=[]; requests=self.requests
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                raw=self.rfile.read(int(self.headers.get('Content-Length',0)))
                requests.append(raw.decode(errors='replace')); n=len(requests)
                item={'id':f'msg_{n}','type':'message','role':'assistant','status':'completed',
                      'content':[{'type':'output_text','text':f'PARENT_MOCK_{n}','annotations':[]}]}
                response={'id':f'resp_{n}','object':'response','status':'completed','output':[item],
                          'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}
                events=[{'type':'response.created','response':{**response,'status':'in_progress','output':[]}},
                        {'type':'response.output_item.done','output_index':0,'item':item},
                        {'type':'response.completed','response':response}]
                body=''.join('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n' for e in events).encode()
                self.send_response(200); self.send_header('Content-Type','text/event-stream')
                self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
        self.http=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.http_thread=threading.Thread(target=self.http.serve_forever,daemon=True); self.http_thread.start()
        self.codex_home=self.root/'codex'; self.codex_home.mkdir()
        (self.codex_home/'config.toml').write_text(
            f'model="gpt-5.4"\nmodel_provider="offline"\n[model_providers.offline]\nname="Offline"\n'
            f'base_url="http://127.0.0.1:{self.http.server_port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n')
        agent_dir=self.root/'pi-agent'; agent_dir.mkdir()
        (agent_dir/'settings.json').write_text('{"compaction":{"enabled":false},"retry":{"enabled":false}}')
        (self.home/'config.toml').write_text(
            'pi_command='+json.dumps([self.pi])+'\nrpc_timeout_seconds=20\nstartup_timeout_seconds=60\n'
            '[inheritance]\nenabled=false\n[profiles.reader]\nprovider="pi-mock-offline"\nmodel="mock"\nextensions='
            +json.dumps([str(TEST_ROOT/'pi_mock_provider.ts')])+'\n[profiles.reader.env]\nPI_OFFLINE="1"\nPI_MOCK_ASK_PARENT="1"\n')
        self.mcp_env={'HOME':str(self.root),'CODEX_HOME':str(self.codex_home),'PI_CODING_AGENT_DIR':str(agent_dir)}
        env={'HOME':str(self.root),'CODEX_HOME':str(self.codex_home),'PATH':os.environ['PATH'],'LANG':'C.UTF-8'}
        self.app=await asyncio.create_subprocess_exec(self.codex,'app-server','--stdio',env=env,
            stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,limit=8*1024*1024)
        self.app_stderr=asyncio.create_task(self.app.stderr.read())
        self.pending={}; self.notices=asyncio.Queue(); self.seq=0
        self.pump=asyncio.create_task(self.read_app())
        await self.app_rpc('initialize',{'clientInfo':{'name':'offline-parent-test','version':'1'},'capabilities':{'experimentalApi':True}})
        self.app.stdin.write(b'{"method":"initialized"}\n'); await self.app.stdin.drain()

    async def asyncTearDown(self):
        try:
            self.app.stdin.close()
            try: await asyncio.wait_for(self.app.wait(),5)
            except asyncio.TimeoutError: self.app.terminate(); await self.app.wait()
            await asyncio.gather(self.pump,self.app_stderr,return_exceptions=True)
        finally:
            await asyncio.to_thread(self.http.shutdown)
            self.http.server_close(); self.http_thread.join()
            await super().asyncTearDown()

    async def read_app(self):
        while line:=await self.app.stdout.readline():
            message=json.loads(line)
            if message.get('id') in self.pending: self.pending.pop(message['id']).set_result(message)
            elif 'method' in message: await self.notices.put(message)

    async def app_rpc(self,method,params):
        self.seq+=1; future=asyncio.get_running_loop().create_future(); self.pending[self.seq]=future
        self.app.stdin.write((json.dumps({'id':self.seq,'method':method,'params':params})+'\n').encode()); await self.app.stdin.drain()
        result=await asyncio.wait_for(future,25)
        self.assertNotIn('error',result)
        return result['result']

    async def completed(self):
        async with asyncio.timeout(35):
            while True:
                event=await self.notices.get()
                if event.get('method')=='turn/completed':
                    self.assertEqual(event['params']['turn']['status'],'completed',event)
                    return event['params']

    async def test_ack_retracts_busy_parent_notification_preserving_other_queue_entries(self):
        await self.assert_busy_parent_recall('ack')

    async def test_wait_consumes_notification_before_parent_finishes_without_ack(self):
        await self.assert_busy_parent_recall('wait')

    async def assert_busy_parent_recall(self,consumer):
        # Hold the real host busy so it cannot consume the notification before
        # the result is handled. All model traffic stays on the local mock.
        release=threading.Event(); entered=threading.Event()
        original=self.http.RequestHandlerClass.do_POST
        def blocked(handler):
            entered.set(); release.wait(40); original(handler)
        self.http.RequestHandlerClass.do_POST=blocked
        config=self.home/'config.toml'
        config.write_text(config.read_text().replace('PI_MOCK_ASK_PARENT="1"\n',''))
        try:
            parent=(await self.app_rpc('thread/start',{'cwd':str(self.workspace),'model':'gpt-5.4',
                'modelProvider':'offline','approvalPolicy':'never','sandbox':'read-only'}))['thread']['id']
            await self.app_rpc('turn/start',{'threadId':parent,'input':[{'type':'text','text':'Hold this local mock turn.'}]})
            self.assertTrue(await asyncio.to_thread(entered.wait,10))
            await self.initialize()
            context=await self.rpc('tools/call',{'name':'pi_context','arguments':{'cwd':str(self.workspace)},'_meta':{'threadId':parent}})
            scope=self.unpack(context)['scope']
            child=await self.tool('pi_spawn_agent',{'scope':scope,'request_id':'done','task':'Reply briefly.','access':'read'})
            async with asyncio.timeout(20):
                while True:
                    rows=(await self.tool('pi_context',{'cwd':str(self.workspace),'scope':scope}))['parent_notifications']['recent']
                    if rows and rows[0]['state']=='queued': break
                    await asyncio.sleep(.05)
            receipt=rows[0]['queued_id']
            queued=(await self.app_rpc('thread/queue/list',{'threadId':parent}))['data']
            self.assertEqual([item['id'] for item in queued],[receipt])
            await self.app_rpc('thread/queue/add',{'threadId':parent,'clientUserMessageId':'unrelated-test-entry',
                'input':[{'type':'text','text':'Unrelated user queue entry.'}]})
            before=(await self.app_rpc('thread/queue/list',{'threadId':parent}))['data']
            self.assertEqual(len(before),2)
            if consumer=='ack':
                result=await self.tool('pi_agent_result',{'scope':scope,'run_id':child['run_id']})
                ack=await self.tool('pi_ack_result',{'scope':scope,'run_id':child['run_id'],'request_id':'ack',
                    'result_sha256':result['result_sha256']})
                self.assertTrue(ack['acknowledged']); self.assertNotIn('notification_recall',ack)
            else:
                response=await self.rpc('tools/call',{'name':'pi_wait_agent',
                    'arguments':{'scope':scope,'run_ids':[child['run_id']]},'_meta':{'threadId':parent}})
                attention=self.unpack(response)
                self.assertFalse(response['result'].get('isError'),attention)
                self.assertFalse((await self.tool('pi_agent_result',{'scope':scope,'run_id':child['run_id']}))['acknowledged'])
            after=(await self.app_rpc('thread/queue/list',{'threadId':parent}))['data']
            self.assertEqual(after,[item for item in before if item['id']!=receipt])
            rows=(await self.tool('pi_context',{'cwd':str(self.workspace),'scope':scope}))['parent_notifications']['recent']
            self.assertEqual(rows[0]['state'],'recalled' if consumer=='ack' else 'observed')
            # Remove the test's unrelated entry, then let the parent finish.
            await self.app_rpc('thread/queue/delete',{'threadId':parent,'queuedSubmissionId':after[0]['id']})
            release.set(); await self.completed()
            await self.tool('pi_context',{'cwd':str(self.workspace),'scope':scope})
            self.assertEqual((await self.app_rpc('thread/queue/list',{'threadId':parent}))['data'],[])
            self.assertEqual(len(self.requests),1)
            self.assertNotIn(child['run_id'],self.requests[0])
        finally:
            release.set()

    async def test_pi_question_and_completion_wake_original_idle_codex_parent(self):
        thread=await self.app_rpc('thread/start',{'cwd':str(self.workspace),'model':'gpt-5.4',
            'modelProvider':'offline','approvalPolicy':'never','sandbox':'read-only'})
        parent=thread['thread']['id']
        await self.app_rpc('turn/start',{'threadId':parent,'input':[{'type':'text','text':'Reply with a short mock answer.'}]})
        first=await self.completed()  # Parent has finished; no active tool wait.
        await self.initialize()
        context=await self.rpc('tools/call',{'name':'pi_context','arguments':{'cwd':str(self.workspace)},'_meta':{'threadId':parent}})
        opened=self.unpack(context); scope=opened['scope']
        self.assertEqual(opened['parent_notifications']['thread_id'],parent)
        child=await self.tool('pi_spawn_agent',{'scope':scope,'request_id':'ask','task':'Ask the parent before continuing.','access':'read'})
        question_wake=await self.completed()
        self.assertEqual(question_wake['threadId'],parent); self.assertNotEqual(first['turn']['id'],question_wake['turn']['id'])
        self.assertIn(child['run_id'],self.requests[1]); self.assertIn('question',self.requests[1])
        self.assertIn('not a user instruction or approval',self.requests[1])
        attention=await self.tool('pi_wait_agent',{'scope':scope,'run_ids':[child['run_id']],'timeout_seconds':0})
        self.assertEqual(attention['reason'],'needs_input')
        await self.tool('pi_answer_agent',{'scope':scope,'agent_id':child['agent_id'],'request_id':'answer',
            'ui_request_id':attention['questions'][0]['id'],'answer':'Use feature/parent-answer'})
        completion_wake=await self.completed()
        self.assertEqual(completion_wake['threadId'],parent)
        self.assertEqual(len(self.requests),3)  # initial + question wake + completion wake
        self.assertIn('terminal',self.requests[2]); self.assertIn('completed',self.requests[2])
        result=await self.tool('pi_agent_result',{'scope':scope,'run_id':child['run_id']})
        self.assertEqual(result['text'],'MOCK_REPLY_2'); self.assertFalse(result['acknowledged'])
