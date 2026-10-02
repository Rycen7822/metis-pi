#!/usr/bin/env python3
"""Local streamable-HTTP MCP server for bridge tests. Binds 127.0.0.1 only.

Stage evidence goes to FAKE_MCP_HTTP_EVENTS (JSON lines), so tests can prove a
tools/call was RECEIVED and headers were FLUSHED before asserting deadline,
cancel or close behavior on the body phase. `hang_body_json` and
`hang_body_sse` deliberately keep the connection open after the headers, which
is exactly the phase the bridge's exchange lifecycle must terminate.

Modes (FAKE_MCP_HTTP_MODE):
  normal|headers_then_hang|slow_json|bad_status|hang_body_json|hang_body_sse  legacy 2025-06-18
  modern          strict 2026-07-28: rejects requests missing MCP-Protocol-Version,
                  Mcp-Method, (tools/call) Mcp-Name, or modern params._meta
  modern_hang_json modern + hang_body_json behavior
  legacy_only     strict modern violation on server/discover (HTTP 404), proving the
                  endpoint is legacy-only so an auto client may fall back

FAKE_MCP_SESSION_EXPIRE_AFTER=N: legacy mode; the N-th request that carries a
session id gets HTTP 404 (expired session), later re-initialized sessions work.
FAKE_MCP_HEADER_TOOLS=1: adds the x-mcp-header fixture tools (valid + invalid).
FAKE_MCP_DISCOVER_REJECT: how server/discover fails, for era-detection tests:
  legacy400|modern400|modern400_nocommon|mismatch400 (-32020)|capability400
  (-32021) -> HTTP 400 with the matching JSON-RPC error body;
  inband32020|inband32601 -> the same over HTTP 200;
  or a bare status code (401/403/429/503) with an empty body.
FAKE_MCP_DISCOVER_MALFORMED=1: server/discover replies a DiscoverResult without
  resultType/supportedVersions.
FAKE_MCP_REDIRECT_PLAN: '|'-separated '<status>:<target>' hops, consumed one
  per POST; a target starting with '/' stays same-origin.
"""
from __future__ import annotations
import base64
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODE = os.environ.get('FAKE_MCP_HTTP_MODE', 'normal')
EVENTS = os.environ.get('FAKE_MCP_HTTP_EVENTS')
CALL_LOG = os.environ.get('FAKE_MCP_HTTP_CALL_LOG')
EXPIRE_AFTER = int(os.environ.get('FAKE_MCP_SESSION_EXPIRE_AFTER', '0'))
MODERN_VERSION = '2026-07-28'
MODERN_META_KEY = 'io.modelcontextprotocol/protocolVersion'

def event(kind, **kw):
    if EVENTS:
        with open(EVENTS, 'a') as f:
            f.write(json.dumps({'event': kind, 't': time.time(), **kw}) + '\n')

def log_call(name):
    if CALL_LOG:
        with open(CALL_LOG, 'a') as f:
            f.write(name + '\n')

TOOLS = [
    {"name": "search", "description": "Search things",
     "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"],
                     "additionalProperties": False},
     "annotations": {"readOnlyHint": True}},
    {"name": "publish", "description": "Publish content",
     "inputSchema": {"type": "object", "properties": {"body": {"type": "string"}}}, "required": ["body"]},
    {"name": "hdr", "description": "Header-mirroring tool",
     "inputSchema": {"type": "object", "properties": {
         "trace_id": {"type": "string", "x-mcp-header": "trace-id"},
         "count": {"type": "integer", "x-mcp-header": "count"},
         "flag": {"type": "boolean", "x-mcp-header": "x-flag"}},
         "required": ["trace_id"], "additionalProperties": False},
     "annotations": {"readOnlyHint": True}},
]
if os.environ.get('FAKE_MCP_HEADER_TOOLS') == '1':
    TOOLS = TOOLS + [
        {"name": "badhdr_array", "description": "array-typed header param",
         "inputSchema": {"type": "object", "properties": {"v": {"type": "array", "items": {"type": "string"}, "x-mcp-header": "arr"}}}},
        {"name": "badhdr_dup", "description": "duplicate header names",
         "inputSchema": {"type": "object", "properties": {"a": {"type": "string", "x-mcp-header": "dup"},
                                                         "b": {"type": "string", "x-mcp-header": "DUP"}}}},
        {"name": "badhdr_ctrl", "description": "control chars in annotation",
         "inputSchema": {"type": "object", "properties": {"v": {"type": "string", "x-mcp-header": "bad\nheader"}}}},
        {"name": "badhdr_empty", "description": "empty annotation",
         "inputSchema": {"type": "object", "properties": {"v": {"type": "string", "x-mcp-header": ""}}}},
        {"name": "badhdr_ref", "description": "$ref dynamic path",
         "inputSchema": {"type": "object", "properties": {"v": {"$ref": "#/definitions/x", "x-mcp-header": "r"}}}},
        {"name": "badhdr_oneof", "description": "oneOf dynamic path",
         "inputSchema": {"type": "object", "properties": {"v": {"oneOf": [{"type": "string"}], "x-mcp-header": "o"}}}},
        {"name": "badhdr_items_nested", "description": "annotation under items.properties",
         "inputSchema": {"type": "object", "properties": {"rows": {"type": "array", "items": {
             "type": "object", "properties": {"name": {"type": "string", "x-mcp-header": "Row"}}}}}}},
    ]


def decode_header_value(v):
    """Mirror of the MCP 2026-07-28 client encoder: strict servers must decode
    `=?base64?...?=` values before comparing them with the JSON body."""
    if v.startswith('=?base64?') and v.endswith('?='):
        try:
            return base64.b64decode(v[len('=?base64?'):-2]).decode('utf-8')
        except Exception:
            return v
    return v


TOOLS = TOOLS + [
    {"name": "hdr_nested", "description": "Nested header-mirroring tool",
     "inputSchema": {"type": "object", "properties": {
         "context": {"type": "object", "properties": {
             "region": {"type": "string", "x-mcp-header": "Region"}}}}},
     "annotations": {"readOnlyHint": True}},
    {"name": "搜索", "description": "Non-ASCII tool name",
     "inputSchema": {"type": "object", "properties": {}},
     "annotations": {"readOnlyHint": True}},
]

DISCOVER_MALFORMED = os.environ.get('FAKE_MCP_DISCOVER_MALFORMED') == '1'
# Redirect plan: '|'-separated hops, consumed one per incoming POST; each entry
# is '<status>:<target>' where a target starting with '/' stays same-origin.
REDIRECT_PLAN = [h for h in os.environ.get('FAKE_MCP_REDIRECT_PLAN', '').split('|') if h]
DISCOVER_REJECT = None
_reject = os.environ.get('FAKE_MCP_DISCOVER_REJECT')
if _reject:
    def _err(code, supported=None):
        err = {"code": code, "message": "unsupported protocol version"}
        if supported is not None:
            err["data"] = {"supported": supported}
        return {"jsonrpc": "2.0", "id": 0, "error": err}
    DISCOVER_REJECT = {
        'legacy400': (400, _err(-32601)),
        'modern400': (400, _err(-32022, ["2026-07-28", "2025-06-18"])),
        'modern400_nocommon': (400, _err(-32022, ["1999-01-01"])),
        'mismatch400': (400, _err(-32020)),            # HeaderMismatch: modern, no fallback
        'capability400': (400, _err(-32021)),          # MissingRequiredClientCapability: modern, no fallback
        'inband32020': (200, _err(-32020)),            # in-band modern error on HTTP 200
        'inband32601': (200, _err(-32601)),            # in-band legacy-style method-not-found
    }.get(_reject) or (int(_reject), None)

STATE = {'session_counter': 0, 'expire_counter': 0, 'redirect_idx': 0, 'gets': 0}

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass

    def do_GET(self):  # 301/302/303 redirect targets arrive as body-less GETs
        event('get-received', path=self.path)
        self.send_response(400)
        body = b'{"jsonrpc": "2.0", "id": null, "error": {"code": -32000, "message": "fixture: GET not a JSON-RPC exchange"}}'
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _flush_headers(self, ctype, length=None, session=True, status=200, extra=None):
        self.send_response(status)
        self.send_header('content-type', ctype)
        if session and status == 200 and not MODE.startswith('modern') and MODE != 'legacy_only':
            self.send_header('mcp-session-id', f"sess-{STATE['session_counter']}")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        if length is not None:
            self.send_header('content-length', str(length))
        self.end_headers()
        try:
            self.wfile.flush()
        except OSError:
            pass

    def do_DELETE(self):
        event('session-delete', session=self.headers.get('mcp-session-id'))
        self.send_response(200); self.send_header('content-length', '0'); self.end_headers()

    def do_POST(self):
        length = int(self.headers.get('content-length', 0))
        body = self.rfile.read(length)
        try:
            req = json.loads(body)
        except ValueError:
            self.send_response(400); self.send_header('content-length', '0'); self.end_headers(); return
        rid, method = req.get('id'), req.get('method')
        params = req.get('params') or {}
        proto_header = self.headers.get('mcp-protocol-version')
        event('request', method=method, protocol_header=proto_header,
              mcp_method_header=self.headers.get('mcp-method'),
              mcp_name_header=self.headers.get('mcp-name'),
              session=self.headers.get('mcp-session-id'),
              has_modern_meta=(MODERN_META_KEY in (params.get('_meta') or {})))
        if MODE == 'redirect_hanging_body' and method == 'tools/call' and self.path != '/mcp2':
            self.send_response(307)
            self.send_header('location','/mcp2')
            self.end_headers()
            self.wfile.write(b'partial redirect body'); self.wfile.flush()
            event('redirect-open-body')
            time.sleep(30)
            return
        if STATE['redirect_idx'] < len(REDIRECT_PLAN):
            entry = REDIRECT_PLAN[STATE['redirect_idx']]
            STATE['redirect_idx'] += 1
            code, _, target = entry.partition(':')
            self.send_response(int(code))
            self.send_header('location', target)
            self.send_header('content-length', '0')
            self.end_headers()
            event('redirect-sent', status=int(code), target=target)
            return
        if method == 'server/discover' and DISCOVER_REJECT:
            status, errbody = DISCOVER_REJECT
            data = json.dumps({**errbody, 'id': rid}).encode() if errbody else b''
            self.send_response(status)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(data)))
            self.end_headers()
            if data:
                self.wfile.write(data)
            event('discover-rejected', status=status)
            return
        if MODE == 'bad_status':
            self.send_response(503); self.send_header('content-length', '0'); self.end_headers(); return

        modern = MODE.startswith('modern')
        if MODE == 'legacy_only' and method == 'server/discover':
            self.send_response(404); self.send_header('content-length', '0'); self.end_headers()
            event('discover-404-legacy-only')
            return
        if modern:
            what = None
            if proto_header != MODERN_VERSION: what = 'MCP-Protocol-Version'
            elif self.headers.get('mcp-method') != method: what = 'Mcp-Method'
            elif method == 'tools/call' and decode_header_value(self.headers.get('mcp-name') or '') != params.get('name'): what = 'Mcp-Name'
            elif params.get('_meta', {}).get(MODERN_META_KEY) != MODERN_VERSION: what = 'modern _meta protocolVersion'
            if what:
                event('strict-rejected', what=what)
                err = json.dumps({"jsonrpc": "2.0", "id": rid, "error": {"code": -32600, "message": f"strict modern violation: missing {what}"}}).encode()
                self._flush_headers('application/json', len(err), session=False, status=400)
                self.wfile.write(err)
                return

        def reply(payload, sse=False, session=True):
            encoded = json.dumps(payload).encode()
            if sse and MODE == 'multiline_sse' and method == 'tools/call':
                first, second = encoded.split(b', "result"', 1)
                data = b': comment\r\n\r\ndata: ' + first + b',\r\ndata: "result"' + second + b'\r\n\r\n'
            else:
                data = (b'data: ' + encoded + b'\n\n') if sse else encoded
            self._flush_headers('text/event-stream' if sse else 'application/json', len(data), session=session)
            if sse and MODE == 'multiline_sse' and method == 'tools/call':
                cut = len(data) // 2
                self.wfile.write(data[:cut]); self.wfile.flush(); time.sleep(.01)
                self.wfile.write(data[cut:])
            else:
                self.wfile.write(data)
            try:
                self.wfile.flush()
            except OSError:
                pass

        if method == 'initialize':
            STATE['session_counter'] += 1
            STATE['expire_counter'] = 0
            event('initialize-received', session=f"sess-{STATE['session_counter']}")
            reply({"jsonrpc": "2.0", "id": rid, "result": {"protocolVersion": "2025-06-18",
                   "capabilities": {"tools": {}}, "serverInfo": {"name": "fake-http", "version": "1.0"}}})
        elif method == 'server/discover':
            # Real 2026 DiscoverResult shape: resultType + supportedVersions.
            result = ({"serverInfo": {"name": "fake-http", "version": "1.0"}} if DISCOVER_MALFORMED else
                      {"resultType": "server", "supportedVersions": ["2026-07-28"],
                       "serverInfo": {"name": "fake-http", "version": "1.0"},
                       "capabilities": {"tools": {"listChanged": False}}})
            reply({"jsonrpc": "2.0", "id": rid, "result": result}, session=False)
        elif method == 'tools/list':
            if self._expired(): return
            reply({"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}}, sse=True)
        elif method == 'tools/call':
            name = params.get('name')
            args = params.get('arguments') or {}
            if self._expired(): return
            log_call(f"{name}:{json.dumps(args, sort_keys=True)}")
            raw_headers = {k.lower(): v for k, v in self.headers.items() if k.lower().startswith('mcp-param-')}
            event('call-received', tool=name, args=args, param_headers=raw_headers)
            if name in ('hdr', 'hdr_nested'):
                expected = {'hdr': {'trace_id': 'mcp-param-trace-id', 'count': 'mcp-param-count', 'flag': 'mcp-param-x-flag'},
                            'hdr_nested': {('context', 'region'): 'mcp-param-region'}}[name]
                for path, header_key in expected.items():
                    node = args
                    for seg in (path if isinstance(path, tuple) else (path,)):
                        node = node.get(seg) if isinstance(node, dict) else None
                    if node is None:
                        continue  # absent argument: no header expected
                    decoded = decode_header_value(raw_headers.get(header_key, ''))
                    expect = ('true' if node else 'false') if isinstance(node, bool) else str(node)
                    event('hdr-check', header=header_key, decoded=decoded, body=node, match=decoded == expect)
            result = {"jsonrpc": "2.0", "id": rid,
                      "result": {"content": [{"type": "text", "text": f"handled {name} {args.get('body') or args.get('query') or ''}"}]}}
            if MODE == 'wrong_tool_response_id': result['id'] = rid + 999
            if MODE == 'empty_tool_response': result = {}
            if MODE in ('headers_then_hang', 'hang_body_json', 'modern_hang_json'):
                encoded = json.dumps(result).encode()
                if MODE == 'headers_then_hang':
                    self._flush_headers('application/json', 999999)  # promised length never arrives
                else:
                    self._flush_headers('application/json', len(encoded))
                    self.wfile.write(encoded[:len(encoded) // 2])  # one fragment, then hold the rest forever
                event('headers-sent')
                try:
                    self.wfile.flush()
                except OSError:
                    pass
                event('body-fragment-sent')
                time.sleep(30)
                return
            if MODE == 'hang_body_sse':
                self._flush_headers('text/event-stream')  # no content-length: stream stays open
                event('headers-sent')
                self.wfile.write(b': keepalive\n\n')  # non-terminal event
                try:
                    self.wfile.flush()
                except OSError:
                    pass
                event('body-fragment-sent')
                time.sleep(30)
                return
            if MODE == 'slow_json':
                time.sleep(5)
                reply({"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": "late"}]}})
                return
            reply(result, sse=MODE == 'multiline_sse')
        elif rid is not None:
            reply({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "not implemented"}})
        else:
            event('notification-received', method=method)
            self.send_response(202); self.send_header('content-length', '0'); self.end_headers()

    def _expired(self):
        """Kill the FIRST session after EXPIRE_AFTER session-scoped requests (404);
        sessions created later work normally, so a client that re-initializes on
        404 can keep making progress."""
        sid = self.headers.get('mcp-session-id')
        if not sid or not EXPIRE_AFTER:
            return False
        if sid == f"sess-{STATE['session_counter']}":
            STATE['expire_counter'] += 1
            if STATE['session_counter'] == 1 and STATE['expire_counter'] >= EXPIRE_AFTER:
                event('session-404', session=sid)
                self.send_response(404); self.send_header('content-length', '0'); self.end_headers()
                return True
        return False

if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), Handler)
    print('ready', flush=True)
    server.serve_forever()
