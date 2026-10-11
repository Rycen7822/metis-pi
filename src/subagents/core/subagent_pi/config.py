from __future__ import annotations
import os
import json
import re
from copy import deepcopy
from pathlib import Path
import shutil
import tomllib
from .common import AgentError, text

# The packaged TOML owns defaults AND canonical field names; runtime uses snake_case.
BUNDLED = tomllib.loads((Path(__file__).resolve().parents[4]/'metis-pi.toml').read_text(encoding='utf-8-sig'))['subagents']
PROFILE_FIELDS = set(BUNDLED['profiles']['default']) | {'model', 'provider', 'thinking', 'env'}

def snake_key(key):
    return re.sub(r'[A-Z]', lambda match: '_'+match[0].lower(), key)

def translate_table(raw, fields, name):
    if not isinstance(raw, dict): raise AgentError('invalid_config', f'{name} must be a table')
    unknown = set(raw) - set(fields)
    if unknown: raise AgentError('invalid_config', f'Unknown {name} keys: {sorted(unknown)}')
    return {snake_key(key): value for key, value in raw.items()}

def native_config(raw):
    result = translate_table(raw, BUNDLED, 'subagents')
    if not isinstance(result.pop('enabled', True), bool): raise AgentError('invalid_config', 'subagents.enabled must be a boolean')
    if 'inheritance' in result:
        result['inheritance'] = translate_table(result['inheritance'], BUNDLED['inheritance'], 'subagents.inheritance')
        if result['inheritance'].get('codex_home') == '': result['inheritance']['codex_home'] = None
    if 'profiles' in result:
        if not isinstance(result['profiles'], dict): raise AgentError('invalid_config', 'subagents.profiles must be a table')
        result['profiles'] = {name: translate_table(profile, PROFILE_FIELDS, f'subagents.profiles.{name}')
                              for name, profile in result['profiles'].items()}
    return result

DEFAULT = native_config(BUNDLED)
PROFILE_KEYS = {snake_key(key) for key in PROFILE_FIELDS}

def metis_config_path():
    explicit = os.environ.get('METIS_PI_CONFIG')
    if explicit: return Path(explicit).expanduser().resolve()
    # --home/PI_AGENTS_HOME select state, not another preferences source.
    agent_dir = Path(os.environ.get('PI_CODING_AGENT_DIR', str(Path.home()/'.pi/agent'))).expanduser().resolve()
    return agent_dir / 'metis-pi.toml'
# Pi's built-in tools (dist/core/tools/index.js `allToolNames`). A profile's
# `tools` is its ALLOWED built-in surface, applied by extensions/managed-surface.ts
# because both CLI filters are wrong for it: --tools is an allowlist over
# built-in, extension and custom tools, and --exclude-tools filters the same
# registry BY NAME, so either one would also drop a tool an extension registered
# under a built-in name.
PI_BUILTIN_TOOLS = ('read','bash','powershell','edit','write','grep','find','ls')

def read_document(path, parser):
    try:
        document = parser(path.read_text(encoding='utf-8-sig'))
        if not isinstance(document, dict): raise ValueError('not a table')
        return document
    except FileNotFoundError: return None
    except (OSError, ValueError) as error:
        raise AgentError('invalid_config', f'Cannot read subagent configuration at {path}: {type(error).__name__}') from error

def load_config(home: Path):
    result = deepcopy(DEFAULT)
    native = metis_config_path()
    raw = read_document(native, tomllib.loads)
    if raw is None:
        result['pi_command'] = [os.environ.get('PI_AGENTS_PI', 'pi')]
        former = read_document(native.parent/'subagents.json', json.loads)
        if former is not None and 'maxConcurrent' in former: result['max_resident_agents'] = former['maxConcurrent']
        raw = read_document(home/'config.toml', tomllib.loads)
    else: raw = native_config(raw.get('subagents', {}))
    if raw is not None:
        # Existing config values now specify inactivity, never total runtime.
        if 'default_run_timeout_seconds' in raw:
            old = raw.pop('default_run_timeout_seconds')
            raw.setdefault('default_idle_timeout_seconds',old)
        unknown = set(raw) - set(DEFAULT) - {'pi_command'}
        if unknown: raise AgentError('invalid_config', f'Unknown config keys: {sorted(unknown)}')
        for key,value in raw.items():
            if key == 'profiles':
                for name, profile in value.items():
                    result['profiles'][name] = {**result['profiles'].get(name,result['profiles']['default']),**profile}
            elif key == 'inheritance':
                if not isinstance(value,dict): raise AgentError('invalid_config','inheritance must be a table')
                unknown_inh = set(value) - set(DEFAULT['inheritance'])
                if unknown_inh: raise AgentError('invalid_config',f'Unknown inheritance keys: {sorted(unknown_inh)}')
                merged = dict(result['inheritance']); merged.update(value)
                for flag in ('enabled','skills','mcp'):
                    if not isinstance(merged[flag],bool): raise AgentError('invalid_config',f'inheritance.{flag} must be a TOML boolean')
                if merged['mcp_protocol_mode'] not in ('auto','legacy_2025_06_18','modern_2026_07_28'):
                    raise AgentError('invalid_config','inheritance.mcp_protocol_mode must be auto, legacy_2025_06_18 or modern_2026_07_28')
                child_env = merged.get('child_env',[])
                if not isinstance(child_env,list) or any(not isinstance(x,str) or not x.strip() for x in child_env):
                    raise AgentError('invalid_config','inheritance.child_env must be a list of environment variable names')
                merged['child_env']=child_env
                home = merged.get('codex_home')
                if home is not None:
                    if not isinstance(home,str) or not home.strip(): raise AgentError('invalid_config','inheritance.codex_home must be a path string')
                    resolved = Path(home).expanduser().resolve()
                    if not resolved.is_dir(): raise AgentError('invalid_config',f'inheritance.codex_home does not exist: {resolved}')
                    merged['codex_home'] = str(resolved)
                result['inheritance'] = merged
            else: result[key] = value
    for k in DEFAULT:
        if k in ('profiles','inheritance','pi_command'): continue
        v = result[k]
        if isinstance(v,bool) or not isinstance(v,int) or not 1 <= v <= 10_000_000:
            raise AgentError('invalid_config', f'{k} must be a positive bounded integer')
    for name,profile in result['profiles'].items():
        if not isinstance(profile,dict): raise AgentError('invalid_config',f'Profile {name} must be a table')
        for key in ('ambient_extensions','ambient_skills'):
            if key in profile and not isinstance(profile[key],bool):
                raise AgentError('invalid_config',f'{name}.{key} must be a TOML boolean, not text')
    command = result['pi_command']
    if not isinstance(command,list) or not command or any(not isinstance(x,str) or not x or '\x00' in x for x in command):
        raise AgentError('invalid_config','pi_command must be a nonempty argv list')
    return result

def surface_extension_path() -> Path:
    """The shipped extension that applies (and reads back) a profile's built-in
    tool surface inside the child."""
    return Path(__file__).resolve().parent.parent/'extensions'/'managed-surface.ts'

def context_extension_path() -> Path:
    return Path(__file__).resolve().parent.parent/'extensions'/'managed-context.ts'

def managed_context_argv(argv):
    """Apply the current context policy to new AND persisted pre-upgrade launches."""
    extension = context_extension_path()
    if not extension.is_file():
        raise AgentError('invalid_config',f'Managed context extension is missing: {extension}')
    result = list(argv)
    if '--no-context-files' not in result: result.append('--no-context-files')
    if str(extension) not in result: result += ['--extension',str(extension)]
    return result

def launch_spec(config, profile_name, model, cwd, access, thinking=None, host=None):
    if profile_name not in config['profiles']: raise AgentError('profile_not_found',f'Unknown profile: {profile_name}')
    p = config['profiles'][profile_name]
    unknown = set(p) - PROFILE_KEYS
    if unknown: raise AgentError('invalid_config',f'Unknown profile keys: {sorted(unknown)}')
    executable = host['node_path'] if host else shutil.which(config['pi_command'][0])
    if not executable:
        raise AgentError(
            "pi_not_found",
            "Pi executable not found; set subagents.piCommand in metis-pi.toml or PI_AGENTS_PI (legacy bridge only)",
        )
    tools = p.get('tools',[])
    if not isinstance(tools,list) or any(t not in PI_BUILTIN_TOOLS for t in tools):
        raise AgentError('invalid_config','tools must be a list of Pi builtin names')
    if access == 'read':
        tools = [t for t in tools if t in {'read','grep','find','ls'}]
    env = p.get('env',{})
    if not isinstance(env,dict) or any(not isinstance(k,str) or not isinstance(v,str) for k,v in env.items()):
        raise AgentError('invalid_config','profile env must contain string values')
    argv = ([executable,str(Path(host['sdk_path']).with_name('cli.js')),'--mode','rpc'] if host else
            managed_context_argv([executable,*config['pi_command'][1:],'--mode','rpc']))
    # Pi's own configuration (extensions, packages, skills, prompts, settings,
    # MCP-capable extensions) loads by default; --no-extensions/--no-skills exist
    # only as an explicit per-profile opt-out.
    if not p.get('ambient_extensions',True): argv.append('--no-extensions')
    if not p.get('ambient_skills',True): argv.append('--no-skills')
    # Built-in surface: never an allowlist or a name-based denylist (see
    # PI_BUILTIN_TOOLS); a profile that restricts it requires the shipped
    # activator, and the daemon verifies its report before the boot counts.
    builtins = [t for t in PI_BUILTIN_TOOLS if t in tools]
    restrict = host is not None or set(builtins) != set(PI_BUILTIN_TOOLS)
    surface = surface_extension_path()
    if restrict:
        if not surface.is_file():
            raise AgentError('invalid_config',f'Restricting built-in tools requires {surface}; restore it or allow every built-in tool')
        argv += ['--extension',str(surface)]
    # --extension and --skill are repeatable and additive, so profile entries and
    # inherited entries can coexist without merging flags.
    for flag,key in [('--extension','extensions'),('--skill','skills')]:
        paths = p.get(key,[])
        if not isinstance(paths,list): raise AgentError('invalid_config',f'{key} must be a list')
        for raw in paths:
            resolved = Path(text(raw,key)).expanduser().resolve()
            if not resolved.exists(): raise AgentError('invalid_config',f'Missing {key} path: {resolved}')
            argv += [flag,str(resolved)]
    actual_model = model or p.get('model')
    if host and not actual_model:
        if not host['model']: raise AgentError('model_unavailable','The Pi parent has no model; select one explicitly')
        actual_model = host['model']['provider']+'/'+host['model']['id']
    if actual_model: argv += ['--model',text(actual_model,'model',512)]
    if p.get('provider') and not (host and model): argv += ['--provider',text(p['provider'],'provider',128)]
    actual_thinking = thinking if thinking is not None else p.get('thinking')
    if actual_thinking is not None: argv += ['--thinking',text(actual_thinking,'thinking',32)]
    return {'argv':argv,'cwd':cwd,'profile':profile_name,'access':access,'model':actual_model,'env':env,
            'builtins':builtins,'surface':restrict,
            **({'host':'pi','sdk_path':host['sdk_path']} if host else {})}
