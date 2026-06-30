"""SQLite storage layer for the Writing Studio.

One small database file holds everything: articles, their full version history,
the chat log, the growing corpus of finished articles (the "style examples"),
the evolving style profile, and the learned style notes. No external DB needed.
"""
import os
import sqlite3
import time

DB_PATH = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "data", "studio.db"))


def _now() -> float:
    return time.time()


def connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL DEFAULT 'Untitled',
    topic      TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'draft',      -- draft | published
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS versions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    source     TEXT NOT NULL,                       -- generated | ai_edit | manual | restore
    label      TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,                       -- user | assistant
    content    TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS style_examples (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL,
    source     TEXT NOT NULL DEFAULT 'seed',        -- seed | written
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS style_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    note       TEXT NOT NULL,
    source     TEXT NOT NULL DEFAULT 'seed',        -- seed | chat | manual
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()


# ---- settings -------------------------------------------------------------
def get_setting(conn, key, default=None):
    row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(conn, key, value):
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )
    conn.commit()


# ---- articles -------------------------------------------------------------
def create_article(conn, title="Untitled", topic="", content=""):
    t = _now()
    cur = conn.execute(
        "INSERT INTO articles(title, topic, content, created_at, updated_at) VALUES(?,?,?,?,?)",
        (title or "Untitled", topic, content, t, t),
    )
    conn.commit()
    return cur.lastrowid


def get_article(conn, article_id):
    return conn.execute("SELECT * FROM articles WHERE id=?", (article_id,)).fetchone()


def list_articles(conn):
    return conn.execute(
        "SELECT id, title, topic, status, created_at, updated_at FROM articles ORDER BY updated_at DESC"
    ).fetchall()


def update_article(conn, article_id, *, title=None, topic=None, content=None, status=None):
    fields, params = [], []
    for col, val in (("title", title), ("topic", topic), ("content", content), ("status", status)):
        if val is not None:
            fields.append(f"{col}=?")
            params.append(val)
    if not fields:
        return
    fields.append("updated_at=?")
    params.append(_now())
    params.append(article_id)
    conn.execute(f"UPDATE articles SET {', '.join(fields)} WHERE id=?", params)
    conn.commit()


def delete_article(conn, article_id):
    conn.execute("DELETE FROM articles WHERE id=?", (article_id,))
    conn.commit()


# ---- versions -------------------------------------------------------------
def add_version(conn, article_id, content, source, label=""):
    cur = conn.execute(
        "INSERT INTO versions(article_id, content, source, label, created_at) VALUES(?,?,?,?,?)",
        (article_id, content, source, label, _now()),
    )
    conn.commit()
    return cur.lastrowid


def list_versions(conn, article_id):
    return conn.execute(
        "SELECT id, source, label, created_at, length(content) AS chars "
        "FROM versions WHERE article_id=? ORDER BY id DESC",
        (article_id,),
    ).fetchall()


def get_version(conn, version_id):
    return conn.execute("SELECT * FROM versions WHERE id=?", (version_id,)).fetchone()


# ---- chat -----------------------------------------------------------------
def add_chat(conn, article_id, role, content):
    conn.execute(
        "INSERT INTO chat_messages(article_id, role, content, created_at) VALUES(?,?,?,?)",
        (article_id, role, content, _now()),
    )
    conn.commit()


def list_chat(conn, article_id):
    return conn.execute(
        "SELECT role, content, created_at FROM chat_messages WHERE article_id=? ORDER BY id",
        (article_id,),
    ).fetchall()


# ---- style corpus + notes -------------------------------------------------
def add_style_example(conn, title, content, source="written"):
    conn.execute(
        "INSERT INTO style_examples(title, content, source, created_at) VALUES(?,?,?,?)",
        (title, content, source, _now()),
    )
    conn.commit()


def list_style_examples(conn, limit=None):
    q = "SELECT id, title, content, source, created_at FROM style_examples ORDER BY id DESC"
    if limit:
        q += f" LIMIT {int(limit)}"
    return conn.execute(q).fetchall()


def count_style_examples(conn):
    return conn.execute("SELECT COUNT(*) AS c FROM style_examples").fetchone()["c"]


def add_style_note(conn, note, source="manual"):
    note = note.strip()
    if not note:
        return
    exists = conn.execute("SELECT 1 FROM style_notes WHERE lower(note)=lower(?)", (note,)).fetchone()
    if exists:
        return
    conn.execute(
        "INSERT INTO style_notes(note, source, created_at) VALUES(?,?,?)",
        (note, source, _now()),
    )
    conn.commit()


def list_style_notes(conn):
    return conn.execute("SELECT id, note, source, created_at FROM style_notes ORDER BY id").fetchall()


def delete_style_note(conn, note_id):
    conn.execute("DELETE FROM style_notes WHERE id=?", (note_id,))
    conn.commit()
