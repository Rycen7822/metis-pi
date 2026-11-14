import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelPricing } from "../../src/condense/model-pricing.ts";
import { priceRefreshMarker, requestPriceRefresh } from "../../src/condense/refresh-prices.mjs";

const prices = (input = 2) => ({ input, output: input * 3, cacheRead: input / 10, cacheWrite: input });
const model = (id, provider = "vendor", cost = prices(0)) => ({ id, provider, api: "test", cost });
async function fixture(t, fetcher) {
  await mkdir(".work", { recursive: true });
  const dir = await mkdtemp(join(".work", "model-pricing-")), file = join(dir, "prices.json");
  let updated = Promise.withResolvers();
  const warnings = [];
  const sources = [join(dir, "models-store.json"), priceRefreshMarker(dir)];
  const create = fetcher => new ModelPricing({ file, sources, fetcher,
    changed: () => updated.resolve(), warning: message => warnings.push(message) });
  const pricing = create(fetcher);
  const instances = [pricing];
  t.after(async () => { for (const instance of instances) await instance.close(); await rm(dir, { recursive: true, force: true }); });
  return { pricing, file, dir, warnings, sources,
    wait: () => updated.promise,
    next: () => { updated = Promise.withResolvers(); },
    reopen: fetcher => { const instance = create(fetcher); instances.push(instance); return instance; },
  };
}

test("Pi quotes take priority, regex aliases preserve model qualifiers, and selected models are not mutated", { timeout: 5000 }, async t => {
  let downloads = 0;
  const f = await fixture(t, async () => { downloads++; throw new Error("offline"); });
  const native = model("proto-4.1-pro", "vendor", prices(2));
  f.pricing.start([native]);
  const request = model("vendor/proto-4-1-pro-20261114");
  assert.equal(f.pricing.get(request).cost.input, 2);
  assert.equal(f.pricing.get(request).pricing, "pi");
  assert.equal(request.cost.input, 0);
  const older = model(native.id, native.provider, prices(1));
  assert.equal(f.pricing.get(older).cost.input, 2, "new registry prices override an older active Model object");
  assert.equal(older.cost.input, 1);
  await f.wait();
  assert.equal(downloads, 0, "Pi catalog matches do not need the website");
  const saved = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(saved.prices[0].source, "pi");
  f.next();
  assert.equal(f.pricing.get(model("proto-4.1-mini")).pricing, "pending");
  await f.wait();
  assert.equal(f.pricing.get(model("proto-4.1-mini")).cost.input, 0, "pro must never match mini");
  assert.equal(downloads, 1);
});

test("models.dev prices persist until a source update, with context tiers and live Pi priority", { timeout: 5000 }, async t => {
  let downloads = 0;
  const f = await fixture(t, async () => {
    downloads++;
    return new Response(JSON.stringify({ vendor: { api: "https://api.vendor.invalid", models: {
      "proto-4.1-pro": { id: "proto-4.1-pro", cost: { input: 2, output: 6, cache_read: 0.2,
        tiers: [{ input: 4, tier: { type: "context", size: 100000 } }] } },
      "proto-4.1-mini": { id: "proto-4.1-mini", cost: { input: 1, output: 3, cache_read: 0.1 } },
    } } }));
  });
  const stale = f.reopen(async () => { throw new Error("Pi-only owner must not fetch"); });
  stale.start([model("unrelated", "vendor", prices(1))]);
  await f.wait();
  f.next();
  f.pricing.start([]);
  const request = model("proto-4.1-pro");
  assert.equal(f.pricing.get(request).pricing, "pending", "no price-network wait in synchronous lookup");
  await f.wait();
  assert.equal(downloads, 1);
  assert.equal(f.pricing.get(request).cost.input, 2);
  assert.equal(f.pricing.get(request, 200000).cost.input, 4);
  assert.equal(f.pricing.get(request, 200000).cost.output, 6, "partial tiers inherit their unchanged price fields");
  assert.equal(f.pricing.get(request, 200000).cost.cacheRead, 0.2);
  assert.equal(f.pricing.get(request).pricing, "models.dev");
  const saved = JSON.parse(await readFile(f.file, "utf8"));
  assert.ok(saved.fetchedAt > 0);
  assert.equal(saved.prices.length, 2);
  f.next();
  stale.start([model("unrelated", "vendor", prices(2))]);
  await f.wait();
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).prices.filter(row => row.source === "models.dev").length, 2,
    "an older Pi-only owner must not overwrite a website snapshot populated by another instance");
  await f.pricing.close();
  f.next();
  const restored = f.reopen(async () => { throw new Error("fresh cache must not fetch"); });
  restored.start([model("proto-4.1-mini", "vendor", prices(0.5))]);
  assert.equal(restored.get(model("proto-4.1-mini")).cost.input, 0.5);
  restored.get(request);
  await f.wait();
  assert.equal(restored.get(request, 200000).cost.input, 4);
  assert.equal(f.warnings.length, 0);
  const clock = Date.now;
  try {
    Date.now = () => clock() + 30 * 86400000;
    for (let i = 0; i < 20; i++) {
      assert.equal(await restored.checkSources(), false);
      restored.get(request);
    }
    assert.equal(downloads, 1, "elapsed days alone do not refresh the website");
  } finally { Date.now = clock; }
});

test("conflicting gateway quotes and an unavailable website use fallback without repeated hot-path requests", { timeout: 5000 }, async t => {
  let downloads = 0;
  const f = await fixture(t, async () => { downloads++; throw new Error("unavailable"); });
  f.pricing.start([model("proto-4.1", "gateway-one", prices(1)), model("proto-4.1", "gateway-two", prices(2))]);
  const request = model("proto-4.1", "unknown-gateway");
  f.pricing.get(request);
  await f.wait();
  for (let i = 0; i < 20; i++) assert.equal(f.pricing.get(request), request);
  assert.equal(downloads, 1);
  assert.equal(f.warnings.length, 1);
  await f.pricing.close();
  f.next();
  const reopened = f.reopen(async () => { downloads++; throw new Error("must respect the recorded lookup generation"); });
  reopened.start([]);
  reopened.get(request);
  await f.wait();
  assert.equal(downloads, 1, "restarting Pi does not retry a failed website lookup for the same source version");
});

test("directory and extension-install changes each allow one refresh, including retry after a failed generation", { timeout: 5000 }, async t => {
  let downloads = 0;
  const f = await fixture(t, async () => {
    downloads++;
    if (downloads === 2) throw new Error("temporary outage");
    return new Response(JSON.stringify({ vendor: { models: {
      proto: { id: "proto", cost: { input: downloads + 1, output: 6, cache_read: 0.2 } },
    } } }));
  });
  const request = model("proto");
  f.pricing.start([]);
  f.pricing.get(request);
  await f.wait();
  assert.equal(f.pricing.get(request).cost.input, 2);
  await writeFile(f.sources[0], JSON.stringify({ updatedCatalog: true }));
  f.next();
  assert.equal(await f.pricing.checkSources(), true);
  f.pricing.start([]);
  f.pricing.acknowledgeSources();
  await f.wait();
  assert.equal(downloads, 2);
  assert.equal(f.pricing.get(request).cost.input, 2, "failed refresh retains the existing price snapshot");
  for (let i = 0; i < 10; i++) {
    assert.equal(await f.pricing.checkSources(), false);
    f.pricing.get(request);
  }
  assert.equal(downloads, 2, "no timer or ordinary price lookup retries the failed generation");
  await requestPriceRefresh(f.dir);
  f.next();
  assert.equal(await f.pricing.checkSources(), true);
  f.pricing.start([]);
  f.pricing.acknowledgeSources();
  await f.wait();
  assert.equal(downloads, 3);
  assert.equal(f.pricing.get(request).cost.input, 4);
  assert.equal(await f.pricing.checkSources(), false);
});

test("a background website lookup cannot acknowledge a Pi registry reload that has not happened", { timeout: 5000 }, async t => {
  let downloads = 0;
  const f = await fixture(t, async () => {
    downloads++;
    return new Response(JSON.stringify({ vendor: { models: { proto: { id: "proto", cost: { input: 2, output: 6 } } } } }));
  });
  f.pricing.start([]);
  await f.wait();
  await writeFile(f.sources[0], JSON.stringify({ newerCatalog: true }));
  f.next();
  f.pricing.get(model("proto"));
  await f.wait();
  assert.equal(downloads, 1);
  assert.equal(await f.pricing.checkSources(), true, "observing a source in a website task does not consume the native reload");
  f.next();
  f.pricing.start([]);
  f.pricing.acknowledgeSources();
  await f.wait();
  assert.equal(await f.pricing.checkSources(), false);
  assert.equal(downloads, 1, "acknowledging the native snapshot does not re-download an already checked generation");
});

test("a late old-source writer cannot roll back the current source's completed lookup", { timeout: 5000 }, async t => {
  const started = Promise.withResolvers(), response = Promise.withResolvers();
  const f = await fixture(t, () => { started.resolve(); return response.promise; });
  const catalog = () => new Response(JSON.stringify({ vendor: { models: { proto: { cost: { input: 2, output: 6 } } } } }));
  const clock = Date.now;
  let now = clock();
  Date.now = () => now;
  try {
    f.pricing.start([]);
    f.pricing.get(model("proto"));
    await started.promise;
    await writeFile(f.sources[0], JSON.stringify({ newerCatalog: true }));
    f.next();
    const current = f.reopen(async () => catalog());
    current.start([]);
    current.get(model("proto"));
    await f.wait();
    const key = JSON.parse(await readFile(f.file, "utf8")).refreshKey;
    now += 10;
    f.next();
    response.resolve(catalog());
    await f.wait();
    assert.notEqual(JSON.parse(await readFile(f.file, "utf8")).refreshKey, key, "the old-source request really completed later");
    f.next();
    current.start([]);
    await f.wait();
    assert.equal(JSON.parse(await readFile(f.file, "utf8")).refreshKey, key,
      "another source's later timestamp cannot invalidate this source's successful lookup");
  } finally { Date.now = clock; }
});

test("shutdown aborts and joins an outstanding catalog request", { timeout: 5000 }, async t => {
  const started = Promise.withResolvers();
  let aborted = false;
  const f = await fixture(t, (_url, { signal }) => new Promise((_, reject) => {
    started.resolve();
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
  }));
  f.pricing.start([]);
  f.pricing.get(model("unknown"));
  await started.promise;
  assert.equal(f.pricing.get(model("unknown")).pricing, "pending", "an in-flight lookup is not a completed missing-price result");
  await f.pricing.close();
  assert.equal(aborted, true);
  assert.equal(f.warnings.length, 0);
});
