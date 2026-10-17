"""Native Pi scope environment and session-only project trust."""
from __future__ import annotations
import json
from pathlib import Path
from .common import AgentError, BASE_ENV_KEYS, PROXY_ENV_KEYS, dumps, text, now

class ScopeBindings:
    def __init__(self, store, config):
        self.store, self.config = store, config
        self.scope_env = {}
        self.pi_trust = {}

    def remember_pi_source(self, sid, source):
        env = (source or {}).get('env')
        if env is not None:
            names = BASE_ENV_KEYS + PROXY_ENV_KEYS + tuple(self.config['child_env'])
            self.scope_env[sid] = {k:v for k,v in env.items() if k in names}
        trust = (source or {}).get('project_trust')
        if trust is None: return
        if not isinstance(trust,dict) or set(trust)!={'cwd','trusted'} or not isinstance(trust['trusted'],bool):
            raise AgentError('invalid_parent','Invalid project trust decision')
        path = Path(text(trust['cwd'],'cwd',4096))
        if not path.is_absolute() or not path.is_dir():
            raise AgentError('invalid_parent','Project trust cwd must be an existing absolute directory')
        lease = source['parent']['lease']
        current = self.pi_trust.get(sid)
        grants = current['grants'] if current and current['lease']==lease else {}
        if len(grants)>=64 and str(path.resolve()) not in grants:
            raise AgentError('invalid_parent','Too many session-only project grants')
        grants[str(path.resolve())] = trust['trusted']
        self.pi_trust[sid] = {'lease':lease,'grants':grants}

    def child_env(self, sid, spec):
        # Persist only non-secret base locations; auth/proxy values stay in memory.
        snapshot = {**self.persisted_base_env(sid), **self.scope_env.get(sid,{})}
        allowed = set(BASE_ENV_KEYS + PROXY_ENV_KEYS) | set(self.config['child_env'])
        env = {k:v for k,v in snapshot.items() if k in allowed and isinstance(v,str)}
        profile = self.config['profiles'].get(spec.get('profile'),{})
        env.update(profile.get('env',{}))
        env['PI_AGENTS_MANAGED_CHILD'] = '1'
        parent = json.loads(self.store.scope(sid)['parent'])
        env['PI_CODING_AGENT_DIR'] = parent['agent_dir']
        env['PI_AGENTS_HOST'] = 'pi'
        env['PI_AGENTS_CHILD_ACCESS'] = spec['access']
        env['PI_AGENTS_PARENT_SESSION'] = parent['session_file']
        trust = self.pi_trust.get(sid)
        if trust and trust['lease']==parent['lease'] and parent['expires']>now():
            decision = trust['grants'].get(spec['cwd'])
            if decision is not None: env['PI_AGENTS_PROJECT_TRUST'] = '1' if decision else '0'
        return env

    def persisted_base_env(self, sid):
        row = self.store.scope(sid)
        if not row['base_env']: return {}
        try: value = json.loads(row['base_env'])
        except ValueError: return {}
        return {k:v for k,v in value.items() if k in BASE_ENV_KEYS and isinstance(v,str)} if isinstance(value,dict) else {}

    def bind_scope_source(self, sid, p, source):
        self.remember_pi_source(sid,source)
        base = {k:v for k,v in self.scope_env.get(sid,{}).items() if k in BASE_ENV_KEYS}
        self.store.execute('UPDATE scopes SET base_env=? WHERE id=?',(dumps(base) if base else None,sid))
