import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";
import { cancelDuplicatePush } from "../../scripts/ci/cancel-duplicate-push.mjs";

const repository = "owner/metis-pi";
const base = `/repos/${repository}`;
const head = "a".repeat(40);
const mergeRef = "b".repeat(40);
const trustedRef = "c".repeat(40);
const policy = "d".repeat(40);
const sourcePath = `${base}/actions/runs/200`;
const pushPath = `${base}/actions/runs/100`;
const pullPath = `${base}/pulls/7`;

function fixture() {
  const repo = { id: 1, full_name: repository, default_branch: "main" };
  const workflow = { id: 2, path: ".github/workflows/ci.yml", state: "active" };
  const run = { repository: repo, head_repository: repo, workflow_id: 2, path: workflow.path,
    run_attempt: 1, status: "in_progress", head_branch: "feature", head_sha: head };
  const source = { ...run, id: 200, event: "pull_request", created_at: "2026-10-16T07:03:34Z" };
  const push = { ...run, id: 100, event: "push", created_at: "2026-10-16T07:03:24Z" };
  const pull = { number: 7, state: "open", mergeable: true, merge_commit_sha: mergeRef,
    head: { repo, ref: "feature", sha: head }, base: { repo, ref: "main" } };
  const validation = id => ({ run_id: id, run_attempt: 1, head_sha: head, name: "Pi 1.4.0", status: "in_progress", runner_id: 3 });
  const sourceJobs = [validation(200)];
  const pushJobs = [validation(100), { run_id: 100, run_attempt: 1, head_sha: head,
    name: "Check duplicate feature push", status: "completed", conclusion: "success" }];
  const contents = { [trustedRef]: policy, [head]: policy, [mergeRef]: policy };
  const calls = [], sleeps = [], logs = [];
  const f = { repo, workflow, source, push, pull, sourceJobs, pushJobs, contents, calls, sleeps, logs };
  const request = async (method, path, query) => {
    calls.push({ method, path, query });
    f.before?.(method, path, query);
    if (method === "POST") return;
    let value;
    if (path === base) value = repo;
    else if (path === `${base}/actions/workflows/ci.yml`) value = workflow;
    else if (path === sourcePath) value = source;
    else if (path === pushPath) value = push;
    else if (path === pullPath) value = pull;
    else if (path === `${base}/contents/${workflow.path}`) value = { type: "file", sha: contents[query.ref] };
    else if (path === `${sourcePath}/jobs`) value = { jobs: sourceJobs };
    else if (path === `${pushPath}/jobs`) value = { jobs: pushJobs };
    else if (path === `${base}/actions/workflows/2/runs`) value = { workflow_runs: [push] };
    else throw new Error(`Unexpected fixture request: ${method} ${path}`);
    return structuredClone(value);
  };
  f.request = request;
  f.run = () => cancelDuplicatePush({ repository, runId: 200, pullNumber: 7, trustedRef, mergeRef,
    request, sleep: async ms => { sleeps.push(ms); }, log: message => logs.push(message) });
  f.writes = () => calls.filter(c => c.method !== "GET");
  return f;
}

test("PR validation retires only the exact older internal feature push", async () => {
  const f = fixture();
  assert.equal(await f.run(), true);
  assert.deepEqual(f.writes(), [{ method: "POST", path: `${pushPath}/cancel`, query: undefined }]);
  assert.deepEqual(f.sleeps, []);
  assert.equal(f.calls.find(c => c.path.endsWith("/runs")).query.head_sha, head);
});

test("workflow CLI binds its PR event, merge snapshot and token at the HTTP boundary", async t => {
  const f = fixture();
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, "Bearer fixture-token");
      const url = new URL(req.url, "http://localhost");
      const value = await f.request(req.method, url.pathname, Object.fromEntries(url.searchParams));
      res.writeHead(req.method === "POST" ? 202 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    } catch {
      res.writeHead(500); res.end();
    }
  });
  t.after(() => server.close());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const eventPath = join(temporaryDirectory(t), "event.json");
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7 } }));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../scripts/ci/cancel-duplicate-push.mjs", import.meta.url))], {
    env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: "200", GITHUB_SHA: mergeRef,
      TRUSTED_CI_REF: trustedRef, GH_TOKEN: "fixture-token",
      GITHUB_API_URL: `http://127.0.0.1:${server.address().port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.equal(code, 0, stderr);
  assert.equal(f.writes().length, 1, stdout);
  assert.match(stdout, /Requested cancellation of duplicate feature push 100/);
});

test("source scope, PR state and all three CI policies must authorize cleanup", async t => {
  const cases = {
    "fork source": f => { f.source.head_repository = f.pull.head.repo = { id: 9, full_name: "fork/metis-pi" }; },
    "source manual rerun": f => { f.source.run_attempt = 2; },
    "dispatch source": f => { f.source.event = "workflow_dispatch"; },
    "other workflow": f => { f.source.workflow_id = 9; },
    "closed PR": f => { f.pull.state = "closed"; },
    "conflicted PR": f => { f.pull.mergeable = false; },
    "unknown mergeability": f => { f.pull.mergeable = null; },
    "new PR head": f => { f.pull.head.sha = "e".repeat(40); },
    "different merge snapshot": f => { f.pull.merge_commit_sha = "e".repeat(40); },
    "other base branch": f => { f.pull.base.ref = "release"; },
    "head changes CI policy": f => { f.contents[head] = "e".repeat(40); },
    "merge changes CI policy": f => { f.contents[mergeRef] = "e".repeat(40); },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    const f = fixture(); change(f);
    assert.equal(await f.run(), false);
    assert.deepEqual(f.writes(), []);
  });
});

test("target needs matching branch/head, first attempt, older creation and branch-only admission", async t => {
  const cases = {
    "default branch": f => { f.push.head_branch = "main"; },
    "different head": f => { f.push.head_sha = "e".repeat(40); },
    "newer push": f => { f.push.created_at = "2026-10-16T07:03:35Z"; },
    "manual rerun": f => { f.push.run_attempt = 2; },
    "PR target": f => { f.push.event = "pull_request"; },
    "foreign repository": f => { f.push.head_repository = { id: 9, full_name: "fork/metis-pi" }; },
    "tag with matching name and SHA": f => { f.pushJobs[1].conclusion = "skipped"; },
    "admission-only execution": f => { f.pushJobs.splice(0, 1); },
    "finished validation": f => { f.pushJobs[0].status = "completed"; },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    const f = fixture(); change(f);
    assert.equal(await f.run(), false);
    assert.deepEqual(f.writes(), []);
  });
});

test("bounded readiness waits for an allocated validation job, not the controller or admission", async () => {
  const f = fixture();
  let reads = 0;
  f.before = (_method, path) => {
    if (path === `${sourcePath}/jobs`) {
      reads++;
      f.sourceJobs[0].status = reads < 3 ? "queued" : "in_progress";
      f.sourceJobs[0].runner_id = reads < 3 ? 0 : 3;
    }
  };
  assert.equal(await f.run(), true);
  assert.deepEqual(f.sleeps, [2000, 2000]);
  const unavailable = fixture();
  unavailable.sourceJobs[0].name = "Retire duplicate feature push";
  assert.equal(await unavailable.run(), false);
  assert.deepEqual(unavailable.sleeps, [2000, 2000]);
  assert.deepEqual(unavailable.writes(), []);
});

test("live head, source cancellation and target rerun are rechecked before any mutation", async t => {
  for (const scenario of ["head changed", "source cancelled", "target rerun", "source job finished"]) await t.test(scenario, async () => {
    const f = fixture();
    let pulls = 0, sources = 0, jobs = 0;
    f.before = (_method, path) => {
      if (path === pullPath && ++pulls === 2 && scenario === "head changed") f.pull.head.sha = "e".repeat(40);
      if (path === sourcePath && ++sources === 2 && scenario === "source cancelled") f.source.status = "completed";
      if (path === pushPath && scenario === "target rerun") f.push.run_attempt = 2;
      if (path === `${sourcePath}/jobs` && ++jobs === 2 && scenario === "source job finished") f.sourceJobs[0].status = "completed";
    };
    assert.equal(await f.run(), false);
    assert.deepEqual(f.writes(), []);
  });
});

test("an unconfirmed cancellation is not retried or reported as definitely retaining the push", async () => {
  const f = fixture();
  f.before = method => { if (method === "POST") throw new Error("connection lost after sending"); };
  assert.equal(await f.run(), false);
  assert.equal(f.writes().length, 1);
  assert.match(f.logs[0], /unconfirmed/);
});

test("API failure retains full validation without exposing the API error body", async () => {
  const f = fixture();
  f.before = (_method, path) => { if (path === pullPath) throw new Error("secret token/body"); };
  assert.equal(await f.run(), false);
  assert.deepEqual(f.writes(), []);
  assert.equal(f.logs.length, 1);
  assert.doesNotMatch(f.logs[0], /secret|token|body/);
});
