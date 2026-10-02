"""Codex MCP config normalization, tool policy and scope-bound credential resolution.
No process startup or ambient environment access; unusable servers keep their reasons.
"""
from pathlib import Path
import shutil
from .common import AgentError

MAX_MCP_SERVERS = 32
# Compatibility classification for every current Codex RawMcpServerConfig field.
# Single source of truth: a field missing from this table fails closed, so a new
# upstream field surfaces in the compatibility matrix test instead of being
# silently accepted or dropped. Classes: mapped = converted to an in-memory
# effect; accepted_no_effect = valid upstream with no child-side effect (a note
# diagnostic, never fatal); explicitly_unsupported = valid upstream but no honest
# mapping here (required servers fail, optional are excluded, with a reason);
# conditional_local = environment_id, absent/'local' ok, anything else unsupported.
CODEX_MCP_BASELINE = 'legacy 2025-06-18 + modern 2026-07-28 discovery; Codex RawMcpServerConfig surface as of 2026-09'
MCP_FIELD_COMPAT = {
    'command': ('mapped', '', 'stdio'), 'args': ('mapped', '', 'stdio'),
    'env': ('mapped', '', 'stdio'), 'env_vars': ('mapped', '', 'stdio'), 'cwd': ('mapped', '', 'stdio'),
    'url': ('mapped', '', 'http'), 'auth': ('mapped', '', 'http'),
    'bearer_token_env_var': ('mapped', '', 'http'),
    'http_headers': ('mapped', '', 'http'), 'env_http_headers': ('mapped', '', 'http'),
    'http_headers_helper': ('explicitly_unsupported', 'dynamic header helper has no in-child equivalent', 'http'),
    'startup_timeout_sec': ('mapped', '', 'stdio http'), 'startup_timeout_ms': ('mapped', '', 'stdio http'),
    'tool_timeout_sec': ('mapped', '', 'stdio http'),
    'enabled': ('mapped', '', 'stdio http'), 'required': ('mapped', '', 'stdio http'),
    'enabled_tools': ('mapped', '', 'stdio http'), 'disabled_tools': ('mapped', '', 'stdio http'),
    'default_tools_approval_mode': ('mapped', '', 'stdio http'), 'tools': ('mapped', '', 'stdio http'),
    'experimental_environment': ('explicitly_unsupported', 'remote executor is not supported in managed children', 'stdio'),
    'supports_parallel_tool_calls': ('accepted_no_effect', 'concurrency hint; the proxy tool is registered sequential and serializes every call regardless', 'stdio http'),
    'name': ('accepted_no_effect', 'legacy name label; the config key identifies the server', 'stdio http'),
    'environment_id': ('conditional_local', 'no remote executor in managed children', 'stdio http'),
    'omit_tools_from': ('explicitly_unsupported', 'ToolExposureSurface cannot be mapped onto the proxy tool surface without guessing', 'stdio http'),
    'scopes': ('explicitly_unsupported', 'OAuth scopes need a token store managed children must not create', 'stdio http'),
    'oauth': ('explicitly_unsupported', 'OAuth needs a credential store managed children must not create or copy', 'stdio http'),
    'oauth_resource': ('explicitly_unsupported', 'OAuth resource indicator requires oauth support', 'stdio http'),
}
TOOL_FIELD_COMPAT = {'approval_mode': 'mapped', 'output_token_limit': 'mapped'}
MCP_STDIO_KEYS = {f for f, (_, _, t) in MCP_FIELD_COMPAT.items() if 'stdio' in t}
MCP_HTTP_KEYS = {f for f, (_, _, t) in MCP_FIELD_COMPAT.items() if 'http' in t}
# Bookkeeping that never belongs to a child-side server config: the credential
# references resolve_environment turns into values, and parsing's disposition trail.
SERVER_RESOLVED_KEYS = ('env_var_names', 'env_header_names', 'static_env', 'static_headers')
SERVER_POLICY_KEYS = ('disposition', 'reasons')
MAX_RESULT_TEXT_BYTES = 256 * 1024
APPROVAL_MODES = {'auto', 'prompt', 'writes', 'approve'}


class Diagnostic:
    def __init__(self, scope: str, name, reason: str):
        # diagnostics cross JSON boundaries; coerce names at the edge
        self.scope, self.name, self.reason = scope, (name if isinstance(name, str) else str(name)), reason
    def as_dict(self):
        return {'scope': self.scope, 'name': self.name, 'reason': self.reason}


def _tool_policy(server: dict, name: str) -> tuple[dict, list[Diagnostic]]:
    """Normalize effective per-server tool policy. Per-tool
    approval overrides the server default; 'writes'/unknown modes degrade to
    'confirm' with a diagnostic; per-tool 'auto' never lifts a child-side
    mandatory confirmation; tool config keys this plugin cannot honor deny the
    tool outright instead of being silently ignored."""
    diagnostics: list[Diagnostic] = []
    mode = server.get('default_tools_approval_mode', 'prompt')
    if mode not in APPROVAL_MODES:
        diagnostics.append(Diagnostic('mcp', name, f'unknown default_tools_approval_mode {mode!r}; using confirm'))
        mode = 'prompt'
    if mode == 'writes':
        diagnostics.append(Diagnostic('mcp', name,
                                      'approval_mode writes cannot be enforced without trusting readOnlyHint; using confirm'))
    default = 'auto' if mode == 'auto' else 'confirm'
    tools: dict[str, str] = {}
    budgets: dict[str, int] = {}
    denied: set[str] = set(server.get('disabled_tools') or [])
    for tool_name, tool_cfg in (server.get('tools') or {}).items():
        if not isinstance(tool_cfg, dict):
            continue
        unknown = set(tool_cfg) - set(TOOL_FIELD_COMPAT)
        if unknown:  # a genuinely unknown tool field stays fail-closed for that tool
            denied.add(tool_name)
            diagnostics.append(Diagnostic('mcp', f'{name}.{tool_name}',
                                          f'denied: unsupported tool config keys cannot be honored: {sorted(unknown)}'))
            continue
        limit = tool_cfg.get('output_token_limit')
        if limit is not None:
            if isinstance(limit, int) and not isinstance(limit, bool) and limit > 0:
                budgets[tool_name] = min(limit * 4, MAX_RESULT_TEXT_BYTES)  # 4 bytes/token, tighten-only
                diagnostics.append(Diagnostic('mcp', f'{name}.{tool_name}',
                                              f'output budget {budgets[tool_name]} bytes (output_token_limit={limit})'))
            else:
                denied.add(tool_name)
                diagnostics.append(Diagnostic('mcp', f'{name}.{tool_name}',
                                              f'denied: invalid output_token_limit {limit!r}'))
                continue
        tmode = tool_cfg.get('approval_mode')
        if tmode is None:
            continue
        if tmode not in APPROVAL_MODES:
            denied.add(tool_name)
            diagnostics.append(Diagnostic('mcp', f'{name}.{tool_name}',
                                          f'denied: unknown approval_mode {tmode!r}'))
            continue
        if tmode == 'writes':
            diagnostics.append(Diagnostic('mcp', f'{name}.{tool_name}',
                                          'approval_mode writes cannot be enforced; using confirm'))
        tools[tool_name] = 'auto' if tmode == 'auto' else 'confirm'
    return {'approval_default': default, 'tool_approval': tools, 'disabled_tools': sorted(denied), 'tool_output_limits': budgets}, diagnostics


def _num_field(server: dict, key: str, default: float, diagnostics: list[Diagnostic],
               maximum: float = 3600, *, integral: bool = False) -> float:
    """Seconds accept fractions; the legacy millisecond field accepts integers."""
    value = server.get(key, default)
    valid_type = isinstance(value, int) if integral else isinstance(value, (int, float))
    if isinstance(value, bool) or not valid_type or value <= 0 or value > maximum:
        diagnostics.append(Diagnostic('mcp', server.get('name', '?'), f'invalid {key}; using default'))
        return default
    return value


def _is_self_server(entry: dict, codex_home: Path) -> bool:
    """Reject this plugin even through a renamed server, script wrapper or -m."""
    plugin_bin = Path(__file__).resolve().parent.parent / 'bin' / 'subagent-pi'
    plugin_bin = plugin_bin.resolve() if plugin_bin.exists() else None
    args = entry.get('args') or []
    if any(a == '-m' and b in ('subagent_pi', 'subagent-pi') for a, b in zip(args, args[1:])):
        return True
    if plugin_bin is None:
        return False
    command = entry.get('command', '')
    resolved_command = shutil.which(command) if not Path(command).is_absolute() else None
    candidates = [Path(resolved_command or command).expanduser()]
    anchors = [Path(entry['cwd']), codex_home] if entry.get('cwd') else [codex_home]
    for arg in args:
        path = Path(arg).expanduser()
        if path.is_absolute():
            candidates.append(path)
        elif not arg.startswith('-'):
            candidates.extend(anchor / path for anchor in anchors)
    resolved = []
    for path in candidates:
        try:
            resolved.append(path.resolve())
        except OSError:
            resolved.append(path)
    return plugin_bin in resolved


def _enabled_tools(server: dict) -> list[str] | None:
    """Validate enabled_tools; an explicitly empty list allows no tools."""
    enabled = server.get('enabled_tools')
    if enabled is None:
        return None
    if not isinstance(enabled, list) or any(not isinstance(t, str) for t in enabled):
        raise AgentError('invalid_argument', 'enabled_tools must be a list of tool names')
    return sorted(set(enabled))

def _common_config(server, name, diagnostics):
    entry = {}
    policy, pdiag = _tool_policy(server, name)
    entry.update(policy, allowed_tools=_enabled_tools(server))
    diagnostics.extend(pdiag)
    if server.get('startup_timeout_sec') is not None:
        # sec wins over ms when both are present (current Codex semantics)
        if server.get('startup_timeout_ms') is not None:
            diagnostics.append(Diagnostic('mcp', name,
                                          'startup_timeout_ms ignored: startup_timeout_sec takes precedence (Codex semantics)'))
        entry['startup_timeout_sec'] = _num_field(server, 'startup_timeout_sec', 10, diagnostics)
    else:
        entry['startup_timeout_sec'] = _num_field(server, 'startup_timeout_ms', 10000,
            diagnostics, maximum=3600000, integral=True) / 1000
    entry['tool_timeout_sec'] = _num_field(server, 'tool_timeout_sec', 60, diagnostics)
    return entry


def _http_config(server, protocol_mode):
    entry = {}
    entry['protocol_mode'] = protocol_mode if protocol_mode in ('auto', 'legacy_2025_06_18', 'modern_2026_07_28') else 'auto'
    entry['transport'] = 'http'
    url = server['url']
    if not isinstance(url, str) or not url.startswith(('http://', 'https://')):
        raise AgentError('invalid_argument', 'url must be http(s)')
    entry['url'] = url
    if 'auth' in server and server['auth'] != 'bearer':
        raise AgentError('invalid_argument', f"auth={server['auth']!r} (oauth/chatgpt) is not supported in managed children")
    headers = server.get('http_headers') or {}
    env_headers = server.get('env_http_headers') or {}
    if not isinstance(headers, dict) or not isinstance(env_headers, dict) or \
       any(not isinstance(k, str) or not isinstance(v, str) for k, v in {**headers, **env_headers}.items()):
        raise AgentError('invalid_argument', 'http_headers/env_http_headers must map strings to strings')
    entry['static_headers'] = dict(headers)
    entry['env_header_names'] = dict(env_headers)
    entry['bearer_token_env_var'] = server.get('bearer_token_env_var') if isinstance(server.get('bearer_token_env_var'), str) else None
    return entry


def _stdio_config(server, codex_home, protocol_mode, name, diagnostics):
    entry = {}
    entry['transport'] = 'stdio'
    command = server.get('command')
    if not isinstance(command, str) or not command.strip():
        raise AgentError('invalid_argument', 'missing command')
    args = server.get('args', [])
    if not isinstance(args, list) or any(not isinstance(a, str) for a in args):
        raise AgentError('invalid_argument', 'args must be a list of strings')
    env_static = server.get('env') or {}
    env_refs = server.get('env_vars', [])
    if not isinstance(env_refs, list):
        raise AgentError('invalid_argument', 'env_vars must be a list of names or local references')
    if not isinstance(env_static, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in env_static.items()):
        raise AgentError('invalid_argument', 'env must map strings to strings')
    refs: list[str] = []
    for ref in env_refs:
        if isinstance(ref, str):
            refs.append(ref)
        elif isinstance(ref, dict) and isinstance(ref.get('name'), str) and ref.get('source', 'local') in (None, 'local'):
            refs.append(ref['name'])
        elif isinstance(ref, dict) and ref.get('source') == 'remote':
            raise AgentError('invalid_argument', f"env_vars source=remote ({ref.get('name')}) requires remote executor")
        else:
            raise AgentError('invalid_argument', 'env_vars entries must be names')
    # CODEX_MCP_PROTOCOL_VERSION is a Codex CLIENT-side protocol
    # selection marker: consume it here to pick the stdio era and never
    # forward it to the server process (current Codex removes the marker
    # from the env before spawning the MCP server).
    marker = env_static.get('CODEX_MCP_PROTOCOL_VERSION')
    env_static = {k: v for k, v in env_static.items() if k != 'CODEX_MCP_PROTOCOL_VERSION'}
    if marker is not None and marker != '2026-07-28':
        raise AgentError('invalid_argument',
                         f'unsupported CODEX_MCP_PROTOCOL_VERSION {marker!r} (only 2026-07-28 is supported)')
    if marker == '2026-07-28' and protocol_mode == 'legacy_2025_06_18':
        diagnostics.append(Diagnostic('mcp', name,
                                      'global protocol_mode legacy_2025_06_18 keeps this stdio server on the 2025-06-18 handshake; the Codex modern opt-in marker is stripped and not forwarded'))
    entry['protocol_mode'] = ('legacy_2025_06_18'
                              if marker != '2026-07-28' or protocol_mode == 'legacy_2025_06_18'
                              else 'modern_2026_07_28')
    cwd = server.get('cwd')
    if cwd is not None:
        if not isinstance(cwd, str) or not cwd.strip():
            raise AgentError('invalid_argument', 'cwd must be a path string')
        cwd_path = Path(cwd).expanduser()
        if not cwd_path.is_absolute():
            # Codex does not document relative-cwd resolution; anchor to the config source.
            cwd_path = (codex_home / cwd_path).resolve()
            diagnostics.append(Diagnostic('mcp', name, f'relative cwd anchored to codex home: {cwd_path}'))
        cwd = str(cwd_path)
    entry.update(command=command, args=args, static_env=dict(env_static),
                 env_var_names=sorted(set(refs)), cwd=cwd)
    if _is_self_server(entry, codex_home):  # recursion guard by execution definition, rename-evasive
        raise AgentError('invalid_argument', 'subagent-pi management server (recursion guard)')
    return entry


def parse_mcp_servers(codex_home: Path, raw: dict, protocol_mode: str = 'auto') -> tuple[list[dict], list[Diagnostic]]:
    """Convert [mcp_servers.*] TOML into normalized in-memory server configs (no
    environment access here). Every declared server keeps a disposition
    ('ok'|'failed'|'disabled') with reasons; unknown keys that affect execution
    or auth mark the server failed instead of being ignored."""
    diagnostics: list[Diagnostic] = []
    servers: list[dict] = []
    table = raw.get('mcp_servers')
    if table is None:
        return [], diagnostics
    if not isinstance(table, dict):
        diagnostics.append(Diagnostic('mcp', 'mcp_servers', 'not a table; ignored'))
        return [], diagnostics

    def _failed(name, transport, required, reason):
        servers.append({'name': name, 'transport': transport, 'required': required,
                        'disposition': 'failed', 'reasons': [reason]})
        diagnostics.append(Diagnostic('mcp', name, f'disabled: {reason}'))

    for name, server in table.items():
        transport = 'http' if isinstance(server, dict) and 'url' in server else 'stdio'
        required = bool(server.get('required', False)) if isinstance(server, dict) else False
        if not isinstance(server, dict):
            _failed(name, transport, required, 'server entry is not a table')
            continue
        if server.get('enabled') is False:
            servers.append({'name': name, 'transport': transport, 'required': False,
                            'disposition': 'disabled', 'reasons': ['disabled in codex config']})
            diagnostics.append(Diagnostic('mcp', name, 'disabled in codex config'))
            continue
        if len([s for s in servers if s['disposition'] == 'ok']) >= MAX_MCP_SERVERS:
            _failed(name, transport, required, 'server limit exceeded')
            continue
        entry: dict = {'name': name, 'required': required, 'disposition': 'ok', 'reasons': []}
        is_http = 'url' in server
        allowed_keys = MCP_HTTP_KEYS if is_http else MCP_STDIO_KEYS
        unknown = set(server) - allowed_keys
        if unknown:  # unknown_fail_closed: a field absent from the compat table
            _failed(name, transport, required,
                    f'unsupported config keys affecting execution or auth: {sorted(unknown)}')
            continue
        unsupported = [f for f in server if MCP_FIELD_COMPAT[f][0] == 'explicitly_unsupported']
        env_id = server.get('environment_id')
        if env_id not in (None, 'local'):
            unsupported.append('environment_id')
        if unsupported:  # required servers fail; optional ones are excluded with reasons
            why = '; '.join(f'{f}: {MCP_FIELD_COMPAT[f][1]}' for f in unsupported if f != 'environment_id')
            if 'environment_id' in unsupported:
                why = (why + '; ' if why else '') + f'environment_id={env_id!r}: no remote executor in managed children'
            _failed(name, transport, required, why)
            continue
        for f in server:
            if MCP_FIELD_COMPAT[f][0] == 'accepted_no_effect':
                diagnostics.append(Diagnostic('mcp', name, f'{f}: {MCP_FIELD_COMPAT[f][1]}'))
        try:
            entry.update(_common_config(server, name, diagnostics))
            if is_http:
                entry.update(_http_config(server, protocol_mode))
            else:
                entry.update(_stdio_config(server, codex_home, protocol_mode, name, diagnostics))
            servers.append(entry)
        except AgentError as exc:
            _failed(name, transport, required, exc.message)
    return servers, diagnostics


def resolve_environment(servers: list[dict], env_snapshot: dict) -> tuple[list[dict], list[Diagnostic]]:
    """Fill referenced env values from the bound scope snapshot, in memory only.
    Missing values fail the server with named reasons; required failures abort
    with inheritance_required_server_failed so a spawn never starts a task with
    a missing dependency."""
    diagnostics: list[Diagnostic] = []
    required_failures: list[str] = []
    for server in servers:
        if server.get('disposition') != 'ok':
            continue
        problems: list[str] = []
        out = {'env': dict(server.get('static_env', {}))}
        def bind(target, key, var, location=''):
            value = env_snapshot.get(var)
            if value is None:
                problems.append(f'missing env var {var} (scope source{location})')
            else:
                target[key] = value
        if server['transport'] == 'stdio':
            for var in server.get('env_var_names', []):
                bind(out['env'], var, var)
        else:
            out['headers'] = dict(server.get('static_headers', {}))
            for header, var in server.get('env_header_names', {}).items():
                bind(out['headers'], header, var, f', header {header}')
            bearer = server.get('bearer_token_env_var')
            if bearer:
                bind(out, 'bearer_token', bearer, ', bearer token')
        if problems:
            server['disposition'] = 'failed'
            server['reasons'] = problems
            for p in problems:
                diagnostics.append(Diagnostic('mcp', server['name'], p))
            if server.get('required'):
                required_failures.append(server['name'])
            else:
                diagnostics.append(Diagnostic('mcp', server['name'], 'excluded: environment unavailable in this daemon generation'))
            continue
        server.update(out)
    if required_failures:
        raise AgentError('inheritance_required_server_failed',
                         'required MCP server(s) cannot start: ' + ', '.join(sorted(required_failures)))
    return servers, diagnostics


def read_access_diagnostics(servers: list[dict], access: str) -> list[Diagnostic]:
    """Explain read-child restrictions; the bridge enforces them from agent.access."""
    diagnostics: list[Diagnostic] = []
    if access == 'write':
        return diagnostics
    for server in servers:
        if server.get('disposition') == 'ok' and server.get('allowed_tools') is None:
            diagnostics.append(Diagnostic('mcp', server['name'],
                                          'read child: server has no explicit enabled_tools allowlist; only readOnly tools are visible and every call confirms'))
    return diagnostics
