#!/usr/bin/env python3
"""Deterministic stdio MCP server for bridge tests. No network, no models.

Stage-evidence events go to FAKE_MCP_EVENTS (one JSON line per stage) so tests
can prove WHICH stage was reached instead of guessing from error strings.
"""
from __future__ import annotations
import json
import os
import secrets
import signal
import sys
import threading
import time

MODE = os.environ.get('FAKE_MCP_MODE', 'normal')  # normal|no_answer|die_after_init|die_during_call|close_stdin_after_init|close_stdin_after_list|close_after_call|slow
if MODE in ('ignore_term_no_init','ignore_term_after_eof'):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
CLOSE_AFTER_CALL = os.environ.get('FAKE_MCP_CLOSE_AFTER_CALL') == '1'
CALL_LOG = os.environ.get('FAKE_MCP_CALL_LOG')
EVENTS = os.environ.get('FAKE_MCP_EVENTS')
PAGED = os.environ.get('FAKE_MCP_PAGED') == '1'
MANY = os.environ.get('FAKE_MCP_MANY') == '1'
DYNAMIC = os.environ.get('FAKE_MCP_DYNAMIC') == '1'
MUTATE = os.environ.get('FAKE_MCP_MUTATE') == '1'
DIE_AFTER_LIST_MS = int(os.environ.get('FAKE_MCP_DIE_AFTER_LIST_MS', '0'))
# Arm close_stdin_after_list for the FIRST process only: a reconnect must get a
# healthy server, proving the new generation re-handshakes and can serve calls.
CLOSE_ONCE_FILE = os.environ.get('FAKE_MCP_CLOSE_STDIN_ONCE_FILE')
if CLOSE_ONCE_FILE and not os.path.exists(CLOSE_ONCE_FILE):
    open(CLOSE_ONCE_FILE, 'w').close()
    MODE = 'close_stdin_after_list'
SLOW_MUTATION_MS = int(os.environ.get('FAKE_MCP_SLOW_MUTATION_MS', '0'))
# P1-A dual-era fixtures: the strict fixture fails ANY process whose first RPC
# is not server/discover; DISCOVER_* shape the discover answer.
STRICT_FIRST = os.environ.get('FAKE_MCP_STRICT_FIRST_DISCOVER') == '1'
DISCOVER_MALFORMED = os.environ.get('FAKE_MCP_DISCOVER_MALFORMED') == '1'
DISCOVER_ERROR = None
_dec = os.environ.get('FAKE_MCP_DISCOVER_ERROR_CODE')
if _dec:
    _err = {"code": int(_dec), "message": "fixture discover error"}
    _sup = os.environ.get('FAKE_MCP_DISCOVER_SUPPORTED')
    if _sup is not None:
        _err["data"] = {"supported": [s for s in _sup.split(',') if s]}
    DISCOVER_ERROR = _err
FIRST = {'method': None}
DYN_FILE = os.environ.get('FAKE_MCP_DYN_FILE')
TOOLS_HIDDEN = set(os.environ.get('FAKE_MCP_HIDE', '').split(','))

def event(kind, **kw):
    if EVENTS:
        with open(EVENTS, 'a') as f:
            f.write(json.dumps({'event': kind, 't': time.time(), **kw}) + '\n')

def log_call(name):
    if CALL_LOG:
        with open(CALL_LOG, 'a') as f:
            f.write(name + '\n')

def base_tools():
    return [
        {"name": "echo", "description": "Echo the arguments",
         "inputSchema": {"type": "object", "properties": {
             "text": {"type": "string", "description": "text to echo"},
             "count": {"type": "integer", "minimum": 1}},
             "required": ["text"], "additionalProperties": False},
         "annotations": {"readOnlyHint": True}},
        {"name": "delete_file", "description": "Destructive op (counter only; deletes nothing)",
         "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
         "annotations": {"readOnlyHint": False}},
        {"name": "status", "description": "Show status",
         "inputSchema": {"type": "object", "properties": {}},
         "annotations": {"readOnlyHint": True}},
        {"name": "unannounced", "description": "Tool without any annotations",
         "inputSchema": {"type": "object", "properties": {}}},  # no readOnlyHint: treated as write-capable
    ]

# Keep the dynamic name stable across server restarts so multi-host tests see
# one identity; tests still learn it only from the catalog, never from here.
DYN_NAME = ('dyn-' + secrets.token_hex(4))
if DYNAMIC and DYN_FILE:
    if os.path.exists(DYN_FILE):
        DYN_NAME = open(DYN_FILE).read().strip() or DYN_NAME
    else:
        with open(DYN_FILE, 'w') as f:
            f.write(DYN_NAME)
event('server-start', pid=os.getpid())
# P1-A evidence: the Codex client-side protocol marker must be consumed by the
# parent and NEVER reach the server process env.
event('env-marker', present=str('CODEX_MCP_PROTOCOL_VERSION' in os.environ))
TOOLS = [t for t in base_tools() if t['name'] not in TOOLS_HIDDEN]
CATALOG_SIZE = os.environ.get('FAKE_MCP_CATALOG_SIZE')
if CATALOG_SIZE is not None:
    TOOLS = [{"name": f"bulk_{i}", "inputSchema": {"type": "object"},
              "annotations": {"readOnlyHint": True}} for i in range(int(CATALOG_SIZE))]
if DYNAMIC:
    TOOLS = TOOLS + [{
        "name": DYN_NAME, "description": "Dynamically generated tool",
        "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
        "annotations": {"readOnlyHint": True}}]
if MANY:
    TOOLS = TOOLS + [{"name": f"bulk_{i}", "description": "bulk", "inputSchema": {"type": "object", "properties": {}},
                      "annotations": {"readOnlyHint": True}} for i in range(600)]
if MUTATE:
    # First catalog = base set; AFTER a tools/list_changed notification the
    # catalog differs (delete_file removed, transferred added).
    TOOLS_MUTATED = [t for t in TOOLS if t['name'] != 'delete_file']
    TOOLS_MUTATED.append({"name": "transferred", "description": "Added by mutation",
                          "inputSchema": {"type": "object", "properties": {}},
                          "annotations": {"readOnlyHint": True}})

PAGED_FULL = TOOLS
list_count = 0
sent_mutate = False

def reply(req, result):
    print(json.dumps({"jsonrpc": "2.0", "id": req.get('id'), "result": result}), flush=True)

def tools_page(cursor):
    if not PAGED:
        return {"tools": TOOLS}
    page_size = int(os.environ.get('FAKE_MCP_PAGE_SIZE', '2'))
    start = int(cursor) if cursor else 0
    page = PAGED_FULL[start:start + page_size]
    nxt = start + page_size
    out = {"tools": page}
    if nxt < len(PAGED_FULL):
        out["nextCursor"] = str(nxt)
    return out

def handle_call(req, name, args):
    log_call(f"{name}:{json.dumps(args, sort_keys=True)}")
    event('call-received', tool=name)
    if SLOW_MUTATION_MS:
        # server-side execution window: tests prove serialized ordering from
        # these start/end records, never from client-side await ordering
        event('call-start', tool=name)
        time.sleep(SLOW_MUTATION_MS / 1000)
        event('call-end', tool=name)
    if CLOSE_AFTER_CALL:
        # Deterministic EPIPE for the client's CANCEL notification: hold the
        # call, close our read end, then the client's abort-write hits it.
        time.sleep(0.8)
        event('closing-stdin')
        os.close(0)
        for _ in range(300):
            if os.getppid() == 1: break
            time.sleep(0.1)
        sys.exit(0)
    if MODE == 'no_answer':
        return  # never respond -> client deadline
    if MODE == 'slow':
        time.sleep(5)
    if name == 'echo' or name == DYN_NAME:
        text = str(args.get('text', ''))
        count = int(args.get('count', 1))
        if 'text' not in args or not isinstance(args.get('text'), str):
            reply(req, {"content": [{"type": "text", "text": "invalid arguments: text is required"}], "isError": True})
            return
        structured = {"echoed": text, "count": count}
        rendered = json.dumps(structured) if MODE == 'duplicate_result' else text * count
        reply(req, {"content": [{"type": "text", "text": rendered}],
                    **({} if MODE == 'text_only_result' else {"structuredContent": structured})})
    elif name == 'delete_file':
        reply(req, {"content": [{"type": "text", "text": f"counted delete attempt for {args.get('path')}"}]})
    else:
        reply(req, {"content": [{"type": "text", "text": "ok"}], "isError": False})

for raw in sys.stdin:
    line = raw.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except ValueError:
        continue
    rid, method = req.get('id'), req.get('method')
    if STRICT_FIRST and FIRST['method'] is None:
        FIRST['method'] = method
        event('first-method', method=method)
        if method != 'server/discover':
            if rid is not None:
                print(json.dumps({"jsonrpc": "2.0", "id": rid,
                                  "error": {"code": -32000, "message": "strict fixture: first RPC must be server/discover"}}), flush=True)
            os._exit(9)
    if method == 'server/discover':
        _meta = req.get('params', {}).get('_meta') or {}
        event('discover-received', modern_meta=_meta.get('io.modelcontextprotocol/protocolVersion'))
        if DISCOVER_MALFORMED:
            reply(req, {"serverInfo": {"name": "fake-stdio", "version": "1.0"}})  # no resultType/supportedVersions
        elif DISCOVER_ERROR:
            print(json.dumps({"jsonrpc": "2.0", "id": rid, "error": DISCOVER_ERROR}), flush=True)
        else:
            reply(req, {"resultType": "server", "supportedVersions": ["2026-07-28"],
                        "capabilities": {"tools": {"listChanged": True}},
                        "serverInfo": {"name": "fake-stdio", "version": "1.0"}})
    elif method == 'initialize':
        event('initialize-received')
        if MODE == 'ignore_term_no_init':
            while True: time.sleep(1)
        reply(req, {"protocolVersion": "2025-06-18",
                    "capabilities": {"tools": {"listChanged": True}},
                    "serverInfo": {"name": "fake-stdio", "version": "1.0"}})
        if MODE == 'die_after_init':
            sys.exit(3)
        if MODE == 'close_stdin_after_init':
            # The reply is flushed; the client's initialized-notification and
            # tools/list writes happen AFTER our close(0) (the network round
            # trip is slower than this synchronous close), so they hit EPIPE.
            event('closing-stdin')
            os.close(0)  # close OUR read end
            for _ in range(300):  # keep stdout open; exit when the host goes away
                if os.getppid() == 1: break
                time.sleep(0.1)
            sys.exit(0)
    elif method == 'notifications/initialized':
        event('initialized-received')
    elif method == 'tools/list':
        _meta = req.get('params', {}).get('_meta') or {}
        event('tools-list-received', count=list_count + 1,
              modern_meta=_meta.get('io.modelcontextprotocol/protocolVersion'))
        if MODE == 'ignore_term_no_list':
            while True: time.sleep(1)
        page = tools_page(req.get('params', {}).get('cursor'))
        if MODE == 'close_stdin_after_list':
            # Deterministic EPIPE: the catalog answer goes out first, so the
            # client's NEXT write (tools/call) is what hits the closed pipe.
            reply(req, page)
            event('closing-stdin')
            os.close(0)  # close OUR read end
            for _ in range(300):  # keep stdout open; exit when the host goes away
                if os.getppid() == 1: break
                time.sleep(0.1)
            sys.exit(0)
        if MUTATE:
            list_count += 1
            if list_count == 1:
                page = {'tools': TOOLS}  # original catalog
            else:
                page = {'tools': TOOLS_MUTATED}  # after list_changed
        reply(req, page)
        if MODE == 'stall_stdin_after_list':
            event('stdin-stalled')
            while True: time.sleep(1)
        if DIE_AFTER_LIST_MS:
            # die AFTER the catalog answer is flushed: the client caches a live
            # catalog, then the process disappears (e.g. during a confirm wait)
            threading.Timer(DIE_AFTER_LIST_MS / 1000, lambda: os._exit(9)).start()
        if MUTATE and list_count == 1:
            print(json.dumps({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}), flush=True)
            event('list-changed-sent')
    elif method == 'tools/call':
        params = req.get('params') or {}
        if MODE == 'die_during_call':
            event('call-received-die')
            sys.exit(7)
        if MODE == 'invalid_call_response':
            event('invalid-call-response-sent')
            print(json.dumps({'id':rid}),flush=True)
            continue
        handle_call(req, params.get('name'), params.get('arguments') or {})
    elif method == 'notifications/cancelled':
        event('cancelled-notification-received')
    elif rid is not None:
        print(json.dumps({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "not implemented"}}), flush=True)
if MODE == 'ignore_term_after_eof':
    event('stdin-ended-still-alive')
    while True: time.sleep(1)
