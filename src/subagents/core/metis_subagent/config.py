from __future__ import annotations
import os
import re
from copy import deepcopy
from pathlib import Path
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
    raw = native_config(raw.get('subagents', {})) if raw is not None else {}
    if raw:
        unknown = set(raw) - set(DEFAULT)
        if unknown: raise AgentError('invalid_config', f'Unknown config keys: {sorted(unknown)}')
        for key,value in raw.items():
            if key == 'profiles':
                if 'default' in value:
                    result['profiles']['default'] = {**result['profiles']['default'], **value['default']}
                for name, profile in value.items():
                    if name == 'default': continue
                    result['profiles'][name] = {**result['profiles'].get(name,result['profiles']['default']),**profile}
            else: result[key] = value
    for k in DEFAULT:
        if k in ('profiles','child_env'): continue
        v = result[k]
        if isinstance(v,bool) or not isinstance(v,int) or not 1 <= v <= 10_000_000:
            raise AgentError('invalid_config', f'{k} must be a positive bounded integer')
    for name,profile in result['profiles'].items():
        if not isinstance(profile,dict): raise AgentError('invalid_config',f'Profile {name} must be a table')
        for key in ('ambient_extensions','ambient_skills'):
            if key in profile and not isinstance(profile[key],bool):
                raise AgentError('invalid_config',f'{name}.{key} must be a TOML boolean, not text')
    child_env = result['child_env']
    if not isinstance(child_env,list) or any(not isinstance(x,str) or not x.strip() for x in child_env):
        raise AgentError('invalid_config','subagents.childEnv must be a list of environment variable names')
    return result

def surface_extension_path() -> Path:
    """The shipped extension that applies (and reads back) a profile's built-in
    tool surface inside the child."""
    return Path(__file__).resolve().parent.parent/'extensions'/'managed-surface.ts'

def launch_spec(config, profile_name, model, cwd, access, thinking=None, host=None):
    if profile_name not in config['profiles']: raise AgentError('profile_not_found',f'Unknown profile: {profile_name}')
    p = config['profiles'][profile_name]
    unknown = set(p) - PROFILE_KEYS
    if unknown: raise AgentError('invalid_config',f'Unknown profile keys: {sorted(unknown)}')
    if not host or host.get('kind') != 'pi':
        raise AgentError('invalid_parent','Native subagents require the trusted Pi parent SDK')
    executable = host['node_path']
    tools = p.get('tools',[])
    if not isinstance(tools,list) or any(t not in PI_BUILTIN_TOOLS for t in tools):
        raise AgentError('invalid_config','tools must be a list of Pi builtin names')
    if access == 'read':
        tools = [t for t in tools if t in {'read','grep','find','ls'}]
    env = p.get('env',{})
    if not isinstance(env,dict) or any(not isinstance(k,str) or not isinstance(v,str) for k,v in env.items()):
        raise AgentError('invalid_config','profile env must contain string values')
    argv = [executable,str(Path(host['sdk_path']).with_name('cli.js')),'--mode','rpc']
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
