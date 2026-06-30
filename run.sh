#!/usr/bin/env bash
# Start the Writing Studio locally.
cd "$(dirname "$0")"
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
  ./.venv/bin/python -m pip install -q -r requirements.txt
fi
PORT="${PORT:-8765}"
echo "Writing Studio -> http://localhost:$PORT"
exec ./.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port "$PORT"
