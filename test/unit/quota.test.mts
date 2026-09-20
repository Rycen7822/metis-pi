// quota.test.mts — Codex quota: normalize math, app-server protocol against a
// mock child (initialize → initialized → account/rateLimits/read), and the
// refresh-store lifecycle. Spec 8 + 17.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { normalizeAppServerRateLimits } from "../../src/quota/normalize-codex.ts";
import { queryCodexQuota, QuotaError, redactErrorBody } from "../../src/quota/codex-app-server.ts";
import { QuotaStore } from "../../src/quota/quota-store.ts";
import { formatQuotaLine, remainingPercent } from "../../src/quota/types.ts";

test("normalize: remaining is derived from used (never echoed, never swapped)", () => {
  const snap = normalizeAppServerRateLimits({
    rateLimits: {
      planType: "pro",
      primary: { usedPercent: 18.25, windowDurationMins: 300, resetsAt: 123 },
      secondary: { usedPercent: 100, windowDurationMins: 10080 },
      credits: { hasCredits: true, unlimited: false, balance: "$0.00" },
    },
  }, 42);
  assert.equal(snap?.primary?.usedPercent, 18.25);
  assert.equal(snap?.primary?.remainingPercent, 81.75);
  assert.equal(snap?.secondary?.usedPercent, 100);
  assert.equal(snap?.secondary?.remainingPercent, 0);
  assert.deepEqual(snap?.credits, { hasCredits: true, unlimited: false, balance: "$0.00" });
  assert.equal(snap?.planType, "pro");
});

test("normalize: missing/invalid shapes degrade to no-data, never NaN", () => {
  assert.equal(normalizeAppServerRateLimits(undefined, 1), undefined);
  assert.equal(normalizeAppServerRateLimits({}, 1), undefined);
  assert.equal(normalizeAppServerRateLimits({ rateLimits: { primary: { usedPercent: Number.NaN } } }, 1), undefined);
  assert.equal(normalizeAppServerRateLimits({ rateLimits: { primary: "18%" } }, 1), undefined);
  assert.equal(normalizeAppServerRateLimits({ rateLimits: [] }, 1), undefined);
});

test("formatQuotaLine: both windows / primary only / unlimited / none", () => {
  assert.equal(
    formatQuotaLine({ capturedAt: 1, primary: { usedPercent: 18, remainingPercent: 82, windowMinutes: 300 }, secondary: { usedPercent: 36, remainingPercent: 64, windowMinutes: 10080 } }, false),
    "Codex 5h 82% · week 64%",
  );
  assert.equal(
    formatQuotaLine({ capturedAt: 1, primary: { usedPercent: 18, remainingPercent: 82, windowMinutes: 300 } }, false),
    "Codex 5h 82%",
  );
  assert.equal(formatQuotaLine({ capturedAt: 1, credits: { hasCredits: true, unlimited: true } }, false), "Codex ∞");
  assert.equal(formatQuotaLine(undefined, true), undefined);
  assert.equal(formatQuotaLine({ capturedAt: 1 }, false), "Codex —", "present-but-empty snapshot renders —, never a fake 0%");
});

test("redactErrorBody strips Bearer tokens and access_token fields", () => {
  const redacted = redactErrorBody('auth failed Bearer sk-abc123; {"access_token":"super-secret"}');
  assert.ok(!redacted.includes("sk-abc123"));
  assert.ok(!redacted.includes("super-secret"));
  assert.match(redacted, /Bearer <redacted>/);
  assert.match(redacted, /"access_token":"<redacted>"/);
});

/** Mock child process speaking the newline-delimited JSON-RPC protocol. */
function mockChild(script) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { writable: true, write: (chunk) => { child.written ??= []; child.written.push(chunk); }, end: () => { child.ended = true; } };
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.setEncoding = () => {};
  queueMicrotask(() => {
    child.emit("spawn");
    script(child);
  });
  return child;
}

test("protocol: initialize → initialized → account/rateLimits/read, then dispose", async () => {
  let respondToRateLimits;
  const child = mockChild((c) => {
    c.on("written", () => {});
  });
  // Respond to each request line as it is written.
  const respond = (payload) => {
    if (payload.method === "initialize") {
      child.stdout.emit("data", `${JSON.stringify({ id: payload.id, result: { userAgent: "x" } })}\n`);
    } else if (payload.method === "account/rateLimits/read") {
      respondToRateLimits = () => child.stdout.emit("data", `${JSON.stringify({
        id: payload.id,
        result: { rateLimits: { planType: "pro", primary: { usedPercent: 10, windowDurationMins: 300 } } },
      })}\n`);
    }
  };
  child.stdin.write = (chunk) => {
    (child.written ??= []).push(chunk);
    for (const line of chunk.split("\n").filter(Boolean)) respond(JSON.parse(line));
  };
  const promise = queryCodexQuota({ timeoutMs: 2000, spawnFn: () => child, clientVersion: "test" });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(respondToRateLimits, "initialize already answered; read request is in flight");
  const initPayload = JSON.parse(child.written[0]);
  assert.equal(initPayload.method, "initialize");
  assert.equal(initPayload.params.clientInfo.name, "pi_codex_appearance");
  assert.equal(initPayload.params.capabilities.experimentalApi, false);
  const initDone = child.written[1];
  assert.deepEqual(JSON.parse(initDone), { method: "initialized" }, "initialized notification");
  const readPayload = JSON.parse(child.written[2]);
  assert.equal(readPayload.method, "account/rateLimits/read");
  respondToRateLimits();
  const snapshot = await promise;
  assert.equal(snapshot.primary?.remainingPercent, 90);
  assert.equal(child.killed, true, "child disposed after the one-shot query");
  assert.equal(child.ended, true);
});

test("protocol failure classes: spawn error, rpc error, early exit, no data", async () => {
  await assert.rejects(
    queryCodexQuota({ timeoutMs: 1000, spawnFn: () => { throw new Error("ENOENT"); } }),
    (e) => e instanceof QuotaError && e.errorClass === "codex-missing",
  );

  const rpcChild = mockChild(() => {});
  rpcChild.stdin.write = (chunk) => {
    const payload = JSON.parse(chunk);
    if (payload.method === "initialize") rpcChild.stdout.emit("data", `${JSON.stringify({ id: payload.id, result: {} })}\n`);
    else if (payload.method === "account/rateLimits/read") rpcChild.stdout.emit("data", `${JSON.stringify({ id: payload.id, error: { message: "not logged in" } })}\n`);
  };
  await assert.rejects(
    queryCodexQuota({ timeoutMs: 1000, spawnFn: () => rpcChild }),
    (e) => e instanceof QuotaError && e.errorClass === "rpc-error" && e.message.includes("not logged in"),
  );

  const exitChild = mockChild((c) => { c.emit("exit", 1, null); });
  await assert.rejects(
    queryCodexQuota({ timeoutMs: 1000, spawnFn: () => exitChild }),
    (e) => e instanceof QuotaError && e.errorClass === "early-exit",
  );

  const noDataChild = mockChild(() => {});
  noDataChild.stdin.write = (chunk) => {
    const payload = JSON.parse(chunk);
    if (payload.method === "initialize") noDataChild.stdout.emit("data", `${JSON.stringify({ id: payload.id, result: {} })}\n`);
    else if (payload.method === "account/rateLimits/read") noDataChild.stdout.emit("data", `${JSON.stringify({ id: payload.id, result: { rateLimits: {} } })}\n`);
  };
  await assert.rejects(
    queryCodexQuota({ timeoutMs: 1000, spawnFn: () => noDataChild }),
    (e) => e instanceof QuotaError && e.errorClass === "no-data",
  );
});

test("QuotaStore: coalesced refresh, last-good + stale, bounded error class", async () => {
  let calls = 0;
  let fail = false;
  const store = new QuotaStore({
    timeoutMs: 1000,
    query: async () => {
      calls += 1;
      if (fail) throw Object.assign(new Error("down"), { errorClass: "rpc-error" });
      return { capturedAt: calls, primary: { usedPercent: 10, remainingPercent: 90, windowMinutes: 300 } };
    },
  });
  assert.equal(store.state().quota, undefined);
  const p1 = store.refresh();
  const p2 = store.refresh(); // concurrent → coalesced
  await Promise.all([p1, p2]);
  assert.equal(calls, 1, "single in-flight refresh");
  assert.equal(store.state().quota?.primary?.remainingPercent, 90);
  assert.equal(store.state().stale, false);

  fail = true;
  await store.refresh();
  assert.equal(store.state().stale, true, "failure marks the snapshot stale");
  assert.equal(store.state().lastErrorClass, "rpc-error");
  assert.equal(store.state().quota?.primary?.remainingPercent, 90, "last-good snapshot kept");

  fail = false;
  await store.refresh();
  assert.equal(store.state().stale, false);
  assert.equal(store.state().lastErrorClass, undefined);
  store.reset();
  assert.equal(store.state().quota, undefined, "session boundary drops the snapshot");
});
