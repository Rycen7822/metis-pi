CREATE TABLE cache_root (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    path BLOB NOT NULL,
    device INTEGER NOT NULL,
    inode INTEGER NOT NULL,
    model TEXT
) STRICT;

CREATE TABLE sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path BLOB NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    device INTEGER NOT NULL,
    inode INTEGER NOT NULL,
    cursor INTEGER NOT NULL,
    prefix_digest BLOB NOT NULL,
    gaps INTEGER NOT NULL,
    tail_gap INTEGER NOT NULL DEFAULT 0,
    observed BLOB NOT NULL,
    finished INTEGER NOT NULL
) STRICT;

CREATE INDEX source_cwd ON sources(cwd);

CREATE TABLE entries (
    source INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    parent TEXT,
    timestamp TEXT,
    byte_offset INTEGER NOT NULL,
    byte_len INTEGER NOT NULL,
    terminated INTEGER NOT NULL,
    line_digest BLOB NOT NULL,
    PRIMARY KEY (source, id)
) STRICT;

CREATE INDEX entry_offset ON entries(source, byte_offset);

CREATE TABLE chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source INTEGER NOT NULL,
    entry TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    block INTEGER NOT NULL,
    text_start INTEGER NOT NULL,
    text_end INTEGER NOT NULL,
    FOREIGN KEY (source, entry) REFERENCES entries(source, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX chunk_entry ON chunks(source, entry);

CREATE TABLE vectors (
    chunk INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    payload BLOB NOT NULL CHECK (length(payload)=260),
    indexed_at INTEGER NOT NULL,
    day INTEGER
) STRICT;

CREATE INDEX vector_day ON vectors(day, chunk);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
    terms, content='', contentless_delete=1, tokenize='unicode61 tokenchars _'
);

CREATE TRIGGER delete_chunk AFTER DELETE ON chunks BEGIN
    DELETE FROM chunks_fts WHERE rowid=old.id;
END;
