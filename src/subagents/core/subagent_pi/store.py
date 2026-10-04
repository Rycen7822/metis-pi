from __future__ import annotations
import hashlib
import json
from pathlib import Path
import sqlite3
from .common import AgentError, TERMINAL, atomic_write, dumps, now, private_dir

SCHEMA_VERSION = 8
# Applied in order to reach SCHEMA_VERSION from an older ledger. A fresh database
# is created at the current version, so these statements never run on it.
MIGRATIONS = {
    2: ('ALTER TABLE scopes ADD COLUMN codex_home TEXT',
        'ALTER TABLE scopes ADD COLUMN codex_source TEXT',
        'ALTER TABLE scopes ADD COLUMN inheritance INTEGER NOT NULL DEFAULT 1'),
    3: ('ALTER TABLE scopes ADD COLUMN base_env TEXT',),
    4: ('ALTER TABLE scopes ADD COLUMN parent TEXT',),
    5: ('ALTER TABLE runs ADD COLUMN idle_timeout_seconds INTEGER',),
    6: ('ALTER TABLE parent_notifications ADD COLUMN handled INTEGER NOT NULL DEFAULT 0',),
    7: ('ALTER TABLE parent_notifications ADD COLUMN pi_receipt TEXT',
        'ALTER TABLE parent_notifications ADD COLUMN pi_owner TEXT'),
    8: ('DROP INDEX runs_scope_state',
        'ALTER TABLE runs DROP COLUMN ack',
        'CREATE INDEX runs_scope_state ON runs(scope,state,created)'),
}

class Store:
    def __init__(self, home: Path):
        self.home = home
        private_dir(home)
        self.db = sqlite3.connect(home/"registry.sqlite", isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
        CREATE TABLE IF NOT EXISTS scopes(id TEXT PRIMARY KEY,cwd TEXT NOT NULL,label TEXT NOT NULL,created REAL NOT NULL,revision INTEGER NOT NULL DEFAULT 0,
            codex_home TEXT,codex_source TEXT,inheritance INTEGER NOT NULL DEFAULT 1,base_env TEXT,parent TEXT);
        CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY,scope TEXT NOT NULL REFERENCES scopes(id),name TEXT NOT NULL,cwd TEXT NOT NULL,state TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,session_file TEXT NOT NULL,launch TEXT NOT NULL,created REAL NOT NULL,updated REAL NOT NULL,current_run TEXT,pid INTEGER,identity TEXT,cleanup TEXT NOT NULL DEFAULT 'verified',UNIQUE(scope,name));
        CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id),scope TEXT NOT NULL REFERENCES scopes(id),state TEXT NOT NULL,task TEXT NOT NULL,created REAL NOT NULL,started REAL,ended REAL,deadline REAL,idle_timeout_seconds INTEGER,result_path TEXT,result_sha TEXT,error TEXT,usage TEXT NOT NULL DEFAULT '{}');
        CREATE TABLE IF NOT EXISTS requests(scope TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,op TEXT NOT NULL,state TEXT NOT NULL,response TEXT,created REAL NOT NULL,PRIMARY KEY(scope,key));
        CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,scope TEXT NOT NULL,message TEXT NOT NULL,state TEXT NOT NULL,created REAL NOT NULL,updated REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,agent_id TEXT NOT NULL,run_id TEXT,generation INTEGER NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL,created REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS parent_notifications(id TEXT PRIMARY KEY,scope TEXT NOT NULL REFERENCES scopes(id),run_id TEXT NOT NULL REFERENCES runs(id),kind TEXT NOT NULL,ui_id TEXT,state TEXT NOT NULL DEFAULT 'pending',queued_id TEXT,error TEXT,created REAL NOT NULL,handled INTEGER NOT NULL DEFAULT 0,pi_receipt TEXT,pi_owner TEXT);
        CREATE INDEX IF NOT EXISTS parent_notifications_state ON parent_notifications(state,created);
        CREATE INDEX IF NOT EXISTS runs_scope_state ON runs(scope,state,created);
        CREATE INDEX IF NOT EXISTS runs_agent_state ON runs(agent_id,state,created);
        CREATE INDEX IF NOT EXISTS events_agent_seq ON events(agent_id,seq);
        CREATE INDEX IF NOT EXISTS receipts_run ON receipts(run_id,state);
        CREATE INDEX IF NOT EXISTS receipts_agent_recent ON receipts(agent_id,created DESC);
        CREATE INDEX IF NOT EXISTS receipts_agent_pending ON receipts(agent_id) WHERE state IN ('sending','queued');
        CREATE INDEX IF NOT EXISTS runs_agent_recent ON runs(agent_id,created DESC) WHERE state!='queued';
        CREATE INDEX IF NOT EXISTS parent_notifications_scope_recent ON parent_notifications(scope,created DESC);
        CREATE INDEX IF NOT EXISTS parent_notifications_run ON parent_notifications(run_id,kind);
        ''')
        row = self.one("SELECT value FROM meta WHERE key='schema'")
        current = int(row['value']) if row else None
        if current is not None and current > SCHEMA_VERSION:
            raise AgentError('version_mismatch', 'Unsupported database schema')
        # A fresh database is already created at the current version by the
        # CREATE TABLE statements above; only an older ledger needs upgrading.
        if current is not None and current < SCHEMA_VERSION:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                for version in range(current+1, SCHEMA_VERSION+1):
                    # Ledgers predating parent notifications get the current
                    # table above; existing v5 tables still need this column.
                    if version==6 and any(c['name']=='handled' for c in self.all('PRAGMA table_info(parent_notifications)')):
                        continue
                    if version==7 and any(c['name']=='pi_receipt' for c in self.all('PRAGMA table_info(parent_notifications)')):
                        continue
                    if version==8:
                        if not any(c['name']=='ack' for c in self.all('PRAGMA table_info(runs)')):
                            continue
                        for run in self.all("SELECT id,ack FROM runs WHERE state IN ('completed','failed','interrupted','crashed','cancelled','timed_out')"):
                            self.attention(run['id'],'terminal')
                            if run['ack']:
                                self.db.execute("UPDATE parent_notifications SET handled=1,state=CASE WHEN state='pending' THEN 'observed' ELSE state END WHERE run_id=? AND kind='terminal'", (run['id'],))
                    for statement in MIGRATIONS[version]:
                        self.db.execute(statement)
                self.db.execute('COMMIT')
            except BaseException:
                self.db.execute('ROLLBACK'); raise
        self.db.execute("INSERT OR REPLACE INTO meta VALUES('schema',?)", (str(SCHEMA_VERSION),))

    def one(self, sql, args=()):
        r = self.db.execute(sql, args).fetchone()
        return dict(r) if r else None
    def all(self, sql, args=()):
        return [dict(r) for r in self.db.execute(sql, args)]
    def execute(self, sql, args=()): return self.db.execute(sql, args)
    def scope(self, sid):
        row = self.one("SELECT * FROM scopes WHERE id=?", (sid,))
        if not row: raise AgentError("scope_not_found", f"Unknown scope in state directory {self.home}; check --home or PI_AGENTS_HOME against the parent session, then select an existing scope or use the CLI scope open command")
        return row
    def agent(self, sid, aid):
        self.scope(sid)
        row=self.one("SELECT * FROM agents WHERE id=? AND scope=?",(aid,sid))
        if not row: raise AgentError('agent_not_found','Agent not found in this scope')
        return row
    def resolve_agent(self,sid,target):
        self.scope(sid)
        rows=self.all("SELECT * FROM agents WHERE scope=? AND (id=? OR name=?)",(sid,target,target))
        if len(rows)>1: raise AgentError('ambiguous_agent','Target matches different ID and name; use an unambiguous name/ID')
        if not rows: raise AgentError('agent_not_found','Agent not found in this scope')
        return rows[0]
    def run(self, sid, rid):
        self.scope(sid)
        row = self.one("SELECT * FROM runs WHERE id=? AND scope=?", (rid,sid))
        if not row: raise AgentError("run_not_found", "Run not found in this scope")
        return row
    def pending_receipt_count(self, aid):
        return self.one("SELECT COUNT(*) n FROM receipts WHERE agent_id=? AND state IN ('sending','queued')", (aid,))['n']

    def recent_receipts(self, aid):
        return self.all('SELECT id,run_id,state,updated FROM receipts WHERE agent_id=? ORDER BY created DESC LIMIT 5', (aid,))

    def latest_run(self, aid):
        return self.one("SELECT * FROM runs WHERE agent_id=? AND state!='queued' ORDER BY created DESC LIMIT 1", (aid,))

    def recent_notifications(self, sid):
        return self.all('SELECT run_id,kind,state,queued_id,error FROM parent_notifications WHERE scope=? ORDER BY created DESC LIMIT 6', (sid,))

    def agent_update(self, aid, **fields):
        fields['updated'] = now()
        self.execute('UPDATE agents SET '+','.join(f'{k}=?' for k in fields)+' WHERE id=?', (*fields.values(),aid))
    def event(self, aid, rid, generation, kind, payload):
        return self.execute("INSERT INTO events(agent_id,run_id,generation,type,payload,created) VALUES(?,?,?,?,?,?)", (aid,rid,generation,kind,dumps(payload),now())).lastrowid
    def finish(self, rid, state, output, error=None, usage=None):
        row = self.one("SELECT * FROM runs WHERE id=?", (rid,))
        if not row or row['state'] in TERMINAL: return
        body = output.encode('utf-8')
        path = self.home/'results'/f'{rid}.txt'
        atomic_write(path, body)  # artifact durable before referencing transaction
        sha = hashlib.sha256(body).hexdigest()
        self.execute("BEGIN IMMEDIATE")
        try:
            self.execute("UPDATE runs SET state=?,ended=?,result_path=?,result_sha=?,error=?,usage=? WHERE id=?", (state,now(),str(path),sha,error,dumps(usage or {}),rid))
            self.execute("UPDATE receipts SET state='not_consumed',updated=? WHERE run_id=? AND state IN ('queued','sending')", (now(),rid))
            self.attention(rid,'terminal')
            self.execute("COMMIT")
        except BaseException:
            self.execute("ROLLBACK"); raise
    def attention(self, rid, kind, ui_id=None):
        row=self.one('SELECT r.scope,s.parent FROM runs r JOIN scopes s ON s.id=r.scope WHERE r.id=?',(rid,))
        if not row: return
        key=hashlib.sha256(dumps([rid,kind,ui_id]).encode()).hexdigest()
        self.execute('INSERT OR IGNORE INTO parent_notifications(id,scope,run_id,kind,ui_id,created) VALUES(?,?,?,?,?,?)',
                     (key,row['scope'],rid,kind,ui_id,now()))

    def request_begin(self, sid, key, op, params):
        payload={'op':op,'params':params}
        digest = hashlib.sha256(json.dumps(payload,ensure_ascii=False,separators=(',',':'),sort_keys=True,allow_nan=False).encode()).hexdigest()
        legacy_digest = hashlib.sha256(dumps(payload).encode()).hexdigest()
        row = self.one("SELECT * FROM requests WHERE scope=? AND key=?", (sid,key))
        if row:
            if row['digest'] not in {digest,legacy_digest}: raise AgentError("idempotency_conflict", "request_id already used for different arguments")
            if row['state'] == 'done': return json.loads(row['response'])
            raise AgentError("request_uncertain", "Operation was started but no durable reply exists; inspect state before retrying", request_id=key)
        self.execute("INSERT INTO requests VALUES(?,?,?,?,?,?,?)", (sid,key,digest,op,'pending',None,now()))
        return None
    def request_end(self, sid, key, response):
        self.execute("UPDATE requests SET state='done',response=? WHERE scope=? AND key=?", (dumps(response),sid,key))
    def close(self): self.db.close()
