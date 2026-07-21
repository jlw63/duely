# Integration tests

Scripted WebSocket clients that exercise the live protocol directly — no
mocking, no test framework, just the same `websockets` client library a
real player's browser would use, talking to a real running server.

## Setup

```
pip install -r tests/requirements.txt
```

## Running

Each script targets `ws://127.0.0.1:8000` by default (a locally running
`uvicorn main:app` — see `backend/README` for how to start it). Point it at
a different server, including a live deployment, with the `DUELY_URL` env
var:

```
python tests/test_reconnect.py
python tests/test_race_condition.py
python tests/measure_latency.py

DUELY_URL=wss://duely-epn0.onrender.com python tests/measure_latency.py
```

Each script is self-contained, asserts its own expectations, and exits
non-zero on failure.

## What each one verifies

- **test_reconnect.py** — a dropped connection gets a grace window, the
  match pauses (no scoring off an absent player) instead of ending, and a
  reconnect within the window resumes the SAME player identity, score, and
  live question rather than starting fresh.
- **test_race_condition.py** — the round-token invalidation scheme: a real
  player's answer and a bot's independently-scheduled delayed answer can
  never both score the same round, even when they land close together.
- **measure_latency.py** — samples the round-trip time from sending a
  correct answer to receiving the resulting score broadcast, over N rounds,
  reporting min/median/mean/p95/max rather than a single cherry-picked
  number.
