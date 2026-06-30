"""Storage layer. Uses Postgres when DATABASE_URL is set (so hosted history
persists across restarts), otherwise a local SQLite file. Same API either way.

One small schema holds everything: articles, their full version history, the
chat log, the growing corpus of finished articles, the evolving style profile,
and the learned style notes.
"""
import os
import time

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
IS_PG = DATABASE_URL.startswith(("postgres://", "postgresql://"))
DB_PATH = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "data", "studio.db"))

if IS_PG:
    import psycopg
    from psycopg.rows import dict_row
else:
    import sqlite3


def _now() -> float:
    return time.time()


class Conn:
    """Thin wrapper so the rest of the app can stay backend-agnostic.

    Exposes execute()/commit()/close() and works as a context manager that
    commits on clean exit and always closes.
    """

    def __init__(self):
        if IS_PG:
            self._c = psycopg.connect(DATABASE_URL, row_factory=dict_row, autocommit=False)
        else:
            os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
            self._c = sqlite3.connect(DB_PATH)
            self._c.row_factory = sqlite3.Row
            self._c.execute("PRAGMA journal_mode=WAL")
            self._c.execute("PRAGMA foreign_keys=ON")

    def execute(self, sql, params=()):
        if IS_PG:
            sql = sql.replace("?", "%s")
        return self._c.execute(sql, params)

    def commit(self):
        self._c.commit()

    def close(self):
        try:
            self._c.close()
        except Exception:
            pass

    def __enter__(self):
        return self

    def __exit__(self, et, ev, tb):
        if et is None:
            try:
                self.commit()
            except Exception:
                pass
        self.close()


def connect() -> Conn:
    return Conn()


# ---- schema (portable across SQLite + Postgres) ---------------------------
_PK = "BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY" if IS_PG else "INTEGER PRIMARY KEY AUTOINCREMENT"
_REAL = "DOUBLE PRECISION" if IS_PG else "REAL"

SCHEMA_STATEMENTS = [
    f"""CREATE TABLE IF NOT EXISTS articles (
        id         {_PK},
        title      TEXT NOT NULL DEFAULT 'Untitled',
        topic      TEXT NOT NULL DEFAULT '',
        content    TEXT NOT NULL DEFAULT '',
        status     TEXT NOT NULL DEFAULT 'draft',
        created_at {_REAL} NOT NULL,
        updated_at {_REAL} NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS versions (
        id         {_PK},
        article_id BIGINT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        content    TEXT NOT NULL,
        source     TEXT NOT NULL,
        label      TEXT NOT NULL DEFAULT '',
        created_at {_REAL} NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS chat_messages (
        id         {_PK},
        article_id BIGINT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at {_REAL} NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS style_examples (
        id         {_PK},
        title      TEXT NOT NULL DEFAULT '',
        content    TEXT NOT NULL,
        source     TEXT NOT NULL DEFAULT 'seed',
        created_at {_REAL} NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS style_notes (
        id         {_PK},
        note       TEXT NOT NULL,
        source     TEXT NOT NULL DEFAULT 'seed',
        created_at {_REAL} NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )""",
]


def init_db(conn) -> None:
    for stmt in SCHEMA_STATEMENTS:
        conn.execute(stmt)
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
    row = conn.execute(
        "INSERT INTO articles(title, topic, content, created_at, updated_at) "
        "VALUES(?,?,?,?,?) RETURNING id",
        (title or "Untitled", topic, content, t, t),
    ).fetchone()
    conn.commit()
    return row["id"]


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
    row = conn.execute(
        "INSERT INTO versions(article_id, content, source, label, created_at) "
        "VALUES(?,?,?,?,?) RETURNING id",
        (article_id, content, source, label, _now()),
    ).fetchone()
    conn.commit()
    return row["id"]


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
    note = (note or "").strip()
    if not note:
        return
    if conn.execute("SELECT 1 FROM style_notes WHERE lower(note)=lower(?)", (note,)).fetchone():
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
