# ✍️ Writing Studio

A tiny personal tool that drafts blog articles **in one writer's voice**, with a
live editor, an AI chat that edits the draft, full version history, one-click
**Word / Google Docs** export, and dynamic learning that gets better as she writes.

Built for a doctor who blogs about paediatric congenital heart disease for
the Genesis Foundation. Her style is already baked in (`style_seed.json`).

---

## What it does

- **Topic in → article out.** Type a topic, press *Write*, watch it stream in her voice.
- **Live editor.** Edit the draft freely like a document. Autosaves.
- **AI chat that edits the draft.** "make the intro warmer", "add a diagnosis section",
  "shorten paragraph 3". It rewrites the live draft; your manual edits are kept.
- **History.** Every generation, AI edit, and manual save is a restorable version.
- **Export.** Download as `.docx` (opens cleanly in Word and Google Docs).
- **Learns over time.** *Mark done* adds the finished article to her style corpus and
  refreshes the style profile. Durable instructions you type in chat ("always…",
  "use British spelling") are saved as rules. See them under 🧬 **Style**.

---

## The one thing you must provide

An **Anthropic API key** (this powers the writing). Get one at
<https://console.anthropic.com/> → *API keys*, add a few dollars of credit.
Then either:

- paste it into the app under **⚙️ Settings**, or
- set `ANTHROPIC_API_KEY` in the environment / `.env`.

Cost is tiny for personal use — roughly a few cents per article with Opus 4.8.

---

## Run it locally (simplest, free, fully private)

```bash
./run.sh
```

Then open **http://localhost:8765**. (First run sets up a virtualenv automatically.)
Your articles live in a local `data/studio.db` file — nothing leaves your machine
except the calls to the Anthropic API.

Manual version (if you prefer):

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
./.venv/bin/uvicorn app:app --port 8765
```

---

## Host it free (use it from anywhere) — Render

1. Push this folder to a GitHub repo.
2. On <https://render.com>: **New +** → **Blueprint** → pick the repo
   (it reads `render.yaml`).
3. Set `ANTHROPIC_API_KEY`, and `APP_PASSWORD` (a password to open the app). Deploy.

> **Note on history when hosted:** Render's free tier has an *ephemeral* disk, so the
> in-app article history resets whenever the service redeploys or restarts. Day-to-day
> use is fine, and you can always export each article to Word. If you want permanent
> cloud history, we can switch storage to a free Postgres (Neon/Supabase) — ask and
> it's a small change.

---

## Settings (environment variables)

| Variable            | What it does                                              |
| ------------------- | -------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | Your Anthropic key (required for writing).               |
| `APP_PASSWORD`      | Password to open the app. Blank = no password (local).   |
| `MODEL`             | Model id. Default `claude-opus-4-8`.                     |
| `DB_PATH`           | Where the SQLite file lives. Default `data/studio.db`.   |

---

## How the style matching works

We don't fine-tune. On every request Claude gets her **distilled style profile**
+ her **real articles** as exemplars + her **learned rules** — so it writes in her
human voice, not generic AI. This is also the best practical defence against
"this looks AI-written": it's grounded in a real person's voice and she edits it.
No method can *guarantee* passing every AI detector, so treat it as a strong first
draft she polishes.

The seeded profile and her **4** sample articles are in `style_seed.json`
(re-seeded automatically on a fresh database). As she writes more and hits
*Mark done*, each finished article is folded into the corpus and sharpens the profile.

---

## Files

```
app.py            FastAPI backend (API + streaming + export)
db.py             SQLite storage
prompts.py        builds the system prompts from her style
seed.py           seeds the style DNA on first run
style_seed.json   her style profile + rules + sample articles
static/           the web UI (index.html, app.js, style.css)
render.yaml       one-click Render deploy
run.sh            start it locally
```
