"""Samples round-trip latency for the core game loop: send a correct answer,
measure the time until the resulting score broadcast arrives back. Reports
a distribution (min/median/mean/p95/max) over N rounds rather than a single
number, since any one sample is noise.

Usage:
    python tests/measure_latency.py                 # against localhost
    DUELY_URL=wss://your-app.onrender.com python tests/measure_latency.py
"""
import asyncio
import json
import os
import random
import statistics
import string
import time
import websockets

URL_BASE = os.environ.get("DUELY_URL", "ws://127.0.0.1:8000")
ROUNDS = int(os.environ.get("ROUNDS", "25"))


def room_code():
    return "".join(random.choices(string.ascii_uppercase, k=6))


async def recv_json(ws, timeout=10):
    return json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))


def answer_for(text):
    a, b = text.split(" + ")
    return int(a) + int(b)


async def main():
    room = room_code()
    url = f"{URL_BASE}/ws/{room}?difficulty=easy&target=30&ops=add"

    p1 = await websockets.connect(url)
    p2 = await websockets.connect(url)   # silent second player — just needed to start the match
    await recv_json(p1)  # welcome
    await recv_json(p2)
    await recv_json(p1)  # match_start
    await recv_json(p2)

    q = await recv_json(p1)
    await recv_json(p2)  # same question, discard

    samples = []
    for _ in range(ROUNDS):
        ans = answer_for(q["text"])
        t0 = time.perf_counter()
        await p1.send(json.dumps({"type": "answer", "value": ans}))
        result = await recv_json(p1)
        t1 = time.perf_counter()
        assert result["type"] == "result"
        samples.append((t1 - t0) * 1000)  # ms

        q = await recv_json(p1)
        await recv_json(p2)
        if q["type"] == "deathmatch":   # only reachable near target — rare at target=30
            q = await recv_json(p1)
            await recv_json(p2)

    await p1.close()
    await p2.close()

    samples.sort()
    p95 = samples[int(len(samples) * 0.95)]
    print(f"n={len(samples)}")
    print(f"min={min(samples):.1f}ms  median={statistics.median(samples):.1f}ms  "
          f"mean={statistics.mean(samples):.1f}ms  p95={p95:.1f}ms  max={max(samples):.1f}ms")
    print("all samples (ms):", [round(s, 1) for s in samples])


if __name__ == "__main__":
    asyncio.run(main())
