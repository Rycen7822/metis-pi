import { EnvHttpProxyAgent, install, setGlobalDispatcher } from 'undici';

// Managed children enter through the public SDK, not Pi's CLI bootstrap. Keep
// routing here so HTTP and WebSocket use the same proxy-aware implementation.
export function configureNetwork({ httpProxy, idleTimeoutMs = 300_000 } = {}) {
  if (typeof httpProxy === 'string' && httpProxy.trim()) {
    process.env.HTTP_PROXY ??= httpProxy.trim();
    process.env.HTTPS_PROXY ??= httpProxy.trim();
  }
  const http = process.env.http_proxy ?? process.env.HTTP_PROXY ?? process.env.all_proxy ?? process.env.ALL_PROXY;
  const https = process.env.https_proxy ?? process.env.HTTPS_PROXY ?? http;
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: http, httpsProxy: https, allowH2: false, proxyTunnel: true,
    headersTimeout: idleTimeoutMs, bodyTimeout: idleTimeoutMs,
  });
  setGlobalDispatcher(dispatcher);
  install();
  return dispatcher;
}
