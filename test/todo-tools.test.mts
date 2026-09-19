// codex-todo tools + commands tests — fake pi host, tmpdir store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTodoStore } from "../src/todo/store.ts";
import { createTodoToolHandlers, renderListText, type CodexTodoSystem } from "../src/todo/tools.ts";
import { registerCodexTodoCommands } from "../src/todo/commands.ts";

const makeSystem = (dir: string) => {
  let turn = 3;
  let changedCount = 0;
  const system: CodexTodoSystem = {
    store: openTodoStore(dir),
    turn: () => turn,
    changed: () => { changedCount += 1; },
  };
  return { system, turns: { bump: () => { turn += 1; } }, changed: () => changedCount };
};

type Execute = ReturnType<typeof createTodoToolHandlers>;

test("add returns created ids and fires changed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-todo-tools-"));
  try {
    const { system, changed } = makeSystem(dir);
    const exec = createTodoToolHandlers(system, () => dir);
    const r = await exec({ action: "add", tasks: [{ title: "plan schema" }, { title: "write store", parentId: 1 }] }, "sess-A");
    assert.match(r.content[0].text, /added 2 task\(s\): #1 plan schema, #2 write store/);
    assert.equal(changed(), 1);
    const list = await exec({ action: "list" }, "sess-A");
    assert.match(list.content[0].text, /Todos: 0\/2 done/);
    assert.match(list.content[0].text, /○ plan schema/); // ids hidden until a blockedBy edge exists
    assert.match(list.content[0].text, /○ write store/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validation errors throw with self-correcting messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-todo-tools-"));
  try {
    const { system } = makeSystem(dir);
    const exec = createTodoToolHandlers(system, () => dir);
    await exec({ action: "add", tasks: [{ title: "parent" }, { title: "child", parentId: 1 }] }, "s");
    await assert.rejects(() => exec({ action: "add", tasks: [{ title: "PARENT" }] }, "s"), /duplicate title/);
    await assert.rejects(() => exec({ action: "claim", id: 99 }, "s"), /not found/);
    // The completion gate blocks BOTH unfinished subtasks and missing evidence.
    await assert.rejects(() => exec({ action: "complete", id: 1, evidence: "done" }, "s"), /unfinished subtasks/);
    await assert.rejects(() => exec({ action: "complete", id: 2 }, "s"), /evidence required/);
    await exec({ action: "complete", id: 2, evidence: "child done" }, "s");
    const ok = await exec({ action: "complete", id: 1, evidence: "all done" }, "s");
    assert.match(ok.content[0].text, /completed #1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no-change returns a plain result, not an error (anti-retry-loop)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-todo-tools-"));
  try {
    const { system } = makeSystem(dir);
    const exec = createTodoToolHandlers(system, () => dir);
    await exec({ action: "add", tasks: [{ title: "a" }] }, "s");
    // Releasing a task that was never claimed: the model reports "no change",
    // the tool returns it as a normal result — an error here would make the
    // model re-issue the identical call in a loop (rpiv-todo's lesson).
    const noop = await exec({ action: "release", id: 1 }, "s");
    assert.match(noop.content[0].text, /no change/i);
    // Self-dependency is a validation error with a named reason (thrown, so
    // the model corrects itself rather than looping).
    await assert.rejects(() => exec({ action: "addBlockedBy", id: 1, blockedBy: 1 }, "s"), /itself/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim/release ownership with force path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-todo-tools-"));
  try {
    const { system } = makeSystem(dir);
    const exec = createTodoToolHandlers(system, () => dir);
    await exec({ action: "add", tasks: [{ title: "a" }] }, "s");
    await exec({ action: "claim", id: 1 }, "agent-A");
    await assert.rejects(() => exec({ action: "release", id: 1 }, "agent-B"), /force to override/);
    await assert.rejects(() => exec({ action: "claim", id: 1 }, "agent-B"), /retry with force/);
    const forced = await exec({ action: "claim", id: 1, force: true }, "agent-B");
    assert.match(forced.content[0].text, /claimed #1 for agent-B/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("complete gates on evidence files existing on disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-todo-tools-"));
  try {
    const { system } = makeSystem(dir);
    const exec = createTodoToolHandlers(system, () => dir);
    await exec({ action: "add", tasks: [{ title: "a" }] }, "s");
    writeFileSync(join(dir, "proof.txt"), "ok", "utf8");
    await assert.rejects(
      () => exec({ action: "complete", id: 1, evidence: "done", evidenceFiles: ["missing.txt"] }, "s"),
      /evidence files do not exist — missing\.txt/,
    );
    const ok = await exec({ action: "complete", id: 1, evidence: "proof written", evidenceFiles: ["proof.txt"] }, "s");
    assert.match(ok.content[0].text, /completed #1/);
    const state = system.store.read();
    assert.equal(state.tasks[0].evidence, "proof written");
    assert.equal(state.tasks[0].completedAtTurn, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderListText shows claims and next suggestion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-todo-tools-"));
  try {
    const { system } = makeSystem(dir);
    const exec = createTodoToolHandlers(system, () => dir);
    await exec({ action: "add", tasks: [{ title: "a" }, { title: "b" }, { title: "c" }] }, "s");
    await exec({ action: "claim", id: 2 }, "agent-X");
    const text = renderListText(system.store.read(), "s");
    assert.match(text, /○ a/);
    assert.match(text, /◐ b \[agent-X\]/);
    assert.match(text, /next: #1/);
    const mine = renderListText(system.store.read(), "agent-X");
    assert.match(mine, /\[mine\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blockedBy actions and blocked marker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-todo-tools-"));
  try {
    const { system } = makeSystem(dir);
    const exec = createTodoToolHandlers(system, () => dir) as Execute;
    await exec({ action: "add", tasks: [{ title: "a" }, { title: "b" }] }, "s");
    const r = await exec({ action: "addBlockedBy", id: 2, blockedBy: 1 }, "s");
    assert.match(r.content[0].text, /#2 is now blocked by #1/);
    const list = await exec({ action: "list" }, "s");
    assert.match(list.content[0].text, /⚠︎ #2 b/);
    await assert.rejects(() => exec({ action: "addBlockedBy", id: 2, blockedBy: 2 }, "s"), /itself/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commands: /todos notifies the list; /todos-doctor reports status and gc", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-todo-tools-"));
  try {
    const { system } = makeSystem(dir);
    const notices: string[] = [];
    const fakePi = {
      registerCommand: (_name: string, opts: { handler: (args: string, ctx: unknown) => void }) => {
        fakePi.handlers.push(opts.handler);
      },
      handlers: [] as ((args: string, ctx: unknown) => void)[],
    };
    registerCodexTodoCommands(fakePi, { system, notify: (t) => notices.push(t) });
    assert.equal(fakePi.handlers.length, 2);

    const ctx = { ui: { notify: (t: string) => notices.push(t) } };
    fakePi.handlers[0]("", ctx); // /todos with no tasks
    assert.match(notices[0], /no tasks yet/);

    const exec = createTodoToolHandlers(system, () => dir);
    await exec({ action: "add", tasks: [{ title: "a" }] }, "s");
    fakePi.handlers[0]("", ctx);
    assert.match(notices[1], /Todos: 0\/1 done/);

    fakePi.handlers[1]("status", ctx); // doctor
    assert.match(notices[2], /codex-todo doctor/);
    assert.match(notices[2], /tasks: 1/);
    fakePi.handlers[1]("gc", ctx);
    assert.match(notices[3], /gc: nothing eligible/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
