import test from "node:test";
import assert from "node:assert/strict";
import { SubagentSession } from "../../src/subagents/host/session.ts";
import { DEFAULT_CONFIG } from "../../src/appearance/config.ts";
import { fixture, sleep, status } from "../helpers/subagent-parking.mjs";

test("native session parks its helper silently and automatic boundaries do not restart an empty daemon", { timeout: 60000 }, async t => {
  const f = await fixture(t), warnings = [];
  const ctx = { ...f.ctx, mode: "rpc", isIdle: () => false, hasPendingMessages: () => false,
    ui: { notify: text => warnings.push(text), setStatus() {}, setWidget() {} } };
  const owner = new SubagentSession({ appendEntry() {}, sendMessage() {} }, f.runtime, ctx, f.dir,
    () => DEFAULT_CONFIG);
  try {
    assert.equal((await owner.execute("subagents_list_agents", {}, "list-before-idle", ctx)).isError, false);
    const deadline = Date.now() + 45000;
    while ((owner.syncState !== "parked" || owner.watching || status(f.runtime, f.state)) && Date.now() < deadline) {
      await owner.boundary({ type: "turn_end", outcome: "completed", entries: [] }, ctx);
      await owner.settled(ctx);
      await sleep(50);
    }
    assert.equal(owner.syncState, "parked"); assert.equal(owner.watching, undefined);
    assert.equal(owner.client.bridge, undefined, "the frontend-owned IPC process also exited");
    assert.equal(status(f.runtime, f.state), undefined); assert.deepEqual(warnings, []);
    for (const type of ["turn_end", "agent_before_settle"]) await owner.boundary({ type, outcome: "completed", entries: [] }, ctx);
    await owner.settled(ctx, true);
    assert.equal(status(f.runtime, f.state), undefined, "automatic parent events did not create a restart loop");
    assert.equal((await owner.execute("subagents_list_agents", {}, "list-after-idle", ctx)).isError, false);
    assert.ok(status(f.runtime, f.state).pid, "an explicit request wakes and reauthenticates the daemon");
    assert.deepEqual(warnings, []);
  } finally { await owner.close(); }
});
