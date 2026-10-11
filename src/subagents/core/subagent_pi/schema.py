"""One compact schema source shared by the MCP adapter and IPC validator."""

import re
from .common import (
    AgentError,
    DEFAULT_WAIT_SECONDS,
    MAX_WAIT_SECONDS,
    IDENTIFIER_PATTERN,
    LABEL_MAX_CHARS,
    TEXT_MAX_BYTES,
    text,
)

S = {"type": "string"}
LABEL = {
    "type": "string",
    "minLength": 1,
    "maxLength": LABEL_MAX_CHARS,
    "pattern": r"\S",
}
ID = {**LABEL, "pattern": IDENTIFIER_PATTERN}
TEXT = {
    "type": "string",
    "minLength": 1,
    "maxLength": TEXT_MAX_BYTES,
    "pattern": r"\S",
    "x-maxBytes": TEXT_MAX_BYTES,
}
SCOPE = {
    "scope": {
        **ID,
        "description": "Omit for the bound scope; set to address another scope.",
    }
}
REQ = {
    "request_id": {**ID, "description": "Reuse this key only for identical retries."}
}
AGENT = {**SCOPE, "agent_id": LABEL}


def obj(properties, required=()):
    return {
        "type": "object",
        "properties": properties,
        "required": list(required),
        "additionalProperties": False,
    }


def tool(name, op, description, properties, required, read=False):
    return {
        "name": name,
        "description": description,
        "inputSchema": obj(properties, required),
        "outputSchema": {"anyOf": [OUTPUTS[op], ERROR_OUTPUT]},
        "annotations": {
            "readOnlyHint": read,
            "destructiveHint": not read,
            "idempotentHint": read or "request_id" in properties,
            "openWorldHint": not read,
        },
        "_op": op,
    }


# Shared summaries are closed contracts; diagnostic maps stay explicitly open.
def output(properties, required=(), mutation=False):
    if mutation:
        properties = {**properties, "replayed": {"type": "boolean"}, "request_id": ID}
    return obj(properties, required)


NULLABLE = {"anyOf": [S, {"type": "null"}]}
BOOL = {"type": "boolean"}
INT = {"type": "integer"}
MAP = {"type": "object", "additionalProperties": True}
ARR = lambda item: {"type": "array", "items": item}
RUN_FIELDS = {"id": ID, "agent_id": ID, "name": S, "state": S, "error": S}
RUN = output(RUN_FIELDS, ["id", "agent_id", "name", "state"])
PREVIEW = output(
    {
        "text": S,
        "result_sha256": S,
        "next_offset": INT,
        "has_more": BOOL,
        "total_bytes": INT,
        "result_truncated": BOOL,
    },
    ["result_sha256", "next_offset", "has_more"],
)
INPUT_ISSUES = output({"receipts": ARR(MAP), "total": INT, "omitted": INT}, ["receipts", "total", "omitted"])
WAIT_RUN = output({**RUN_FIELDS, "result": PREVIEW, "input_issues": INPUT_ISSUES}, RUN["required"])
OUTSTANDING = output(
    {"runs": ARR(RUN), "total": INT, "omitted": INT}, ["runs", "total", "omitted"]
)
MODEL = output({"id": S, "provider": NULLABLE}, ["id"])
NOTIFICATIONS = output({"enabled": BOOL, "failed": INT}, ["enabled"])
OUTPUTS = {
    "scope_open": output(
        {
            "scope": ID,
            "cwd": S,
            "outstanding": OUTSTANDING,
            "parent_notifications": MAP,
        },
        ["scope", "cwd"],
    ),
    "spawn": output(
        {
            "agent_id": ID,
            "name": S,
            "run_id": ID,
            "scope": ID,
            "state": S,
            "cwd": S,
            "resolved_model": MODEL,
            "thinking": S,
            "available_thinking": ARR(S),
        },
        ["agent_id", "name", "run_id", "scope"],
        mutation=True,
    ),
    "send": output(
        {
            "agent_id": ID,
            "name": S,
            "run_id": ID,
            "receipt_id": ID,
            "state": S,
            "delivery": S,
            "execution": S,
            "queue_owner": S,
        },
        ["agent_id", "run_id"],
        mutation=True,
    ),
    "message": output(
        {
            "agent_id": ID,
            "name": S,
            "run_id": NULLABLE,
            "receipt_id": ID,
            "delivery": S,
        },
        ["agent_id", "name", "run_id", "delivery"],
        mutation=True,
    ),
    "followup": output(
        {
            "agent_id": ID,
            "name": S,
            "run_id": ID,
            "receipt_id": ID,
            "delivery": S,
            "state": S,
        },
        ["agent_id", "name", "run_id"],
        mutation=True,
    ),
    "soft_interrupt": output(
        {
            "agent_id": ID,
            "previous_status": S,
            "runtime_retained": BOOL,
            "forced": BOOL,
            "run_id": ID,
        },
        ["agent_id", "previous_status", "runtime_retained"],
        mutation=True,
    ),
    "close": output(
        {"agent_id": ID, "state": S, "cleanup": S, "session_retained": BOOL},
        ["agent_id", "state", "cleanup", "session_retained"],
        mutation=True,
    ),
    "respawn": output(
        {
            "agent_id": ID,
            "generation": INT,
            "run_id": NULLABLE,
            "state": S,
            "scope": ID,
            "already_running": BOOL,
            "name": S,
        },
        ["agent_id", "generation", "state", "scope"],
        mutation=True,
    ),
    "list": output(
        {
            "scope": ID,
            "agents": ARR(
                output(
                    {"id": ID, "name": S, "state": S, "agent_status": S, "created_at": S, "updated_at": S},
                    ["id", "name", "state", "agent_status", "created_at", "updated_at"],
                )
            ),
            "total": INT,
            "matched": INT,
            "omitted": INT,
            "next_offset": INT,
            "has_more": BOOL,
            "outstanding": OUTSTANDING,
            "parent_notifications": NOTIFICATIONS,
        },
        ["scope", "agents", "total", "matched", "omitted", "next_offset", "has_more", "outstanding", "parent_notifications"],
    ),
    "inspect": output(
        {
            "agent": MAP,
            "events": ARR(MAP),
            "next_cursor": INT,
            "has_more": BOOL,
            "receipts": ARR(MAP),
            "run": MAP,
            "history_pruned": BOOL,
            "parent_notifications": MAP,
            "diagnostics_truncated": BOOL,
        },
        ["agent", "events", "next_cursor", "has_more", "receipts"],
    ),
    "wait": output(
        {
            "scope": ID,
            "timed_out": BOOL,
            "reason": S,
            "runs": ARR(WAIT_RUN),
            "questions": ARR(MAP),
        },
        ["scope", "timed_out", "reason", "runs", "questions"],
    ),
    "result": output(
        {
            "run": RUN,
            "input_issues": INPUT_ISSUES,
            "text": S,
            "result_sha256": S,
            "next_offset": INT,
            "has_more": BOOL,
            "total_bytes": INT,
            "result_truncated": BOOL,
        },
        [
            "run",
            "text",
            "result_sha256",
            "next_offset",
            "has_more",
            "total_bytes",
            "result_truncated",
        ],
    ),
    "answer": output(
        {"agent_id": ID, "sent": BOOL, "ui_request_id": S},
        ["agent_id", "sent", "ui_request_id"],
        mutation=True,
    ),
}
OUTPUTS["interrupt"] = output(
    {"agent_id": ID, "state": S, "cleanup": S, "process_retained": BOOL},
    ["agent_id", "state", "cleanup", "process_retained"],
    mutation=True,
)
ERROR_OUTPUT = obj({"isError": {"const": True, "type": "boolean"}, "error": obj({
    "code": S, "message": S, "agent_id": ID, "run_id": ID, "blocking_agent_id": ID, "request_id": ID,
}, ["code", "message"])}, ["isError", "error"])

TOOLS = [
    tool(
        "pi_spawn_agent",
        "spawn",
        (
            "Start a Pi task with its own session. Parent conversation and sandbox are not "
            "inherited. Supply cwd to bind an unbound connection. Returns agent/run IDs and "
            "selected model/thinking. Idle sessions park automatically."
        ),
        {
            **SCOPE,
            **REQ,
            "cwd": {
                **S,
                "description": "Absolute child directory; defaults to scope cwd. SUBAGENT-PI.md comes from scope cwd.",
            },
            "task": {
                **TEXT,
                "description": "Self-contained goal, context, paths, permissions, constraints and acceptance checks.",
            },
            "name": {
                **LABEL,
                "description": "Scope-unique label; defaults to agent ID. Agent operations accept ID or name.",
            },
            "profile": S,
            "model": S,
            "thinking": {
                **LABEL,
                "description": "Pi reasoning level; omit to inherit settings. Unsupported levels are rejected.",
            },
            "access": {
                "type": "string",
                "enum": ["read", "write"],
                "default": "write",
                "description": "Managed tool policy, not an OS sandbox. Ambient Pi extensions retain their own capabilities.",
            },
            "idle_timeout_seconds": {
                "type": "integer",
                "minimum": 1,
                "maximum": 604800,
                "description": "Inactivity limit, default 1800s; progress resets it, tools/questions pause it.",
            },
        },
        ["request_id", "task"],
    ),
    tool(
        "pi_wait_agent",
        "wait",
        (
            "Wait for selected runs. Default any returns on the first completion, failure, "
            "stop or question. Optional all waits for every run to reach a terminal state; "
            "questions still return early. Returns all ready bounded previews and hashes; "
            "delivery consumes returned notifications automatically. Completed means the "
            "model stopped, not that its task passed acceptance; verify artifacts before "
            "reporting success. Inputs marked not_consumed are not replayed; resend "
            "explicitly if needed. Cancelling the wait does not stop agents."
        ),
        {
            **SCOPE,
            "run_ids": {
                "type": "array",
                "items": ID,
                "maxItems": 100,
                "description": "Selected run IDs; omit for up to 100 active or not-yet-delivered runs in the bound scope.",
            },
            "agent_ids": {
                "type": "array",
                "items": LABEL,
                "maxItems": 100,
                "description": (
                    "Agent names/IDs instead of run_ids. Locks each current or latest task at call "
                    "entry; multiple queued tasks require explicit run_ids."
                ),
            },
            "mode": {"type": "string", "enum": ["any", "all"], "default": "any"},
            "timeout_seconds": {
                "type": "integer",
                "minimum": 0,
                "maximum": MAX_WAIT_SECONDS,
                "default": DEFAULT_WAIT_SECONDS,
                "description": "Maximum wait; 0 checks immediately. Host MCP timeout may be shorter.",
            },
        },
        [],
        True,
    ),
    tool(
        "pi_list_agents",
        "list",
        (
            "Search this session's retained agent history by name/ID. Defaults to newest "
            "status/task update first; sort=created uses creation time. Timestamps are UTC "
            "ISO 8601. total counts all history, matched counts query matches; continue with "
            "next_offset while has_more, keeping query/sort unchanged. Outstanding runs "
            "remain scope-wide; listing status does not consume result attention. Read "
            "results with wait or pi_agent_result. For notification details, call "
            "pi_inspect_agent with agent_id and detail=full."
        ),
        {
            **SCOPE,
            "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20},
            "query": {
                **S,
                "maxLength": LABEL_MAX_CHARS,
                "description": "Literal name/ID substring; ASCII case-insensitive. Omit to list all history.",
            },
            "sort": {**S, "enum": ["updated", "created"], "default": "updated"},
            "offset": {"type": "integer", "minimum": 0, "maximum": 2**31 - 1, "default": 0},
        },
        [],
        True,
    ),
    tool(
        "pi_inspect_agent",
        "inspect",
        (
            "Read bounded events and input receipts; pass next_cursor as after. full adds "
            "current/latest run diagnostics and notification details. Usage token counters "
            "are run totals across assistant messages; last_message_output and "
            "max_message_output distinguish individual response output from cumulative "
            "output."
        ),
        {
            **AGENT,
            "after": {"type": "integer", "minimum": 0},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100},
            "max_bytes": {"type": "integer", "minimum": 1024, "maximum": 16384},
            "detail": {"type": "string", "enum": ["tools", "full"], "default": "tools"},
        },
        ["agent_id"],
        True,
    ),
    tool(
        "pi_agent_result",
        "result",
        (
            "Read a terminal result by agent name/ID or explicit run ID; choose exactly one. "
            "Paginate long results with next_offset and the returned run.id. Complete "
            "wait/notification results need no extra read. Delivery consumes its "
            "notification automatically; results remain available for re-reading."
        ),
        {
            **SCOPE,
            "run_id": ID,
            "agent_id": LABEL,
            "offset": {"type": "integer", "minimum": 0},
            "max_bytes": {"type": "integer", "minimum": 256, "maximum": 16384},
        },
        [],
        True,
    ),
    tool(
        "pi_answer_agent",
        "answer",
        "Answer a pending Pi extension input request explicitly. Confirmations require a boolean; select/input/editor use text.",
        {
            **AGENT,
            **REQ,
            "ui_request_id": S,
            "answer": {"anyOf": [{"type": "string"}, {"type": "boolean"}]},
        },
        ["agent_id", "request_id", "ui_request_id", "answer"],
    ),
    tool(
        "pi_send_message",
        "message",
        (
            "Message by agent ID or name. Active tasks receive steering before a later model "
            "call; idle messages persist without a model turn. Parked sessions load "
            "automatically. Accepted is not consumed."
        ),
        {**AGENT, **REQ, "message": TEXT},
        ["agent_id", "request_id", "message"],
    ),
    tool(
        "pi_followup_task",
        "followup",
        (
            "Assign work by agent ID or name. Active tasks receive input in the same run; "
            "idle agents start a new run. Parked sessions load automatically. Accepted is "
            "not consumed."
        ),
        {**AGENT, **REQ, "message": TEXT},
        ["agent_id", "request_id", "message"],
    ),
    tool(
        "pi_interrupt_agent",
        "soft_interrupt",
        (
            "Interrupt the task and preserve its session. Normally retains the runtime; "
            "uncooperative activity requires verified process termination. Idle/unloaded "
            "agents are unchanged."
        ),
        {**AGENT, **REQ},
        ["agent_id", "request_id"],
    ),
]


def native_tools():
    """Pi supplies scope and durable invocation IDs; backend/CLI contracts stay explicit."""
    result = []
    for definition in TOOLS:
        schema = definition["inputSchema"]
        properties = {k: v for k, v in schema["properties"].items() if k != "scope"}
        if "request_id" in properties:
            properties["request_id"] = {
                **ID,
                "description": (
                    "Normally omit: Pi generates and saves an operation ID. Reuse the returned key "
                    "only to recover the identical uncertain operation; never retry with a new key."
                ),
            }
        description = definition["description"]
        if definition["_op"] == "spawn":
            description = description.replace(
                "Supply cwd to bind an unbound connection.", "The workspace defaults to the current Pi session."
            )
        if definition["_op"] == "answer":
            description += (
                " Omit ui_request_id only for the unique question already delivered to this "
                "parent; stale or ambiguous questions are rejected."
            )
        result.append(
            {
                **definition,
                "description": description,
                "inputSchema": obj(
                    properties, [k for k in schema["required"] if k not in {"scope", "request_id", "ui_request_id"}]
                ),
            }
        )
    return result


NATIVE_TOOLS = native_tools()
NATIVE_BY_NAME = {t["name"]: t for t in NATIVE_TOOLS}

# Explicit recovery/legacy calls stay callable without discovery.
MANAGEMENT = [
    tool(
        "pi_context",
        "scope_open",
        (
            "Open a Pi delegation scope in an explicit workspace, or resume a known scope. "
            "Reuse it for subsequent calls. Optional: pi_spawn_agent with a cwd opens this "
            "scope implicitly."
        ),
        {
            "cwd": {
                **S,
                "description": "Absolute current workspace directory, never the daemon directory.",
            },
            "scope": ID,
            "label": S,
            "inheritance": {
                "type": "boolean",
                "description": "Explicitly enable or disable Codex skill/MCP inheritance for this scope.",
            },
            "codex_home": {
                **S,
                "description": "Explicit trusted Codex home directory; rebinds this scope as a management action.",
            },
        },
        ["cwd"],
    ),
    tool(
        "pi_send_input",
        "send",
        (
            "Submit input to an existing Pi session. Queued is not consumed. send/follow_up "
            "wakes a cleanly stopped (dormant or closed, verified) agent from its persisted "
            "session and boots it; steer still needs an active run on a live worker. "
            "interrupt=true terminates and verifies the owned process before starting a "
            "replacement with this message; it does not roll back effects."
        ),
        {
            **AGENT,
            **REQ,
            "message": {
                **TEXT,
                "description": (
                    "New work or a correction, with any changed facts, permissions and acceptance "
                    "criteria. The child retains its own Pi history, but cannot see new parent "
                    "conversation."
                ),
            },
            "mode": {
                "type": "string",
                "enum": ["send", "steer", "follow_up"],
                "default": "steer",
                "description": (
                    "send: new run on an idle agent. steer: same-run continuation after the current "
                    "SDK call finishes, not a mid-call interruption. follow_up: separate run after "
                    "the active task and all its continuations."
                ),
            },
            "interrupt": {"type": "boolean", "default": False},
        },
        ["agent_id", "request_id", "message"],
    ),
    tool(
        "pi_close_agent",
        "close",
        (
            "Stop work and terminate the owned process group. Preserve durable session and "
            "results. Also reaps a verified orphan. Capacity is managed automatically: "
            "settled idle agents are parked when the resident limit is reached."
        ),
        {
            **AGENT,
            **REQ,
            "confirm_cleanup": {
                "type": "integer",
                "minimum": 1,
                "description": (
                    "Explicit operator confirmation after inspecting and removing all descendants of "
                    "this dead owner generation. Does not kill or override a live or unidentified "
                    "owner."
                ),
            },
        },
        ["agent_id", "request_id"],
    ),
    tool(
        "pi_respawn_agent",
        "respawn",
        (
            "Ensure the same logical agent is running from its persisted Pi session. An "
            "alive worker is returned unchanged (already_running) unless a new message would "
            "replace it; a cleanly stopped agent can instead be woken with pi_send_input. "
            "Never auto-replay interrupted shell commands."
        ),
        {**AGENT, **REQ, "message": TEXT},
        ["agent_id", "request_id"],
    ),
]
BY_NAME = {t["name"]: t for t in [*TOOLS, *MANAGEMENT]}
BY_OP = {t["_op"]: t for t in BY_NAME.values()}
BY_OP["interrupt"] = {
    **BY_OP["soft_interrupt"],
    "_op": "interrupt",
    "outputSchema": OUTPUTS["interrupt"],
}


def validate(value, schema, path="arguments"):
    if "anyOf" in schema:
        for option in schema["anyOf"]:
            try:
                validate(value, option, path)
                return
            except AgentError:
                pass
        raise AgentError("invalid_argument", f"{path} has an unsupported type")
    kind = schema.get("type")
    valid = {
        "object": lambda: isinstance(value, dict),
        "array": lambda: isinstance(value, list),
        "string": lambda: isinstance(value, str),
        "integer": lambda: isinstance(value, int) and not isinstance(value, bool),
        "boolean": lambda: isinstance(value, bool),
        "null": lambda: value is None,
        "number": lambda: isinstance(value, (int, float))
        and not isinstance(value, bool),
    }
    if kind in valid and not valid[kind]():
        raise AgentError("invalid_argument", f"{path} must be {kind}")
    if "enum" in schema and value not in schema["enum"]:
        raise AgentError("invalid_argument", f"{path} is not an allowed value")
    if kind == "object":
        missing = set(schema.get("required", [])) - set(value)
        if missing:
            raise AgentError("invalid_argument", f"Missing {path}: {sorted(missing)}")
        unknown = set(value) - set(schema.get("properties", {}))
        if unknown and schema.get("additionalProperties") is False:
            raise AgentError("invalid_argument", f"Unknown {path}: {sorted(unknown)}")
        for key, item in value.items():
            if key in schema.get("properties", {}):
                validate(item, schema["properties"][key], path + "." + key)
    if kind == "array":
        if len(value) > schema.get("maxItems", 1000):
            raise AgentError("invalid_argument", f"{path} has too many items")
        for item in value:
            validate(item, schema.get("items", {}), path + "[]")
    if kind == "string":
        if (
            len(value) < schema.get("minLength", 0)
            or len(value) > schema.get("maxLength", 65536)
            or "\x00" in value
        ):
            raise AgentError(
                "invalid_argument", f"{path} has invalid length or contains NUL"
            )
        if "pattern" in schema and not re.search(schema["pattern"], value):
            raise AgentError("invalid_argument", f"{path} has invalid characters")
        if "x-maxBytes" in schema:
            text(value, path, schema["x-maxBytes"])
    if kind == "integer":
        if value < schema.get("minimum", -(2**63)) or value > schema.get(
            "maximum", 2**63 - 1
        ):
            raise AgentError("invalid_argument", f"{path} out of range")


def validate_op(op, p):
    if not isinstance(p, dict):
        raise AgentError("invalid_argument", "params must be an object")
    if op in BY_OP:
        validate(p, BY_OP[op]["inputSchema"])
        if op != "scope_open" and not p.get("scope"):
            raise AgentError(
                "invalid_argument",
                "scope is required; call pi_context first, or pass scope explicitly, or pass cwd to pi_spawn_agent",
            )
    elif op in {"pi_watch","pi_view","pi_claim","pi_observe","pi_release","pi_uncertain","pi_detach"}:
        fields = {"scope":ID}
        if op=="pi_watch": fields["after"]={**S,"maxLength":64}
        if op=="pi_view": fields.update(agent_id=LABEL,after={"type":"integer","minimum":0,"maximum":2**53-1})
        if op=="pi_claim": fields["events"]={"type":"array","items":{**S,"minLength":64,"maxLength":64},"minItems":1,"maxItems":20}
        if op in {"pi_observe","pi_release","pi_uncertain"}: fields["receipt"]=ID
        validate(p,obj(fields,["scope"]+(["agent_id"] if op=="pi_view" else ["receipt"] if "receipt" in fields else [])))
    elif op not in {"ping", "doctor", "scope_list", "shutdown"}:
        raise AgentError("unknown_operation", "Unknown operation")
