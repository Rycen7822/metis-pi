"""Narrow Codex-source resolver: codex home, global skills, in-memory MCP config.
Reads original files at resolution time; secrets resolve only in the daemon for
the bound scope, and diagnostics carry names/sources, never values."""
from __future__ import annotations
from pathlib import Path
import re
import tomllib

from .common import AgentError, BASE_ENV_KEYS
from .mcp_config import Diagnostic, parse_mcp_servers

MAX_MANAGED_SKILLS = 64
MAX_ENV_VARS = 64
MAX_ENV_VALUE = 16384
# The snapshot additionally captures CODEX_HOME: it is a source pointer the daemon
# resolves itself, so it is bound for the scope but never forwarded to a child.
SNAPSHOT_ENV_KEYS = BASE_ENV_KEYS + ('CODEX_HOME',)
MANAGEMENT_SKILL_NAMES = {'subagent-pi'}


def resolve_codex_home(inh: dict, source_env: dict | None) -> tuple[Path | None, str]:
    """Explicit trusted setting -> scope-bound CODEX_HOME -> ~/.codex.
    A configured source that does not exist is an error, never a silent fallback:
    only an UNSET source falls back, and only the user default may be absent."""
    explicit = inh.get('codex_home')
    if explicit:
        home = Path(explicit).expanduser()
        if not home.is_dir():
            raise AgentError('inheritance_source_unreadable',
                             f'inheritance.codex_home does not exist: {home}')
        return home, 'explicit'
    bound = (source_env or {}).get('CODEX_HOME')
    if isinstance(bound, str) and bound.strip():
        home = Path(bound).expanduser()
        if not home.is_dir():
            raise AgentError('inheritance_source_unreadable',
                             f'CODEX_HOME from the scope source does not exist: {home}')
        return home, 'scope_env'
    home = Path.home() / '.codex'
    if home.is_dir():
        return home, 'user_default'
    return None, 'user_default'


def read_codex_config(codex_home: Path) -> dict:
    file = codex_home / 'config.toml'
    if not file.is_file():
        return {}
    try:
        with file.open('rb') as f:
            return tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError):
        raise AgentError('inheritance_source_unreadable', f'Cannot read {file}')


def _skill_name(skill_md: Path) -> str | None:
    """Minimal frontmatter name parse for conflict detection; Pi parses the full file."""
    try:
        head = skill_md.read_text(encoding='utf-8', errors='replace')[:4096]
    except OSError:
        return None
    match = re.match(r'\ufeff?---\s*\n(.*?)\n---', head, re.DOTALL)
    if not match:
        return None
    m = re.search(r'^name:\s*["\']?([^"\'\n]+?)["\']?\s*$', match.group(1), re.MULTILINE)
    return m.group(1).strip() if m else None


def pi_skill_name(skill_md: Path) -> str:
    """The name Pi registers for a SKILL.md: frontmatter `name`, else the parent
    directory name (dist/core/skills.js). Used to line inherited paths up with
    Pi's own skill registry; Pi itself stays the authority on collisions."""
    return _skill_name(skill_md) or skill_md.parent.name


def _disabled_skill_paths(codex_home: Path, raw: dict) -> set[Path]:
    disabled: set[Path] = set()
    for entry in raw.get('skills', {}).get('config', []) if isinstance(raw.get('skills'), dict) else []:
        if not isinstance(entry, dict) or entry.get('enabled') is not False:
            continue
        path = entry.get('path')
        if isinstance(path, str) and path.strip():
            p = Path(path).expanduser()
            disabled.add(p.resolve() if p.is_absolute() else (codex_home / p).resolve())
    return disabled


def collect_skills(codex_home: Path, raw: dict, project_cwd: str | None,
                   existing_skill_paths: list[str]) -> tuple[list[str], list[Diagnostic]]:
    """Resolve managed-child skill sources (existing profile paths, project
    .agents/skills, <codex_home>/skills); dedup by real path, refuse ambiguous
    name conflicts, honor disabled entries."""
    diagnostics: list[Diagnostic] = []
    selected: list[str] = []
    by_real: set[Path] = set()
    by_name: dict[str, str] = {}
    plugin_root = Path(__file__).resolve().parent.parent
    disabled = _disabled_skill_paths(codex_home, raw)

    for raw_path in existing_skill_paths:
        selected.append(raw_path)
        real = Path(raw_path).resolve()
        by_real.add(real)
        name = _skill_name(real / 'SKILL.md') if real.is_dir() else None
        if name:
            by_name.setdefault(name, raw_path)

    sources: list[Path] = []
    if project_cwd:
        agents = Path(project_cwd) / '.agents' / 'skills'
        if agents.is_dir():
            sources.append(agents)
    codex_skills = codex_home / 'skills'
    if codex_skills.is_dir():
        sources.append(codex_skills)
    else:
        diagnostics.append(Diagnostic('skills', codex_home / 'skills', 'codex global skills directory not present; treated as empty'))

    count = 0
    for directory in sources:
        try:
            entries = sorted(p for p in directory.iterdir() if not p.name.startswith('.'))
        except OSError as exc:
            diagnostics.append(Diagnostic('skills', directory, f'not readable: {type(exc).__name__}'))
            continue
        for entry in entries:
            skill_md = entry / 'SKILL.md'
            if not skill_md.is_file():
                continue
            real = entry.resolve()
            if real in by_real:
                continue  # already provided by project/profile source
            label = entry.name
            if (entry / 'agents').is_dir():
                diagnostics.append(Diagnostic('skills', label,
                                              'codex-specific policy metadata present (agents/); it is not interpreted or enforced by Pi'))
            if real in disabled or skill_md.resolve() in disabled:
                diagnostics.append(Diagnostic('skills', label, 'disabled by codex skills.config'))
                continue
            if real.is_relative_to(plugin_root):
                diagnostics.append(Diagnostic('skills', label, 'excluded: subagent-pi management skill (recursion guard)'))
                continue
            name = _skill_name(skill_md)
            if name and name in MANAGEMENT_SKILL_NAMES:
                diagnostics.append(Diagnostic('skills', label, 'excluded: subagent-pi management skill (recursion guard)'))
                continue
            if name and name in by_name:
                diagnostics.append(Diagnostic('skills', label,
                                              f'name conflict with {by_name[name]}; refusing ambiguous skill name {name!r}'))
                continue
            if count >= MAX_MANAGED_SKILLS:
                diagnostics.append(Diagnostic('skills', label, 'skill limit exceeded; remaining codex skills skipped'))
                continue
            selected.append(str(real))
            by_real.add(real)
            if name:
                by_name[name] = str(real)
            count += 1
    return selected, diagnostics


def capture_scope_env(codex_home: Path | None, environ: dict,
                      extra_names: list[str] | tuple[str, ...] = ()) -> dict:
    """Client-side snapshot: base keys + vars the config references + authorized
    child-env names, bounded in count and size."""
    names = set(SNAPSHOT_ENV_KEYS) | {n for n in extra_names if isinstance(n, str) and n.strip()}
    if codex_home is not None:
        try:
            servers, _ = parse_mcp_servers(codex_home, read_codex_config(codex_home))
        except AgentError:
            servers = []
        names |= referenced_env_names(servers)
    snapshot: dict[str, str] = {}
    for name in sorted(names):
        value = environ.get(name)
        if isinstance(value, str) and len(value) <= MAX_ENV_VALUE:
            snapshot[name] = value
            if len(snapshot) == MAX_ENV_VARS:
                break
    return snapshot


def referenced_env_names(servers: list[dict]) -> set[str]:
    """Env var NAMES a server list references, including base keys, so callers can
    treat one set as the full allowlist."""
    names: set[str] = set(SNAPSHOT_ENV_KEYS)
    for server in servers:
        names.update(server.get('env_var_names', []))
        names.update((server.get('env_header_names') or {}).values())
        if server.get('bearer_token_env_var'):
            names.add(server['bearer_token_env_var'])
    return names


def scope_source_snapshot(home: Path, environ: dict) -> dict:
    """Trusted client-side snapshot for scope binding (CLI launcher and Codex-spawned
    MCP adapter). With the inheritance master switch off this binds ONLY the base
    worker environment: no Codex directory is read, so an invalid or missing
    CODEX_HOME cannot break a normal worker start."""
    from .config import load_config  # local import: config owns the state home layout
    cfg = load_config(home)
    inh = cfg['inheritance']
    child_env = inh.get('child_env', [])
    if not inh.get('enabled', True):
        return {'env': capture_scope_env(None, environ, extra_names=child_env)}
    codex_home, _ = resolve_codex_home(inh, {'CODEX_HOME': environ.get('CODEX_HOME')})
    return {'env': capture_scope_env(codex_home, environ, extra_names=child_env)}
