from __future__ import annotations
import hashlib
import json
from pathlib import Path
import sqlite3
from .common import AgentError, TERMINAL, atomic_write, dumps, now, private_dir

SCHEMA_VERSION = 9
DATABASE_OWNER = "metis-pi/native-subagent"
APPLICATION_ID = 0x4D455453  # METS: inspectable without SQLite/WAL side effects.

class Store:
    def __init__(self, home: Path):
        self.home = home
        # An interrupted offline publication must not become a fresh empty ledger.
        if (home / "handoff.pending").exists():
            raise AgentError("state_unavailable", "Metis state publication is incomplete; reconcile the offline handoff before starting")
        path = home / "registry.sqlite"
        if path.is_symlink():
            raise AgentError("foreign_database", "Metis database must not be a symlink")
        existing = path.exists()
        if existing:
            # Even mode=ro may rebuild WAL shared memory. Prove the native file
            # identity from its fixed header before opening any SQLite connection.
            if not path.is_file():
                raise AgentError("foreign_database", "Metis ledger must be a regular file")
            with path.open("rb") as file:
                header = file.read(100)
            if (len(header) != 100 or header[:16] != b"SQLite format 3\x00"
                or int.from_bytes(header[68:72], "big") != APPLICATION_ID
                or int.from_bytes(header[60:64], "big") != SCHEMA_VERSION):
                raise AgentError("foreign_database", "Not a current Metis native ledger")
            probe = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
            try:
                meta = dict(probe.execute("SELECT key,value FROM meta"))
                if meta.get("owner") != DATABASE_OWNER or meta.get("schema") != str(SCHEMA_VERSION):
                    raise AgentError("foreign_database", "Not a current Metis native ledger; explicit offline migration is required")
            except sqlite3.Error as error:
                raise AgentError("foreign_database", "Not a Metis native ledger") from error
            finally:
                probe.close()
        private_dir(home)
        self.db = sqlite3.connect(path, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        if not existing:
            # Establish immutable ownership/version bytes in the main file before
            # WAL mode; a crash cannot leave the identity only in a WAL frame.
            self.db.execute(f"PRAGMA application_id={APPLICATION_ID}")
            self.db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA foreign_keys=ON")
        if not existing:
            try:
                self.db.executescript("""
                    BEGIN IMMEDIATE;
                    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
                    CREATE TABLE scopes(id TEXT PRIMARY KEY,cwd TEXT NOT NULL,label TEXT NOT NULL,
                        created REAL NOT NULL,base_env TEXT,parent TEXT);
                    CREATE TABLE agents(id TEXT PRIMARY KEY,scope TEXT NOT NULL REFERENCES scopes(id),
                        name TEXT NOT NULL,cwd TEXT NOT NULL,state TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,
                        session_file TEXT NOT NULL,launch TEXT NOT NULL,created REAL NOT NULL,updated REAL NOT NULL,
                        current_run TEXT,pid INTEGER,identity TEXT,cleanup TEXT NOT NULL DEFAULT 'verified',UNIQUE(scope,name));
                    CREATE TABLE runs(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id),
                        scope TEXT NOT NULL REFERENCES scopes(id),state TEXT NOT NULL,task TEXT NOT NULL,
                        created REAL NOT NULL,started REAL,ended REAL,idle_timeout_seconds INTEGER,
                        result_path TEXT,result_sha TEXT,error TEXT,usage TEXT NOT NULL DEFAULT '{}');
                    CREATE TABLE requests(scope TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,op TEXT NOT NULL,
                        state TEXT NOT NULL,response TEXT,created REAL NOT NULL,PRIMARY KEY(scope,key));
                    CREATE TABLE receipts(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,scope TEXT NOT NULL,
                        message TEXT NOT NULL,state TEXT NOT NULL,created REAL NOT NULL,updated REAL NOT NULL);
                    CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,agent_id TEXT NOT NULL,run_id TEXT,
                        generation INTEGER NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL,created REAL NOT NULL);
                    CREATE TABLE parent_notifications(id TEXT PRIMARY KEY,scope TEXT NOT NULL REFERENCES scopes(id),
                        run_id TEXT NOT NULL REFERENCES runs(id),kind TEXT NOT NULL,ui_id TEXT,
                        state TEXT NOT NULL DEFAULT 'pending',error TEXT,created REAL NOT NULL,
                        handled INTEGER NOT NULL DEFAULT 0,pi_receipt TEXT,pi_owner TEXT);
                    CREATE INDEX parent_notifications_state ON parent_notifications(state,created);
                    CREATE INDEX runs_scope_state ON runs(scope,state,created);
                    CREATE INDEX runs_agent_state ON runs(agent_id,state,created);
                    CREATE INDEX events_agent_seq ON events(agent_id,seq);
                    CREATE INDEX receipts_run ON receipts(run_id,state);
                    CREATE INDEX receipts_agent_recent ON receipts(agent_id,created DESC);
                    CREATE INDEX receipts_agent_pending ON receipts(agent_id) WHERE state IN ('sending','queued');
                    CREATE INDEX runs_agent_recent ON runs(agent_id,created DESC) WHERE state!='queued';
                    CREATE INDEX parent_notifications_scope_recent ON parent_notifications(scope,created DESC);
                    CREATE INDEX parent_notifications_run ON parent_notifications(run_id,kind);
                """)
                self.db.executemany("INSERT INTO meta(key,value) VALUES(?,?)",
                    [("owner",DATABASE_OWNER),("schema",str(SCHEMA_VERSION))])
                self.db.execute("COMMIT")
            except BaseException:
                if self.db.in_transaction: self.db.execute("ROLLBACK")
                self.db.close()
                raise

    def one(self, sql, args=()):
        r = self.db.execute(sql, args).fetchone()
        return dict(r) if r else None

    def all(self, sql, args=()):
        return [dict(r) for r in self.db.execute(sql, args)]

    def execute(self, sql, args=()):
        return self.db.execute(sql, args)

    def scope(self, sid):
        row = self.one("SELECT * FROM scopes WHERE id=?", (sid,))
        if not row:
            raise AgentError(
                "scope_not_found",
                (
                    "Unknown scope in state directory "
                    f"{self.home}"
                    "; reload the owning Pi session to reconnect to its scope"
                ),
            )
        return row

    def agent(self, sid, aid):
        self.scope(sid)
        row = self.one("SELECT * FROM agents WHERE id=? AND scope=?", (aid, sid))
        if not row:
            raise AgentError("agent_not_found", "Agent not found in this scope")
        return row

    def resolve_agent(self, sid, target):
        self.scope(sid)
        rows = self.all("SELECT * FROM agents WHERE scope=? AND (id=? OR name=?)", (sid, target, target))
        if len(rows) > 1:
            raise AgentError("ambiguous_agent", "Target matches different ID and name; use an unambiguous name/ID")
        if not rows:
            raise AgentError("agent_not_found", "Agent not found in this scope")
        return rows[0]

    def run(self, sid, rid):
        self.scope(sid)
        row = self.one("SELECT * FROM runs WHERE id=? AND scope=?", (rid, sid))
        if not row:
            raise AgentError("run_not_found", "Run not found in this scope")
        return row

    def pending_receipt_count(self, aid):
        return self.one("SELECT COUNT(*) n FROM receipts WHERE agent_id=? AND state IN ('sending','queued')", (aid,))[
            "n"
        ]

    def recent_receipts(self, aid):
        return self.all(
            "SELECT id,run_id,state,updated FROM receipts WHERE agent_id=? ORDER BY created DESC LIMIT 5", (aid,)
        )

    def latest_run(self, aid):
        return self.one("SELECT * FROM runs WHERE agent_id=? AND state!='queued' ORDER BY created DESC LIMIT 1", (aid,))

    def recent_notifications(self, sid):
        return self.all(
            "SELECT run_id,kind,state,error FROM parent_notifications WHERE scope=? ORDER BY created DESC LIMIT 6",
            (sid,),
        )

    def agent_update(self, aid, **fields):
        fields["updated"] = now()
        self.execute("UPDATE agents SET " + ",".join(f"{k}=?" for k in fields) + " WHERE id=?", (*fields.values(), aid))

    def event(self, aid, rid, generation, kind, payload):
        return self.execute(
            "INSERT INTO events(agent_id,run_id,generation,type,payload,created) VALUES(?,?,?,?,?,?)",
            (aid, rid, generation, kind, dumps(payload), now()),
        ).lastrowid

    def finish(self, rid, state, output, error=None, usage=None):
        row = self.one("SELECT * FROM runs WHERE id=?", (rid,))
        if not row or row["state"] in TERMINAL:
            return
        body = output.encode("utf-8")
        path = self.home / "results" / f"{rid}.txt"
        atomic_write(path, body)  # artifact durable before referencing transaction
        sha = hashlib.sha256(body).hexdigest()
        self.execute("BEGIN IMMEDIATE")
        try:
            self.execute(
                "UPDATE runs SET state=?,ended=?,result_path=?,result_sha=?,error=?,usage=? WHERE id=?",
                (state, now(), str(path), sha, error, dumps(usage or {}), rid),
            )
            self.execute(
                "UPDATE receipts SET state='not_consumed',updated=? WHERE run_id=? AND state IN ('queued','sending')",
                (now(), rid),
            )
            self.attention(rid, "terminal")
            self.execute("COMMIT")
        except BaseException:
            self.execute("ROLLBACK")
            raise

    def attention(self, rid, kind, ui_id=None):
        row = self.one("SELECT scope FROM runs WHERE id=?", (rid,))
        if not row:
            return
        key = hashlib.sha256(dumps([rid, kind, ui_id]).encode()).hexdigest()
        self.execute(
            "INSERT OR IGNORE INTO parent_notifications(id,scope,run_id,kind,ui_id,created) VALUES(?,?,?,?,?,?)",
            (key, row["scope"], rid, kind, ui_id, now()),
        )

    def request_begin(self, sid, key, op, params):
        payload = {"op": op, "params": params}
        digest = hashlib.sha256(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False).encode()
        ).hexdigest()
        row = self.one("SELECT * FROM requests WHERE scope=? AND key=?", (sid, key))
        if row:
            if row["digest"] != digest:
                raise AgentError("idempotency_conflict", "request_id already used for different arguments")
            if row["state"] == "done":
                return json.loads(row["response"])
            raise AgentError(
                "request_uncertain",
                "Operation was started but no durable reply exists; inspect state before retrying",
                request_id=key,
            )
        self.execute("INSERT INTO requests VALUES(?,?,?,?,?,?,?)", (sid, key, digest, op, "pending", None, now()))
        return None

    def request_end(self, sid, key, response):
        self.execute("UPDATE requests SET state='done',response=? WHERE scope=? AND key=?", (dumps(response), sid, key))

    def close(self):
        self.db.close()
