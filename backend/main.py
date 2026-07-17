import asyncio
import random
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles


DEFAULT_TARGET = 5
VALID_TARGETS = {3, 5, 10, 15, 30}   # an allow-list, not "any number a client sends" — never trust the client
GRACE_SECONDS = 20   # a dropped wifi signal shouldn't instantly end someone's match
MAX_NAME_LEN = 16
ALLOWED_EMOTES = {"👋", "😂", "😤", "🔥", "💀"}   # a fixed set, not free text — same never-trust-the-client rule as ops/difficulty

app = FastAPI()


def clean_name(raw, fallback):
    # strip is the only real sanitizing needed — names are only ever displayed
    # via the client's textContent, never innerHTML, so no HTML-escaping to do here
    name = (raw or "").strip()[:MAX_NAME_LEN]
    return name or fallback


def dedupe_name(name, taken):
    # two players picking the same name would collide as the SAME key in
    # scores/players — a second "player1" would silently merge into the first
    # player's score entry instead of getting their own
    if name not in taken:
        return name
    n = 2
    while f"{name} ({n})" in taken:
        n += 1
    return f"{name} ({n})"

@app.get("/health")
def health():
    return {"status": "ok"}


class ConnectionManager:
    def __init__(self):
        self.rooms = {}
    async def connect(self, websocket, room_code):
        await websocket.accept() #accepts the websocket connection
        if room_code not in self.rooms: #checks if the room code exists in the rooms dictionary
            self.rooms[room_code] = []  #initalizes the room code if it does not exist
        self.rooms[room_code].append(websocket) #append the websocket to the room code


    def disconnect(self, websocket, room_code):
        if room_code in self.rooms: #checks if the room code exists in the rooms dictionary
            self.rooms[room_code].remove(websocket) #remove the websocket from the room code
            if not self.rooms[room_code]: #if the room is empty
                del self.rooms[room_code]  #delete the room code from the rooms dictionary

        
    async def broadcast(self, room_code, message):
        for connection in self.rooms[room_code]: #get the room code from the rooms dictionary
            await connection.send_json(message) #send the message to all connections in the room code

    async def broadcast_except(self, room_code, message, excluded):
        for connection in self.rooms[room_code]:
            if connection is not excluded:
                await connection.send_json(message)
games = {} #dictionary to store the games
manager = ConnectionManager()


# difficulty controls ONLY number size — every operator scales with it.
# operators controls ONLY which kinds of question can appear — a separate,
# independent axis, so "hard multiplication" and "easy multiplication" both
# exist as combinations instead of being bundled into one dial.
NUMBER_RANGE = {"easy": (1, 20), "medium": (1, 100), "hard": (1, 300)}
FACTOR_RANGE = {"easy": (2, 6),  "medium": (2, 12),  "hard": (2, 20)}   # times-table-scale, for × and ÷

def _range_for(difficulty):
    return NUMBER_RANGE.get(difficulty, NUMBER_RANGE["medium"])

def _factor_range_for(difficulty):
    return FACTOR_RANGE.get(difficulty, FACTOR_RANGE["medium"])

# each generator returns (question_text, correct_answer), given a difficulty
def _gen_add(difficulty):
    lo, hi = _range_for(difficulty)
    a, b = random.randint(lo, hi), random.randint(lo, hi)
    return f"{a} + {b}", a + b

def _gen_subtract(difficulty):
    lo, hi = _range_for(difficulty)
    a, b = random.randint(lo, hi), random.randint(lo, hi)
    if b > a:
        a, b = b, a   # keep it non-negative — no negative answers to type
    return f"{a} - {b}", a - b

def _gen_multiply(difficulty):
    lo, hi = _factor_range_for(difficulty)
    a, b = random.randint(lo, hi), random.randint(lo, hi)
    return f"{a} × {b}", a * b

def _gen_divide(difficulty):
    # built backwards from the answer, so the division is ALWAYS exact —
    # nobody should ever have to type a fraction in a speed-math game
    lo, hi = _factor_range_for(difficulty)
    divisor = random.randint(lo, hi)
    answer = random.randint(lo, hi)
    return f"{divisor * answer} ÷ {divisor}", answer

def _gen_modulo(difficulty):
    lo, hi = _range_for(difficulty)
    div_lo, div_hi = _factor_range_for(difficulty)
    dividend = random.randint(lo, hi)
    divisor = random.randint(max(2, div_lo), div_hi)   # divisor of 1 is a trivial always-zero remainder
    return f"{dividend} % {divisor}", dividend % divisor

# short ascii keys — kept out of the URL's operator symbols entirely, since
# %, ×, and ÷ all need escaping in a query string; the pretty glyphs only
# ever appear in the question TEXT, sent as normal JSON over the socket
OPERATIONS = {
    "add": _gen_add,
    "sub": _gen_subtract,
    "mul": _gen_multiply,
    "div": _gen_divide,
    "mod": _gen_modulo,
}
DEFAULT_OPS = ["add", "sub"]

def gen_question(difficulty, ops):
    valid_ops = [op for op in ops if op in OPERATIONS] or DEFAULT_OPS   # never trust the client — fall back if empty/garbage
    op = random.choice(valid_ops)
    return OPERATIONS[op](difficulty)


async def start_round(room_code):
    text, answer = gen_question(games[room_code]["difficulty"], games[room_code]["ops"])
    games[room_code]["answer"] = answer
    games[room_code]["question_text"] = text   # so a reconnecting player can be resent the LIVE question, not just told a round exists
    games[room_code]["question_time"] = time.monotonic()  # for "fastest answer" — clock time, immune to system-clock changes
    # scores riding along here (not just on "result"/"game_over") is how a client
    # learns its OPPONENT's real display name — scores is name-keyed, so whichever
    # key isn't "me" IS the opponent, from the very first round, not just after
    # the first point is scored
    await manager.broadcast(room_code, {"type": "question", "text": text, "scores": games[room_code]["scores"]})


ANNOUNCE_SECONDS = 3   # "you vs them" beat before the clock starts — also the only
                       # place in a normal match a player's chosen name actually shows up

async def announce_and_start(room_code):
    # both names, straight from the source — same reason scores rides along
    # on "question": whichever key isn't "me" is the opponent
    await manager.broadcast(room_code, {"type": "match_start",
                                         "names": list(games[room_code]["scores"].keys())})
    await asyncio.sleep(ANNOUNCE_SECONDS)
    if room_code in games:   # the room could've been abandoned mid-countdown (opponent left)
        await start_round(room_code)


async def expire_disconnect(room_code, name):
    await asyncio.sleep(GRACE_SECONDS)
    game = games.get(room_code)
    if not game or name not in game.get("pending_disconnects", {}):
        return   # they reconnected before the window ran out — nothing to expire
    del games[room_code]
    if room_code in manager.rooms:
        await manager.broadcast(room_code, {"type": "opponent_left"})


@app.websocket("/ws/{room_code}")
async def websocket_endpoint(websocket: WebSocket, room_code: str, difficulty: str = "medium",
                              target: int = DEFAULT_TARGET, ops: str = "add,sub", display_name: str = ""):
    # FastAPI reads ?difficulty=...&target=...&ops=... straight off the URL into
    # these parameters (ops arrives as one comma-separated string — repeated
    # query keys would need the pretty +/×/÷/% symbols URL-escaped, so the
    # wire format uses plain ascii names instead: "add,sub,mul"). Only the
    # ROOM'S CREATOR's values ever matter — stored once when the room is
    # first created, ignored from anyone who joins after.
    await manager.connect(websocket, room_code)

    # duels are 1v1 — reject a third connection instead of silently merging
    # them into someone else's match (easy to hit: an empty join box
    # defaults to room "DUEL" for everyone who doesn't type a code)
    if len(manager.rooms[room_code]) > 2:
        await websocket.send_json({"type": "room_full"})
        manager.disconnect(websocket, room_code)
        await websocket.close()
        return

    if room_code not in games:
        # fresh game state. Register EVERY socket currently in this room, not
        # just this one — a previous match's survivor may still be connected
        # (their old game state was deleted when their opponent left) and
        # would otherwise be missing from "players"/"scores" here, crashing
        # the moment they try to answer.
        requested_ops = [op.strip() for op in ops.split(",") if op.strip() in OPERATIONS]
        games[room_code] = {"answer": None, "scores": {}, "players": {}, "question_text": None,
                             "question_time": None, "fastest": None, "rematch_requests": set(),
                             "pending_disconnects": {},   # name -> asyncio task, while they're mid-reconnect-window
                             "paused": False,   # true while someone's mid-reconnect-window — no scoring off an absent opponent
                             "difficulty": difficulty if difficulty in NUMBER_RANGE else "medium",
                             "target": target if target in VALID_TARGETS else DEFAULT_TARGET,
                             "ops": requested_ops or DEFAULT_OPS}
        for i, sock in enumerate(manager.rooms[room_code], start=1):
            # only THIS request's own connection has a real chosen name available —
            # any other socket here is a rare previous-match survivor (see comment
            # above) whose own name was known only to ITS OWN original request
            if sock is websocket:
                name = dedupe_name(clean_name(display_name, f"player{i}"), games[room_code]["scores"])
            else:
                name = f"player{i}"
            games[room_code]["players"][sock] = name
            games[room_code]["scores"][name] = 0
            await sock.send_json({"type": "welcome", "name": name, "target": games[room_code]["target"]})
        reconnect_name = None
    else:
        # a name is "pending disconnect" while its socket is gone but still inside
        # the grace window — anyone reconnecting to this room while one is open
        # is assumed to be that departed player, reclaiming their slot rather
        # than being treated as a brand new joiner (no per-client identity token
        # exists to prove it, so this is a best-effort match, not a guarantee —
        # fine for a casual 1v1 game, see the comment on pending_disconnects)
        pending = games[room_code]["pending_disconnects"]
        reconnect_name = None
        if pending:
            reconnect_name, task = pending.popitem()
            task.cancel()

        if reconnect_name:
            games[room_code]["players"][websocket] = reconnect_name
            games[room_code]["paused"] = False
            await websocket.send_json({"type": "welcome", "name": reconnect_name,
                                        "target": games[room_code]["target"],
                                        "reconnected": True, "scores": games[room_code]["scores"]})
            # only the OTHER player needs telling — broadcasting this to the
            # reconnecting socket too would race ahead of its own question resend below
            await manager.broadcast_except(room_code, {"type": "opponent_reconnected"}, websocket)
            if games[room_code]["answer"] is not None and games[room_code]["question_text"]:
                # bring them back into the LIVE round, not a blank screen — and
                # restart its clock, so the pause itself is never counted as
                # part of anyone's answer time
                games[room_code]["question_time"] = time.monotonic()
                await websocket.send_json({"type": "question", "text": games[room_code]["question_text"]})
        else:
            # game already exists — this is a normal second player joining
            fallback = f"player{len(manager.rooms[room_code])}"
            player_name = dedupe_name(clean_name(display_name, fallback), games[room_code]["scores"])
            games[room_code]["players"][websocket] = player_name
            games[room_code]["scores"][player_name] = 0
            await websocket.send_json({"type": "welcome", "name": player_name, "target": games[room_code]["target"]})

    # only kick off the FIRST round when two players originally come together —
    # a reconnect must never generate a fresh question out from under whoever
    # stayed connected and was mid-round
    if len(manager.rooms[room_code]) == 2 and not reconnect_name and games[room_code]["question_time"] is None:
        await announce_and_start(room_code)

    try:
        while True:
            data = await websocket.receive_json()
            if (data.get("type") == "answer"
                    and room_code in games
                    and not games[room_code]["paused"]   # opponent's mid-reconnect — no free points off an absent player
                    and games[room_code]["answer"] is not None  #no live round -> nothing can score
                    and data.get("value") == games[room_code]["answer"]):
                name = games[room_code]["players"][websocket]
                games[room_code]["scores"][name] += 1

                elapsed = time.monotonic() - games[room_code]["question_time"]
                fastest = games[room_code]["fastest"]
                if fastest is None or elapsed < fastest["time"]:
                    games[room_code]["fastest"] = {"name": name, "time": round(elapsed, 2)}

                await manager.broadcast(room_code, {"type": "result", "winner": name,
                                                    "scores": games[room_code]["scores"],
                                                    "time": round(elapsed, 2)})
                #if player reached the room's target, broadcast the result and no new round starts
                if games[room_code]["scores"][name] >= games[room_code]["target"]:
                    await manager.broadcast(room_code, {"type": "game_over", "winner": name,
                                                        "scores": games[room_code]["scores"],
                                                        "fastest": games[room_code]["fastest"]})
                    games [room_code]["answer"] = None  # Reset the answer to None to indicate the game is over
                else:
                    await start_round(room_code)

            if (data.get("type") == "rematch"
                    and room_code in games):
                name = games[room_code]["players"][websocket]
                games[room_code]["rematch_requests"].add(name)
                wanted = len(games[room_code]["rematch_requests"])
                needed = len(games[room_code]["players"])   # both players in the room, whatever their names
                if wanted >= needed:
                    # everyone's in — reset the game and go again
                    for p in games[room_code]["scores"]:
                        games[room_code]["scores"][p] = 0
                    games[room_code]["rematch_requests"] = set()
                    games[room_code]["fastest"] = None
                    await announce_and_start(room_code)
                else:
                    # one side is waiting on the other
                    await manager.broadcast(room_code, {"type": "rematch_pending", "name": name})

            if (data.get("type") == "emote"
                    and room_code in games
                    and data.get("emoji") in ALLOWED_EMOTES):
                # a pure relay, no game-state effect — only the OTHER player needs
                # it, echoing it back to the sender would just double up their own click
                sender = games[room_code]["players"].get(websocket)
                if sender:
                    await manager.broadcast_except(room_code, {"type": "emote", "emoji": data["emoji"],
                                                                "from": sender}, websocket)

    except WebSocketDisconnect:
        name = games.get(room_code, {}).get("players", {}).pop(websocket, None)
        manager.disconnect(websocket, room_code)
        if room_code in games and name is not None:
            # give them GRACE_SECONDS to come back before the match is abandoned —
            # scores/question stay put in games[room_code], only the socket is gone
            task = asyncio.create_task(expire_disconnect(room_code, name))
            games[room_code]["pending_disconnects"][name] = task
            games[room_code]["paused"] = True   # no scoring off an absent opponent until they're back
            if room_code in manager.rooms:
                await manager.broadcast(room_code, {"type": "opponent_disconnected", "grace_seconds": GRACE_SECONDS})
        elif room_code in games:
            del games[room_code]
            if room_code in manager.rooms:
                await manager.broadcast(room_code, {"type": "opponent_left"})
        
app.mount("/", StaticFiles(directory="static", html=True))