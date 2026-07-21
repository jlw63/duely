"""Verifies the reconnect grace window: a dropped player's match state is
held open (not deleted, not counted as a loss) for GRACE_SECONDS. Reconnecting
inside that window must restore the SAME identity/score and resend the live
question; the still-connected opponent must see the pause take effect (no
scoring off an absent player) and clear the moment the reconnect completes.
"""
import asyncio
import json
import os
import random
import string
import websockets

URL_BASE = os.environ.get("DUELY_URL", "ws://127.0.0.1:8000")


def room_code():
    return "".join(random.choices(string.ascii_uppercase, k=6))


async def recv_json(ws, timeout=8):
    return json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))


def answer_for(text):
    a, b = text.split(" + ")
    return int(a) + int(b)


async def main():
    room = room_code()
    url = f"{URL_BASE}/ws/{room}?difficulty=easy&target=5&ops=add"

    p1 = await websockets.connect(url)
    p2 = await websockets.connect(url)
    w1 = await recv_json(p1)
    w2 = await recv_json(p2)
    await recv_json(p1)  # match_start
    await recv_json(p2)
    q = await recv_json(p1)
    await recv_json(p2)

    # p2 drops mid-match
    await p2.close()
    print("p2 disconnected")
    notice = await recv_json(p1)
    assert notice["type"] == "opponent_disconnected", notice
    print("PASS: p1 notified of disconnect,", notice)

    # p1 tries to answer WHILE p2 is in its grace window — must be ignored,
    # not scored, since the match is paused
    ans = answer_for(q["text"])
    await p1.send(json.dumps({"type": "answer", "value": ans}))
    try:
        leftover = await recv_json(p1, timeout=1.5)
        raise AssertionError(f"server scored an answer while paused: {leftover}")
    except asyncio.TimeoutError:
        print("PASS: answer while paused was silently ignored")

    # p2 reconnects within the grace window
    await asyncio.sleep(1)
    p2b = await websockets.connect(url)
    welcome2b = await recv_json(p2b)
    assert welcome2b["type"] == "welcome"
    assert welcome2b.get("reconnected") is True
    assert welcome2b["name"] == w2["name"], "reconnect must restore the SAME identity"
    print("PASS: reconnect restored identity", welcome2b["name"])

    resent_question = await recv_json(p2b)
    assert resent_question["type"] == "question"
    assert resent_question["text"] == q["text"], "must resume the exact live question"
    print("PASS: resumed at the exact live question")

    reconnect_notice = await recv_json(p1)
    assert reconnect_notice["type"] == "opponent_reconnected"
    print("PASS: still-connected player notified of the reconnect")

    # now that it's unpaused, the SAME answer should score normally
    await p1.send(json.dumps({"type": "answer", "value": ans}))
    result = await recv_json(p1)
    assert result["type"] == "result"
    assert result["scores"][w1["name"]] == 1
    print("PASS: scoring resumes normally post-reconnect")

    await p1.close()
    await p2b.close()
    print("\nALL PASS")


if __name__ == "__main__":
    asyncio.run(main())
