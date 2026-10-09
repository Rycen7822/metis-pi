"""Scope binding: child environment, Codex source pointer and the inheritance plan
rebuilt at every boot. Values resolve here; only the base keys are persisted."""
from __future__ import annotations
import json
from pathlib import Path

from .common import AgentError, BASE_ENV_KEYS, PROXY_ENV_KEYS, dumps, text, now
from .inheritance import collect_skills, read_codex_config, referenced_env_names, resolve_codex_home
from .mcp_config import (CODEX_MCP_BASELINE, SERVER_POLICY_KEYS, SERVER_RESOLVED_KEYS, Diagnostic,
    parse_mcp_servers, read_access_diagnostics, resolve_environment)

class ScopeBindings:
    def __init__(self, store, config):
        self.store = store
        self.config = config
        self.scope_env = {}  # bound secrets stay in memory
        self.pi_trust = {}  # session-only approvals, never persisted in launches

    def remember_pi_source(self, sid, source):
        """Restore authenticated session-only state; scope_open alone persists base keys."""
        env=(source or {}).get('env')
        if env is not None:
            names=BASE_ENV_KEYS + PROXY_ENV_KEYS + tuple(self.config['inheritance'].get('child_env',[]))
            self.scope_env[sid]={k:v for k,v in env.items() if k in names}
        trust=(source or {}).get('project_trust')
        if trust is None: return
        if not isinstance(trust,dict) or set(trust)!={'cwd','trusted'} or not isinstance(trust['trusted'],bool):
            raise AgentError('invalid_parent','Invalid project trust decision')
        path=Path(text(trust['cwd'],'cwd',4096))
        if not path.is_absolute() or not path.is_dir(): raise AgentError('invalid_parent','Project trust cwd must be an existing absolute directory')
        lease=source['parent']['lease']
        current=self.pi_trust.get(sid)
        grants=current['grants'] if current and current['lease']==lease else {}
        if len(grants)>=64 and str(path.resolve()) not in grants: raise AgentError('invalid_parent','Too many session-only project grants')
        grants[str(path.resolve())]=trust['trusted']
        self.pi_trust[sid]={'lease':lease,'grants':grants}

    def child_env(self, sid, spec):
        """Base environment for the guard/Pi child, built from the scope's bound
        snapshot, including proxy routing — never a copy of the daemon's environ. Env-based model auth
        requires explicitly configured names (inheritance.child_env); profile env
        values come from the current config, never from the persisted copy.
        A daemon restart drops the in-memory snapshot, so the non-secret base keys
        reload from the ledger; other bound values stay gone until a rebind."""
        snapshot = {**self.persisted_base_env(sid), **self.scope_env.get(sid, {})}
        inh = self.config['inheritance']
        allowed = set(BASE_ENV_KEYS + PROXY_ENV_KEYS) | {k for k in inh.get('child_env', []) if isinstance(k, str)}
        env = {k: v for k, v in snapshot.items() if k in allowed and isinstance(v, str)}
        profile = self.config['profiles'].get(spec.get('profile'), {}) if isinstance(self.config['profiles'], dict) else {}
        penv = profile.get('env', {}) if isinstance(profile, dict) else {}
        if isinstance(penv, dict):
            env.update({k: v for k, v in penv.items() if isinstance(k, str) and isinstance(v, str)})
        env['PI_AGENTS_MANAGED_CHILD'] = '1'
        parent=json.loads(self.store.scope(sid)['parent'] or 'null')
        if parent and parent.get('kind')=='pi':
            env['PI_CODING_AGENT_DIR']=parent['agent_dir']
            env['PI_AGENTS_HOST']='pi'
            env['PI_AGENTS_CHILD_ACCESS']=spec['access']
            env['PI_AGENTS_PARENT_SESSION']=parent['session_file']
            trust=self.pi_trust.get(sid)
            if trust and trust['lease']==parent['lease'] and parent['expires']>now():
                decision=trust['grants'].get(spec['cwd'])
                if decision is not None: env['PI_AGENTS_PROJECT_TRUST']='1' if decision else '0'
        return env

    def persisted_base_env(self, sid):
        """Base keys (PATH/HOME/...) survive a restart because they are not
        secrets; they are stored per scope so a respawned worker can still find
        its interpreter. Everything else bound to the scope stays in memory."""
        row = self.store.one('SELECT base_env FROM scopes WHERE id=?', (sid,))
        if not row or not row['base_env']:
            return {}
        try:
            value = json.loads(row['base_env'])
        except ValueError:
            return {}
        if not isinstance(value, dict):
            return {}
        return {k: v for k, v in value.items() if k in BASE_ENV_KEYS and isinstance(v, str)}

    def remember_base_env(self, sid, snapshot):
        base = {k: v for k, v in snapshot.items() if k in BASE_ENV_KEYS and isinstance(v, str)}
        self.store.execute('UPDATE scopes SET base_env=? WHERE id=?', (dumps(base) if base else None, sid))

    def bind_scope_source(self, sid, p, source):
        """Bind a scope in two independent layers: layer 1 (always) the worker base
        environment/proxies from the opening client plus authorized child_env names — a
        child must find its interpreter whether or not Codex inheritance is on;
        layer 2 (master switch on) the Codex source pointer. Secrets stay in
        memory in both layers."""
        inh=self.config['inheritance']
        scope=self.store.scope(sid)
        env = source.get('env') if isinstance(source,dict) else None
        if ((source or {}).get('parent') or {}).get('kind')=='pi':
            self.remember_pi_source(sid,source)
            self.store.execute('UPDATE scopes SET inheritance=0 WHERE id=?',(sid,))
            if env is not None: self.remember_base_env(sid,self.scope_env[sid])
            return
        master_enabled = bool(inh.get('enabled',True))
        explicit_home = p.get('codex_home')
        if explicit_home is not None:
            explicit_home = str(Path(text(explicit_home,'codex_home',4096)).expanduser().resolve())
            if not Path(explicit_home).is_dir(): raise AgentError('invalid_cwd','codex_home must be an existing directory')
        home=None; mode=None
        if master_enabled:
            home,mode = resolve_codex_home({**inh,'codex_home':explicit_home or inh.get('codex_home')},env)
            stored=scope['codex_home']
            if stored and home and Path(stored)!=Path(home) and explicit_home is None and p.get('inheritance') is None:
                raise AgentError('inheritance_source_conflict',
                    f'Scope is bound to codex source {stored}; rebind explicitly with codex_home or inheritance parameters')
        # A credential refresh must not silently flip the per-scope switch.
        enabled=bool(scope['inheritance'])
        if p.get('inheritance') is False: enabled=False
        elif p.get('inheritance') is True: enabled=True
        # Layer-2 fields stay untouched while the master switch is off, so
        # re-enabling later does not find them clobbered by a disabled-era rebind.
        self.store.execute('UPDATE scopes SET codex_home=?,codex_source=?,inheritance=? WHERE id=?',
            ((str(home) if home else scope['codex_home']) if master_enabled else scope['codex_home'],
             (mode if home else scope['codex_source']) if master_enabled else scope['codex_source'],
             1 if enabled else 0, sid))
        if env is not None:
            names=set(BASE_ENV_KEYS + PROXY_ENV_KEYS) | {k for k in inh.get('child_env',[]) if isinstance(k,str)}
            if master_enabled and home is not None:
                try:
                    servers,_=parse_mcp_servers(home,read_codex_config(home))
                    names |= referenced_env_names(servers)
                except AgentError:
                    pass
            # Minimal per-scope snapshot: referenced names only. Secrets stay in
            # memory; only the non-secret base keys are persisted for restarts.
            self.scope_env[sid]={k:v for k,v in env.items() if k in names}
            self.remember_base_env(sid, self.scope_env[sid])

    def inheritance_plan(self, a, spec, generation):
        """Recompute managed-child inheritance from the original sources at boot.
        The persisted launch argv is never touched; secrets resolve into the pipe
        payload only, diagnostics carry names, never values."""
        inh = self.config['inheritance']
        empty = {'argv': [], 'payload': None, 'diagnostics': [], 'bridge': False, 'servers': [], 'skills': []}
        if not inh.get('enabled'):
            return {**empty, 'reason': 'inheritance disabled by config'}
        scope = self.store.scope(a['scope'])
        if not scope['inheritance']:
            return {**empty, 'reason': 'inheritance disabled for this scope'}
        source_env = self.scope_env.get(a['scope'])
        if scope['codex_home']:
            codex_home, mode = Path(scope['codex_home']), scope['codex_source'] or 'scope_env'
        elif source_env and isinstance(source_env.get('CODEX_HOME'), str) and source_env['CODEX_HOME'].strip():
            codex_home, mode = resolve_codex_home(self.config['inheritance'], source_env)
        elif scope['codex_source']:
            # A restart wiped the snapshot: never fall back to another Codex home
            # (e.g. the daemon user's ~/.codex); demand an explicit rebind.
            raise AgentError('inheritance_source_unbound',
                             'Scope lost its codex source binding after a daemon restart; the owning client must re-open the scope')
        else:
            codex_home, mode = resolve_codex_home(self.config['inheritance'], source_env)
        if codex_home is None:
            diag = Diagnostic('source', 'codex_home', 'no codex source directory found').as_dict()
            return {**empty, 'diagnostics': [diag], 'reason': 'no source'}
        raw = read_codex_config(codex_home)
        existing_skills = [spec['argv'][i + 1] for i, flag in enumerate(spec['argv']) if flag == '--skill']
        skill_paths, skill_diag = [], []
        if inh.get('skills', True):
            skill_paths, skill_diag = collect_skills(codex_home, raw, a['cwd'], existing_skills)
        servers, mcp_diag = [], []
        if inh.get('mcp', True):
            servers, mcp_diag = parse_mcp_servers(codex_home, raw, inh.get('mcp_protocol_mode', 'auto'))
            servers, env_diag = resolve_environment(servers, source_env or {})
            mcp_diag += env_diag
            mcp_diag += read_access_diagnostics(servers, spec['access'])
        required_broken = [s['name'] for s in servers if s.get('required') and s.get('disposition') != 'ok']
        if required_broken:
            raise AgentError('inheritance_required_server_failed',
                             'required MCP server(s) cannot start: ' + ', '.join(sorted(required_broken)))
        usable = [s for s in servers if s.get('disposition') == 'ok']
        diagnostics = [d.as_dict() for d in skill_diag + mcp_diag]
        argv = []
        inherited_skills = [p for p in skill_paths if p not in existing_skills]
        for path in inherited_skills:
            argv += ['--skill', path]
        bridge_path = Path(__file__).resolve().parent.parent / 'extensions' / 'codex-mcp-bridge.ts'
        load_bridge = bool(inh.get('mcp', True) and usable and bridge_path.exists())
        source = {'codex_home': str(codex_home), 'mode': mode}
        payload = None
        if load_bridge:
            argv += ['--extension', str(bridge_path)]
            internal = (*SERVER_RESOLVED_KEYS, *SERVER_POLICY_KEYS)
            payload = {'v': 1,
                       'agent': {'id': a['id'], 'access': spec['access'], 'generation': generation},
                       'source': source,
                       'mcp': {'servers': [{k: v for k, v in s.items() if k not in internal} for s in usable]}}
        return {'argv': argv, 'payload': payload, 'diagnostics': diagnostics,
                'bridge': load_bridge, 'servers': [s['name'] for s in usable], 'source': source,
                'skills': inherited_skills}

    def doctor(self):
        inh=self.config['inheritance']
        report={'baseline':CODEX_MCP_BASELINE,
                'config':{k:inh.get(k) for k in ('enabled','skills','mcp','codex_home','mcp_protocol_mode')},'scopes':[],
                'note':'Environment variable and header values are never shown; only names and sources.'}
        for s in self.store.all('SELECT * FROM scopes ORDER BY created DESC LIMIT 100'):
            entry={'scope':s['id'],'label':s['label'],'cwd':s['cwd'],
                   'inheritance_enabled':bool(s['inheritance']) and bool(inh.get('enabled',True)),
                   'codex_home':s['codex_home'],'source_mode':s['codex_source'],
                   'bound_env_names':sorted(self.scope_env.get(s['id'],{}))}
            if inh.get('enabled') and s['inheritance'] and s['codex_home']:
                home=Path(s['codex_home'])
                try:
                    raw=read_codex_config(home)
                    skills,skill_diag=collect_skills(home,raw,s['cwd'],[])
                    servers,mcp_diag=parse_mcp_servers(home,raw)
                    try:
                        servers,env_diag=resolve_environment(servers,self.scope_env.get(s['id'],{}))
                        mcp_diag+=env_diag
                    except AgentError as exc:
                        mcp_diag.append(Diagnostic('mcp','required',exc.message))
                    entry.update(inherited_skills=[{'path':path,'name':Path(path).name} for path in skills],
                                 mcp_servers=[{'name':x['name'],'transport':x['transport'],
                                               'disposition':x.get('disposition'),'required':x.get('required',False),
                                               'reasons':x.get('reasons',[])} for x in servers],
                                 diagnostics=[d.as_dict() for d in skill_diag+mcp_diag])
                except AgentError as exc:
                    entry['error']=exc.as_dict()
            report['scopes'].append(entry)
        return report
