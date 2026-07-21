"""Verifies state isolation under concurrent load: N independent rooms are
driven through a full match SIMULTANEOUSLY, each with display names that
embed the room's own index. Every welcome/match_start/question/result
message is checked to contain ONLY that room's two names — if the server's
per-room state (games[room_code], manager.rooms[room_code]) ever leaked
into another room under concurrency, this is what would catch it.

Usage:
    python tests/test_concurrency.py            # 30 rooms (60 connections) against localhost
    ROOMS=50 python tests/test_concurrency.py
    DUELY_URL=wss://your-app.onrender.com ROOMS=10 python tests/test_concurrency.py
"""
import asyncio
import json
import os
import random
import string
import time
import websockets

URL_BASE = os.environ.get("DUELY_URL", "ws://127.0.0.1:8000")
ROOMS = int(os.environ.get("ROOMS", "30"))
# unique per invocation — reusing deterministic room codes across separate runs
# can collide with a PREVIOUS run's still-in-grace-period room (by design, see
# GRACE_SECONDS/pending_disconnects), which isn't cross-talk, just stale reuse
RUN_ID = "".join(random.choices(string.ascii_uppercase, k=4))


async def recv_json(ws, timeout=15):
    return json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))


def answer_for(text):
    a, b = text.split(" + ")
    return int(a) + int(b)


async def run_room(index):
    room = f"C{RUN_ID}{index}"
    name_a, name_b = f"P{index}A", f"P{index}B"
    expected_names = {name_a, name_b}
    url = f"{URL_BASE}/ws/{room}?difficulty=easy&target=3&ops=add"

    pa = await websockets.connect(f"{url}&display_name={name_a}")
    pb = await websockets.connect(f"{url}&display_name={name_b}")

    wa = await recv_json(pa)
    wb = await recv_json(pb)
    assert wa["name"] == name_a, f"room {index}: expected own name {name_a}, got {wa['name']}"
    assert wb["name"] == name_b, f"room {index}: expected own name {name_b}, got {wb['name']}"

    ms_a = await recv_json(pa)
    ms_b = await recv_json(pb)
    assert set(ms_a["names"]) == expected_names, f"room {index}: cross-talk in match_start: {ms_a['names']}"
    assert set(ms_b["names"]) == expected_names, f"room {index}: cross-talk in match_start: {ms_b['names']}"

    q = await recv_json(pa)
    await recv_json(pb)
    assert set(q["scores"].keys()) == expected_names, f"room {index}: cross-talk in question scores: {q['scores']}"

    # play it out — P.A always answers, so the match ends 3-0 with no deathmatch
    for _ in range(3):
        ans = answer_for(q["text"])
        await pa.send(json.dumps({"type": "answer", "value": ans}))
        result = await recv_json(pa)
        await recv_json(pb)
        assert set(result["scores"].keys()) == expected_names, (
            f"room {index}: cross-talk in result scores: {result['scores']}"
        )
        assert result["winner"] == name_a, f"room {index}: wrong winner: {result['winner']}"

        if result["scores"][name_a] >= 3:
            game_over_a = await recv_json(pa)
            game_over_b = await recv_json(pb)
            assert game_over_a["winner"] == name_a
            assert set(game_over_a["scores"].keys()) == expected_names
            assert set(game_over_b["scores"].keys()) == expected_names
            break
        else:
            q = await recv_json(pa)
            await recv_json(pb)
            assert set(q["scores"].keys()) == expected_names, f"room {index}: cross-talk in question scores"

    await pa.close()
    await pb.close()
    return index


async def main():
    t0 = time.monotonic()
    results = await asyncio.gather(*(run_room(i) for i in range(ROOMS)), return_exceptions=True)
    elapsed = time.monotonic() - t0

    failures = [(i, r) for i, r in enumerate(results) if isinstance(r, Exception)]
    succeeded = ROOMS - len(failures)

    print(f"{succeeded}/{ROOMS} rooms completed cleanly ({succeeded * 2} concurrent connections)"
          f" in {elapsed:.2f}s, zero cross-talk detected" if not failures else
          f"{succeeded}/{ROOMS} rooms completed cleanly in {elapsed:.2f}s")
    for i, err in failures:
        print(f"  room {i} FAILED: {err!r}")

    if failures:
        raise SystemExit(1)
    print("\nALL PASS")


if __name__ == "__main__":
    asyncio.run(main())
