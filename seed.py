"""Seed the database with the writer's style DNA on first run.

Loads the style seed — her distilled style profile, the learned style notes, and
her real articles as exemplars — but only if the database hasn't been seeded yet.

The seed comes from STYLE_SEED_B64 (a base64-encoded JSON env var) when set —
this keeps her personal content out of any public code repo on hosted deploys —
otherwise it falls back to the local style_seed.json file. Safe to run repeatedly.
"""
import base64
import json
import os

import db

SEED_PATH = os.path.join(os.path.dirname(__file__), "style_seed.json")


def _load_seed():
    b64 = os.environ.get("STYLE_SEED_B64")
    if b64:
        try:
            return json.loads(base64.b64decode(b64).decode("utf-8"))
        except Exception:
            pass
    if os.path.exists(SEED_PATH):
        with open(SEED_PATH, encoding="utf-8") as f:
            return json.load(f)
    return None


def seed_if_empty(conn) -> bool:
    if db.get_setting(conn, "seeded"):
        return False
    seed = _load_seed()
    if not seed:
        return False

    if seed.get("profile"):
        db.set_setting(conn, "style_profile", seed["profile"])
    for note in seed.get("notes", []):
        db.add_style_note(conn, note, source="seed")
    if db.count_style_examples(conn) == 0:
        for ex in seed.get("examples", []):
            db.add_style_example(conn, ex.get("title", ""), ex.get("content", ""), source="seed")

    db.set_setting(conn, "seeded", "1")
    return True


if __name__ == "__main__":
    with db.connect() as c:
        db.init_db(c)
        print("Seeded." if seed_if_empty(c) else "Already seeded (no changes).")
