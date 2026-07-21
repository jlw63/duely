"""Verifies the round-token invalidation scheme that guarantees exactly-once
scoring. A bot's answer is scheduled on an independent delayed asyncio task
the moment a round starts; if a real player answers first, that scheduled
task must recognize the round has already moved on and back off silently —
never producing a second "result" for the same round.
"""
import asyncio
import json
import os
import random
import string
import time
import websockets

URL_BASE = os.environ.get("DUELY_URL", "ws://127.0.0.1:8000")


def room_code():
    return "".join(random.choices(string.ascii_uppercase, k=6))


async def recv_json(ws, timeout=8):
    return json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))


def answer_for(text):
    a, b = text.split(" + ")
    return int(a) + int(b)


async def test_human_beats_bot():
    room = room_code()
    # bot=easy means its own scheduled answer is 3.0-5.5s away — an instant
    # human reply must win, and the bot's now-stale task must not double-score
    url = f"{URL_BASE}/ws/{room}?difficulty=easy&target=5&ops=add&bot=easy"
    ws = await websockets.connect(url)
    await recv_json(ws)  # welcome
    await recv_json(ws)  # match_start
    q = await recv_json(ws)

    ans = answer_for(q["text"])
    await ws.send(json.dumps({"type": "answer", "value": ans}))
    result = await recv_json(ws)
    assert result["type"] == "result"
    assert result["winner"] == "player1", "the human should have won this round"
    print("PASS: human's instant answer won over the bot")

    # the bot's stale task (scheduled for the round we just won) must not
    # fire a second, duplicate result later — the next message must be the
    # NEXT round's question, not another "result"
    next_msg = await recv_json(ws, timeout=6)
    assert next_msg["type"] == "question", (
        f"expected the next round's question, got a duplicate: {next_msg}"
    )
    print("PASS: no duplicate/late result from the bot's stale task")
    await ws.close()


async def test_bot_wins_when_uncontested():
    room = room_code()
    # bot=hard means it answers fast (0.8-2.0s) if nobody beats it there
    url = f"{URL_BASE}/ws/{room}?difficulty=easy&target=3&ops=add&bot=hard"
    ws = await websockets.connect(url)
    await recv_json(ws)  # welcome
    await recv_json(ws)  # match_start
    q = await recv_json(ws)

    t0 = time.monotonic()
    result = await recv_json(ws, timeout=6)
    elapsed = time.monotonic() - t0
    assert result["type"] == "result"
    assert result["winner"] == "Champion Bot"
    assert 0.5 < elapsed < 3.0, f"bot answered outside its expected delay window: {elapsed:.2f}s"
    print(f"PASS: bot answered on its own after {elapsed:.2f}s when uncontested")
    await ws.close()


async def main():
    await test_human_beats_bot()
    await test_bot_wins_when_uncontested()
    print("\nALL PASS")


if __name__ == "__main__":
    asyncio.run(main())
