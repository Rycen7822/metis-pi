import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const networkUrl = new URL('../../src/subagents/core/runtime/network.mjs', import.meta.url).href;
const probe = `
  const { configureNetwork } = await import(${JSON.stringify(networkUrl)});
  const dispatcher = configureNetwork(JSON.parse(process.argv[1]));
  try {
    const response = await fetch(process.argv[2], { signal: AbortSignal.timeout(5000) });
    const body = await response.text();
    let message;
    if (process.argv[3]) message = await new Promise((resolve, reject) => {
      const ws = new WebSocket(process.argv[3]);
      const timer = setTimeout(() => { ws.close(); reject(new Error('WebSocket timeout')); }, 5000);
      ws.onmessage = event => { clearTimeout(timer); resolve(event.data); ws.close(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket connection failed')); };
    });
    console.log(JSON.stringify({ status: response.status, body, message }));
  } finally { await dispatcher.close(); }
`;

async function fixture(t, tls = false) {
  let certificate, key;
  if (tls) {
    const dir = mkdtempSync(join(tmpdir(), 'metis-proxy-tls-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    certificate = join(dir, 'cert.pem');
    const keyPath = join(dir, 'key.pem');
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-keyout', keyPath, '-out', certificate,
      '-days', '1', '-subj', '/CN=subagent-proxy.invalid', '-addext', 'subjectAltName=DNS:subagent-proxy.invalid,IP:127.0.0.1'], { encoding: 'utf8' });
    if (generated.error?.code === 'ENOENT') { t.skip('OpenSSL is required only for the local TLS fixture'); return; }
    assert.equal(generated.status, 0, generated.stderr);
    key = readFileSync(keyPath);
  }
  const sockets = new Set();
  const track = server => server.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  });
  const handler = (_req, res) => res.end('http-ok');
  const origin = track(tls ? createHttpsServer({ key, cert: readFileSync(certificate) }, handler) : createServer(handler));
  origin.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(Buffer.concat([Buffer.from([0x81, 5]), Buffer.from('ws-ok')]));
    socket.once('data', () => socket.end(Buffer.from([0x88, 0])));
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const requests = [];
  const proxy = track(createServer((_req, res) => { res.writeHead(502); res.end(); }));
  proxy.on('connect', (req, client, head) => {
    requests.push(req.url);
    // Route a deliberately unresolvable hostname to the local fixture. A
    // successful response proves traffic went through this proxy, not DNS.
    const upstream = connect(origin.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy());
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([origin, proxy].map(server => new Promise(resolve => server.close(resolve))));
  });
  return { proxy: `http://127.0.0.1:${proxy.address().port}`, port: origin.address().port, requests, certificate };
}

async function runProbe(env, settings, httpUrl, wsUrl) {
  const base = Object.fromEntries(['PATH', 'HOME', 'LANG', 'SYSTEMROOT'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  const child = spawn(process.execPath, ['--input-type=module', '-e', probe, JSON.stringify(settings), httpUrl, ...(wsUrl ? [wsUrl] : [])], { env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout.trim());
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); }
}

for (const source of ['uppercase', 'lowercase', 'all-proxy', 'global-setting']) {
  test(`managed SDK HTTP and WebSocket use ${source} proxy`, async t => {
    const f = await fixture(t);
    const env = source === 'uppercase' ? { HTTP_PROXY: f.proxy, HTTPS_PROXY: f.proxy }
      : source === 'lowercase' ? { http_proxy: f.proxy, https_proxy: f.proxy, HTTP_PROXY: 'http://127.0.0.1:1', NO_PROXY: '*', no_proxy: '' }
      : source === 'all-proxy' ? { ALL_PROXY: f.proxy } : {};
    const settings = source === 'global-setting' ? { httpProxy: f.proxy } : {};
    const result = await runProbe(env, settings, `http://subagent-proxy.invalid:${f.port}/`, `ws://subagent-proxy.invalid:${f.port}/`);
    assert.deepEqual(result, { status: 200, body: 'http-ok', message: 'ws-ok' });
    assert.equal(f.requests.length, 2);
    assert.ok(f.requests.every(target => target === `subagent-proxy.invalid:${f.port}`));
  });
}

test('managed SDK HTTPS and WSS use HTTPS_PROXY with verified TLS', async t => {
  const f = await fixture(t, true);
  if (!f) return;
  const result = await runProbe({ HTTPS_PROXY: f.proxy, NODE_EXTRA_CA_CERTS: f.certificate }, {}, `https://subagent-proxy.invalid:${f.port}/`, `wss://subagent-proxy.invalid:${f.port}/`);
  assert.deepEqual(result, { status: 200, body: 'http-ok', message: 'ws-ok' });
  assert.equal(f.requests.length, 2);
});

test('NO_PROXY bypasses an unavailable proxy for HTTP and WebSocket', async t => {
  const f = await fixture(t);
  const result = await runProbe({ HTTP_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1' }, {}, `http://127.0.0.1:${f.port}/`, `ws://127.0.0.1:${f.port}/`);
  assert.deepEqual(result, { status: 200, body: 'http-ok', message: 'ws-ok' });
  assert.equal(f.requests.length, 0);
});

test('no proxy remains a direct connection', async t => {
  const f = await fixture(t);
  const result = await runProbe({}, {}, `http://127.0.0.1:${f.port}/`);
  assert.deepEqual(result, { status: 200, body: 'http-ok' });
  assert.equal(f.requests.length, 0);
});
