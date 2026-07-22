import asyncio
import random
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware


DEFAULT_TARGET = 5
VALID_TARGETS = {3, 5, 10, 15, 30}   # an allow-list, not "any number a client sends" — never trust the client
GRACE_SECONDS = 20   # a dropped wifi signal shouldn't instantly end someone's match
MAX_NAME_LEN = 16
ALLOWED_EMOTES = {"👋", "😂", "😤", "🔥", "💀"}   # a fixed set, not free text — same never-trust-the-client rule as ops/difficulty
VALID_BOT_SKILLS = {"easy", "medium", "hard"}
BOT_NAMES = {"easy": "Rookie Bot", "medium": "Pro Bot", "hard": "Champion Bot"}
BOT_DELAY_RANGE = {"easy": (3.0, 5.5), "medium": (1.8, 3.5), "hard": (0.8, 2.0)}   # seconds, randomized per round
VALID_CATEGORIES = {"math", "geography"}
VALID_ANSWER_MODES = {"type", "choice"}   # geography only — math is always typed

app = FastAPI()


# "no-cache" means "always revalidate before reusing" — NOT "never cache". With
# StaticFiles' ETag, the browser still caches, but checks each load and gets a
# cheap 304 when unchanged / fresh 200 when changed. Without this, browsers
# heuristically serve stale JS/CSS on a normal refresh, so edits silently don't
# show up until a hard-refresh — a real footgun for a single-page app like this.
class NoCacheStaticMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        if request.url.path not in ("/health",) and not request.url.path.startswith("/ws"):
            response.headers["Cache-Control"] = "no-cache"
        return response

app.add_middleware(NoCacheStaticMiddleware)


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


# ============================================================
# GEOGRAPHY — text-answered questions (flags, capitals), unlike math's
# numeric ones. "tier" reuses the same easy/medium/hard vocabulary as
# NUMBER_RANGE, but means general worldwide name-recognition instead of a
# number range — DEATHMATCH_DIFFICULTY_BUMP escalates it the same way either
# way, since that logic only ever touches games[room_code]["difficulty"].
# ============================================================

COUNTRIES = [
    {"iso2": "US", "name": "United States", "aliases": {"us", "usa", "america", "united states of america"},
     "capital": "Washington DC", "capital_aliases": {"washington d.c.", "washington"}, "tier": "easy"},
    {"iso2": "GB", "name": "United Kingdom", "aliases": {"uk", "britain", "great britain"},
     "capital": "London", "capital_aliases": set(), "tier": "easy"},
    {"iso2": "FR", "name": "France", "aliases": set(), "capital": "Paris", "capital_aliases": set(), "tier": "easy"},
    {"iso2": "DE", "name": "Germany", "aliases": set(), "capital": "Berlin", "capital_aliases": set(), "tier": "easy"},
    {"iso2": "JP", "name": "Japan", "aliases": set(), "capital": "Tokyo", "capital_aliases": set(), "tier": "easy"},
    {"iso2": "CN", "name": "China", "aliases": set(), "capital": "Beijing", "capital_aliases": set(), "tier": "easy"},
    {"iso2": "CA", "name": "Canada", "aliases": set(), "capital": "Ottawa", "capital_aliases": set(), "tier": "easy"},
    {"iso2": "AU", "name": "Australia", "aliases": set(), "capital": "Canberra", "capital_aliases": set(), "tier": "easy"},
    {"iso2": "BR", "name": "Brazil", "aliases": set(), "capital": "Brasilia", "capital_aliases": {"brasília"}, "tier": "easy"},
    {"iso2": "IN", "name": "India", "aliases": set(), "capital": "New Delhi", "capital_aliases": {"delhi"}, "tier": "easy"},
    {"iso2": "IT", "name": "Italy", "aliases": set(), "capital": "Rome", "capital_aliases": set(), "tier": "easy"},
    {"iso2": "ES", "name": "Spain", "aliases": set(), "capital": "Madrid", "capital_aliases": set(), "tier": "easy"},

    {"iso2": "MX", "name": "Mexico", "aliases": set(), "capital": "Mexico City", "capital_aliases": set(), "tier": "medium"},
    {"iso2": "RU", "name": "Russia", "aliases": set(), "capital": "Moscow", "capital_aliases": set(), "tier": "medium"},
    {"iso2": "KR", "name": "South Korea", "aliases": {"korea"}, "capital": "Seoul", "capital_aliases": set(), "tier": "medium"},
    {"iso2": "EG", "name": "Egypt", "aliases": set(), "capital": "Cairo", "capital_aliases": set(), "tier": "medium"},
    {"iso2": "AR", "name": "Argentina", "aliases": set(), "capital": "Buenos Aires", "capital_aliases": set(), "tier": "medium"},
    {"iso2": "NL", "name": "Netherlands", "aliases": {"holland"}, "capital": "Amsterdam", "capital_aliases": set(), "tier": "medium"},
    {"iso2": "SE", "name": "Sweden", "aliases": set(), "capital": "Stockholm", "capital_aliases": set(), "tier": "medium"},
    {"iso2": "GR", "name": "Greece", "aliases": set(), "capital": "Athens", "capital_aliases": set(), "tier": "medium"},
    {"iso2": "TR", "name": "Turkey", "aliases": {"turkiye", "türkiye"}, "capital": "Ankara", "capital_aliases": set(), "tier": "medium"},
    {"iso2": "ZA", "name": "South Africa", "aliases": set(), "capital": "Pretoria", "capital_aliases": {"cape town"}, "tier": "medium"},
    {"iso2": "TH", "name": "Thailand", "aliases": set(), "capital": "Bangkok", "capital_aliases": set(), "tier": "medium"},
    {"iso2": "PL", "name": "Poland", "aliases": set(), "capital": "Warsaw", "capital_aliases": set(), "tier": "medium"},

    {"iso2": "KZ", "name": "Kazakhstan", "aliases": set(), "capital": "Astana", "capital_aliases": set(), "tier": "hard"},
    {"iso2": "MN", "name": "Mongolia", "aliases": set(), "capital": "Ulaanbaatar", "capital_aliases": set(), "tier": "hard"},
    {"iso2": "UY", "name": "Uruguay", "aliases": set(), "capital": "Montevideo", "capital_aliases": set(), "tier": "hard"},
    {"iso2": "SI", "name": "Slovenia", "aliases": set(), "capital": "Ljubljana", "capital_aliases": set(), "tier": "hard"},
    {"iso2": "BT", "name": "Bhutan", "aliases": set(), "capital": "Thimphu", "capital_aliases": set(), "tier": "hard"},
    {"iso2": "ER", "name": "Eritrea", "aliases": set(), "capital": "Asmara", "capital_aliases": set(), "tier": "hard"},
    {"iso2": "SR", "name": "Suriname", "aliases": set(), "capital": "Paramaribo", "capital_aliases": set(), "tier": "hard"},
    {"iso2": "KG", "name": "Kyrgyzstan", "aliases": set(), "capital": "Bishkek", "capital_aliases": set(), "tier": "hard"},
    {"iso2": "BF", "name": "Burkina Faso", "aliases": set(), "capital": "Ouagadougou", "capital_aliases": set(), "tier": "hard"},
    {"iso2": "TJ", "name": "Tajikistan", "aliases": set(), "capital": "Dushanbe", "capital_aliases": set(), "tier": "hard"},
    {"iso2": "VU", "name": "Vanuatu", "aliases": set(), "capital": "Port Vila", "capital_aliases": set(), "tier": "hard"},
    {"iso2": "LI", "name": "Liechtenstein", "aliases": set(), "capital": "Vaduz", "capital_aliases": set(), "tier": "hard"},
]

# geography draws from ALL countries regardless of tier — the difficulty dial
# is hidden in this category (its tiers meant country obscurity, a confusing
# knob for a casual quiz). "tier" is kept on the data so difficulty could be
# reintroduced later, but nothing reads it right now.
CHOICE_COUNT = 4   # 1 correct + 3 distractors, in "choice" answer mode


def _pick_distractors(correct_value, key, n):
    # wrong answers are drawn from OTHER countries' real values, so every
    # option is a plausible country/capital rather than obvious filler
    pool = {c[key] for c in COUNTRIES} - {correct_value}
    return random.sample(sorted(pool), min(n, len(pool)))


def _with_choices(correct_value, key):
    options = _pick_distractors(correct_value, key, CHOICE_COUNT - 1) + [correct_value]
    random.shuffle(options)   # or the answer would always sit last
    return options


def _choices_of(answer):
    # None for math (a bare number) and for type-mode geography — the client
    # reads its absence as "render the text input, not buttons"
    return answer.get("choices") if isinstance(answer, dict) else None


def _gen_flag(with_choices=False):
    # the ISO code travels as the question "text"; the client turns it into an
    # <img> (display type "flag"). Flag EMOJI were the obvious first choice but
    # Windows' system font doesn't render them — it shows the two country-code
    # letters instead — so an actual image is the only cross-platform option.
    country = random.choice(COUNTRIES)
    accepted = {country["name"].lower()} | {a.lower() for a in country["aliases"]}
    answer = {"canonical": country["name"], "accepted": accepted}
    if with_choices:
        answer["choices"] = _with_choices(country["name"], "name")
    return country["iso2"].lower(), answer, "flag"

def _gen_capital(with_choices=False):
    country = random.choice(COUNTRIES)
    text = f"capital of {country['name']}?"
    accepted = {country["capital"].lower()} | {a.lower() for a in country["capital_aliases"]}
    answer = {"canonical": country["capital"], "accepted": accepted}
    if with_choices:
        answer["choices"] = _with_choices(country["capital"], "capital")
    return text, answer, "sentence"

GEO_MODES = {"flag": _gen_flag, "capital": _gen_capital}
DEFAULT_GEO_MODES = ["flag", "capital"]

@app.get("/geo-data")
def geo_data():
    # solo mode runs entirely client-side (no per-question round-trip), so it
    # needs its OWN copy of the country data — served from here rather than
    # hand-duplicated in JS, keeping COUNTRIES the single source of truth.
    # (sets aren't JSON-serializable, so aliases go over as sorted lists.)
    return {"countries": [
        {"iso2": c["iso2"].lower(), "name": c["name"],
         "aliases": sorted(c["aliases"]),
         "capital": c["capital"], "capital_aliases": sorted(c["capital_aliases"])}
        for c in COUNTRIES]}

def gen_geo_question(geo_modes, answer_mode="type"):
    valid = [m for m in geo_modes if m in GEO_MODES] or DEFAULT_GEO_MODES   # never trust the client
    mode = random.choice(valid)
    return GEO_MODES[mode](answer_mode == "choice")

def gen_question_for_room(game):
    # math's generator returns (text, answer) — a bare number; geography's
    # returns (text, answer, display) — answer is a dict of accepted text
    # strings, since a country name has no single "correct" spelling to
    # exact-match against. Normalizing math's shape here (display="big")
    # keeps everything downstream (start_round, reconnect resend) uniform.
    if game["category"] == "geography":
        return gen_geo_question(game["geo_modes"], game["answer_mode"])
    text, answer = gen_question(game["difficulty"], game["ops"])
    return text, answer, "big"


# --- typo tolerance (type mode only) ------------------------------------
# Nobody should lose a round they knew the answer to because they dropped a
# letter typing "Ljubljana" at speed. Mirrored in app.js for solo mode —
# change the thresholds in one place, change them in the other.

def _edit_distance(a, b, cap):
    # restricted Damerau-Levenshtein: counts an adjacent-letter TRANSPOSITION
    # as one edit, not two, since "Buhtan" for "Bhutan" is a single slip of
    # the fingers. Bails out early once every cell in a row exceeds `cap`.
    if a == b:
        return 0
    prev2, prev = None, list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, start=1):
            cur[j] = min(prev[j] + 1,            # deletion
                          cur[j - 1] + 1,         # insertion
                          prev[j - 1] + (ca != cb))   # substitution
            if i > 1 and j > 1 and ca == b[j - 2] and a[i - 2] == cb:
                cur[j] = min(cur[j], prev2[j - 2] + 1)   # transposition
        if min(cur) > cap:
            return cap + 1   # can only grow from here — no point finishing
        prev2, prev = prev, cur
    return prev[len(b)]


def _typo_threshold(length):
    # short answers have no slack to give: at 4 characters, one edit is
    # already a different country ("Chad"/"Chat"), so they stay exact-match
    if length <= 4:
        return 0
    if length <= 8:
        return 1
    return 2


def _close_enough(submitted, accepted):
    for candidate in accepted:
        cap = _typo_threshold(len(candidate))
        if cap == 0:
            continue   # exact match was already tried by the caller
        if abs(len(submitted) - len(candidate)) > cap:
            continue   # too different in length for any edit budget to bridge
        if _edit_distance(submitted, candidate, cap) <= cap:
            return True
    return False


def answer_matches(submitted, correct, answer_mode="type"):
    if isinstance(correct, dict):   # geography: a set of accepted lowercase strings
        if not isinstance(submitted, str):
            return False
        guess = submitted.strip().lower()
        if guess in correct["accepted"]:
            return True
        # a clicked button is either exactly right or it isn't — fuzzy
        # matching there would let a near-miss distractor score
        return answer_mode == "type" and _close_enough(guess, correct["accepted"])
    return submitted == correct   # math: exact numeric equality


async def start_round(room_code):
    game = games[room_code]
    text, answer, display = gen_question_for_room(game)
    game["answer"] = answer
    game["question_text"] = text   # so a reconnecting player can be resent the LIVE question, not just told a round exists
    game["question_display"] = display   # "big" (math/flags) or "sentence" (capital prompts) — see #question.sentence
    game["question_time"] = time.monotonic()  # for "fastest answer" — clock time, immune to system-clock changes
    game["round_token"] += 1   # lets a stale bot-answer task (scheduled for an OLD question) recognize it's too late
    game["skip_requests"] = set()   # a new question means any pending skip votes are stale
    game["locked_out"] = set()      # ...and a fresh guess for anyone who missed last round
    # scores riding along here (not just on "result"/"game_over") is how a client
    # learns its OPPONENT's real display name — scores is name-keyed, so whichever
    # key isn't "me" IS the opponent, from the very first round, not just after
    # the first point is scored
    await manager.broadcast(room_code, {"type": "question", "text": text, "scores": game["scores"],
                                        "display": display, "choices": _choices_of(answer)})
    if game["bot"]:
        asyncio.create_task(bot_answer(room_code, game["round_token"]))


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


DEATHMATCH_ANNOUNCE_SECONDS = 3   # long enough for a client-side 3-2-1 before the decider lands
DEATHMATCH_DIFFICULTY_BUMP = {"easy": "medium", "medium": "hard", "hard": "hard"}   # one tier up, capped

async def start_next_round(room_code):
    # a "DEATHMATCH" beat when both sides are tied one point from winning.
    # The countdown/glow/sound are pure presentation, but the question itself
    # DOES get harder for this one round (see DEATHMATCH_DIFFICULTY_BUMP) —
    # the win condition (first to answer) never changes, only how long that
    # takes, so it still can't be tilted toward either player unfairly.
    target = games[room_code]["target"]
    scores = games[room_code]["scores"].values()
    is_deathmatch = target > 1 and all(s == target - 1 for s in scores)
    if is_deathmatch:
        await manager.broadcast(room_code, {"type": "deathmatch", "seconds": DEATHMATCH_ANNOUNCE_SECONDS})
        await asyncio.sleep(DEATHMATCH_ANNOUNCE_SECONDS)
        if room_code in games:
            original_difficulty = games[room_code]["difficulty"]
            games[room_code]["difficulty"] = DEATHMATCH_DIFFICULTY_BUMP.get(original_difficulty, original_difficulty)
            await start_round(room_code)
            games[room_code]["difficulty"] = original_difficulty   # only THIS round is harder — a rematch starts fresh
            return
    if room_code in games:   # the room could've been abandoned mid-announce
        await start_round(room_code)


async def record_answer(room_code, name):
    # shared by a real player's correct answer AND the bot's simulated one —
    # neither the scoring, streak, deathmatch-trigger, nor game-over logic
    # needs to know or care which kind of "player" just answered.
    game = games[room_code]
    # invalidate the round FIRST, before any `await` below — a same-tick race
    # (a real player answers the instant the bot's delayed task also fires)
    # can't double-score, since nothing can interleave until the next await
    game["answer"] = None
    game["round_token"] += 1
    game["scores"][name] += 1

    elapsed = time.monotonic() - game["question_time"]
    fastest = game["fastest"]
    if fastest is None or elapsed < fastest["time"]:
        game["fastest"] = {"name": name, "time": round(elapsed, 2)}

    await manager.broadcast(room_code, {"type": "result", "winner": name,
                                        "scores": game["scores"], "time": round(elapsed, 2)})
    if game["scores"][name] >= game["target"]:
        await manager.broadcast(room_code, {"type": "game_over", "winner": name,
                                            "scores": game["scores"], "fastest": game["fastest"]})
    else:
        await start_next_round(room_code)


async def bot_answer(room_code, round_token):
    game = games.get(room_code)
    if not game or not game["bot"]:
        return
    delay = random.uniform(*BOT_DELAY_RANGE[game["bot"]["skill"]])
    await asyncio.sleep(delay)
    game = games.get(room_code)
    # bail if the round's already moved on (a real player beat it to the answer,
    # or a rematch/deathmatch reset things), or the human's mid-reconnect
    if not game or game["round_token"] != round_token or game["paused"] or game["answer"] is None:
        return
    await record_answer(room_code, game["bot"]["name"])


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
                              target: int = DEFAULT_TARGET, ops: str = "add,sub", display_name: str = "",
                              bot: str = "", category: str = "math", geo: str = "flag,capital",
                              answer_mode: str = "type", leaving: bool = False):
    # FastAPI reads ?difficulty=...&target=...&ops=... straight off the URL into
    # these parameters (ops arrives as one comma-separated string — repeated
    # query keys would need the pretty +/×/÷/% symbols URL-escaped, so the
    # wire format uses plain ascii names instead: "add,sub,mul"). Only the
    # ROOM'S CREATOR's values ever matter — stored once when the room is
    # first created, ignored from anyone who joins after. `bot` is the same:
    # only meaningful from the creator, and only on a brand-new room.
    await manager.connect(websocket, room_code)

    # A player whose OWN socket had already dropped can't send a "leave" over it,
    # so they open a throwaway one carrying ?leaving=1 purely to deliver the news.
    # Handled before any join/reconnect logic below, so it never counts as the
    # departing player rejoining (which would flash "opponent reconnected" at the
    # other side an instant before telling them the match is over).
    if leaving:
        if room_code in games:
            for task in games[room_code]["pending_disconnects"].values():
                task.cancel()
            del games[room_code]
        await manager.broadcast_except(room_code, {"type": "opponent_left"}, websocket)
        manager.disconnect(websocket, room_code)
        await websocket.close()
        return

    # duels are 1v1 — reject a third connection instead of silently merging
    # them into someone else's match (easy to hit: an empty join box
    # defaults to room "DUEL" for everyone who doesn't type a code). A bot
    # room only ever needs ONE real socket — the "second player" is virtual.
    is_existing_bot_room = room_code in games and games[room_code]["bot"]
    room_cap = 1 if is_existing_bot_room else 2
    if len(manager.rooms[room_code]) > room_cap:
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
        requested_geo = [g.strip() for g in geo.split(",") if g.strip() in GEO_MODES]
        games[room_code] = {"answer": None, "scores": {}, "players": {}, "question_text": None,
                             "question_display": "big",
                             "question_time": None, "fastest": None, "rematch_requests": set(),
                             "skip_requests": set(),   # names who've clicked "idk, skip" on the LIVE question
                             "locked_out": set(),      # choice mode: names who already burned their one guess this round
                             "pending_disconnects": {},   # name -> asyncio task, while they're mid-reconnect-window
                             "paused": False,   # true while someone's mid-reconnect-window — no scoring off an absent opponent
                             "difficulty": difficulty if difficulty in NUMBER_RANGE else "medium",
                             "target": target if target in VALID_TARGETS else DEFAULT_TARGET,
                             "ops": requested_ops or DEFAULT_OPS,
                             "category": category if category in VALID_CATEGORIES else "math",
                             "geo_modes": requested_geo or DEFAULT_GEO_MODES,
                             "answer_mode": answer_mode if answer_mode in VALID_ANSWER_MODES else "type",
                             "bot": None, "round_token": 0}
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
            await sock.send_json({"type": "welcome", "name": name, "target": games[room_code]["target"],
                                   "category": games[room_code]["category"]})
        if bot in VALID_BOT_SKILLS:
            # the "second player" — never a real socket, just a scores/name
            # entry the rest of the engine (rounds, streaks, deathmatch,
            # rematch) already treats identically to a human
            bot_name = dedupe_name(BOT_NAMES[bot], games[room_code]["scores"])
            games[room_code]["scores"][bot_name] = 0
            games[room_code]["bot"] = {"name": bot_name, "skill": bot}
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
                                        "category": games[room_code]["category"],
                                        "reconnected": True, "scores": games[room_code]["scores"]})
            # only the OTHER player needs telling — broadcasting this to the
            # reconnecting socket too would race ahead of its own question resend below
            await manager.broadcast_except(room_code, {"type": "opponent_reconnected"}, websocket)
            if games[room_code]["answer"] is not None and games[room_code]["question_text"]:
                # bring them back into the LIVE round, not a blank screen — and
                # restart its clock, so the pause itself is never counted as
                # part of anyone's answer time
                games[room_code]["question_time"] = time.monotonic()
                await websocket.send_json({"type": "question", "text": games[room_code]["question_text"],
                                            "display": games[room_code]["question_display"],
                                            "choices": _choices_of(games[room_code]["answer"])})
        else:
            # game already exists — this is a normal second player joining
            fallback = f"player{len(manager.rooms[room_code])}"
            player_name = dedupe_name(clean_name(display_name, fallback), games[room_code]["scores"])
            games[room_code]["players"][websocket] = player_name
            games[room_code]["scores"][player_name] = 0
            await websocket.send_json({"type": "welcome", "name": player_name, "target": games[room_code]["target"],
                                        "category": games[room_code]["category"]})

    # only kick off the FIRST round when two players originally come together —
    # a reconnect must never generate a fresh question out from under whoever
    # stayed connected and was mid-round. A bot room only ever gets ONE real
    # socket, so its "both players here" moment is just that socket connecting.
    ready = len(manager.rooms[room_code]) == 2 or games[room_code]["bot"]
    if ready and not reconnect_name and games[room_code]["question_time"] is None:
        await announce_and_start(room_code)

    try:
        while True:
            data = await websocket.receive_json()
            if (data.get("type") == "answer"
                    and room_code in games
                    and not games[room_code]["paused"]   # opponent's mid-reconnect — no free points off an absent player
                    and games[room_code]["answer"] is not None):  # no live round -> nothing can score
                game = games[room_code]
                name = game["players"][websocket]
                # choice mode gives ONE guess per round — with only four options,
                # unlimited clicking would make blind guess-spam a winning
                # strategy. Enforced here, not just by the client greying its
                # own buttons, since a crafted socket message would sail past that.
                is_choice = game["category"] == "geography" and game["answer_mode"] == "choice"
                if not (is_choice and name in game["locked_out"]):
                    if answer_matches(data.get("value"), game["answer"], game["answer_mode"]):
                        await record_answer(room_code, name)
                    elif is_choice:
                        game["locked_out"].add(name)
                        await websocket.send_json({"type": "locked_out"})
                        # if BOTH sides have now burned their guess, nobody can
                        # take this round — move on rather than stalling on a
                        # question no one is able to answer
                        if len(game["locked_out"]) >= len(game["players"]) and not game["bot"]:
                            game["answer"] = None       # invalidate BEFORE the awaits below, same race guard as record_answer
                            game["round_token"] += 1
                            await manager.broadcast(room_code, {"type": "round_lost"})
                            await start_round(room_code)

            if (data.get("type") == "skip"
                    and room_code in games
                    and games[room_code]["category"] == "geography"   # never trust the client — math has no skip button
                    and not games[room_code]["paused"]   # opponent's mid-reconnect — nothing live to skip
                    and games[room_code]["answer"] is not None):   # no live round -> nothing to skip
                game = games[room_code]
                name = game["players"][websocket]
                game["skip_requests"].add(name)
                wanted = len(game["skip_requests"])
                needed = len(game["players"])   # both real players — a bot never votes, so a bot room resolves on one click
                if wanted >= needed:
                    # invalidate the round FIRST, before the broadcast's await — same
                    # same-tick-race guard as record_answer, so a reply that lands in
                    # the same instant can't score off a question that's being skipped
                    game["answer"] = None
                    game["round_token"] += 1
                    await manager.broadcast(room_code, {"type": "skipped"})
                    await start_round(room_code)
                else:
                    await manager.broadcast(room_code, {"type": "skip_pending", "name": name})

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

            # A deliberate exit, not a dropped connection. Both arrive here as a
            # closed socket otherwise, and the grace window can't tell them
            # apart — so the leaver announces itself first, and the player left
            # behind gets the result screen immediately instead of watching a
            # 20-second countdown for someone who is never coming back.
            if data.get("type") == "leave" and room_code in games:
                # any grace timer already ticking for the OTHER player is moot now —
                # the match is over either way, and leaving it running would delete
                # a room key that no longer exists
                for task in games[room_code]["pending_disconnects"].values():
                    task.cancel()
                del games[room_code]
                # tell the other side BEFORE dropping this socket: manager.disconnect
                # deletes the room entry once it's empty, which broadcast would then
                # trip over
                await manager.broadcast_except(room_code, {"type": "opponent_left"}, websocket)
                manager.disconnect(websocket, room_code)
                break   # stop reading from a socket whose owner is on their way out

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