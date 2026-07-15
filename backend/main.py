import random
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles


WIN_SCORE = 5

app = FastAPI()

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
games = {} #dictionary to store the games
manager = ConnectionManager()


async def start_round(room_code):
    a = random.randint(1, 100)
    b = random.randint(1, 100)
    games[room_code]["answer"] = a + b
    games[room_code]["question_time"] = time.monotonic()  # for "fastest answer" — clock time, immune to system-clock changes
    await manager.broadcast(room_code, {"type": "question", "text": f"{a} + {b}"})


@app.websocket("/ws/{room_code}")
async def websocket_endpoint(websocket: WebSocket, room_code: str):
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
        games[room_code] = {"answer": None, "scores": {}, "players": {},
                             "question_time": None, "fastest": None, "rematch_requests": set()}
        for i, sock in enumerate(manager.rooms[room_code], start=1):
            name = f"player{i}"
            games[room_code]["players"][sock] = name
            games[room_code]["scores"][name] = 0
            await sock.send_json({"type": "welcome", "name": name})
    else:
        # game already exists — this is a normal second player joining
        player_name = f"player{len(manager.rooms[room_code])}"
        games[room_code]["players"][websocket] = player_name
        games[room_code]["scores"][player_name] = 0
        await websocket.send_json({"type": "welcome", "name": player_name})

    if len(manager.rooms[room_code]) == 2:
        await start_round(room_code)

    try:
        while True:
            data = await websocket.receive_json()
            if (data.get("type") == "answer"
                    and room_code in games
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
                #if player reached win_score, broadcast the result and no new round starts
                if games[room_code]["scores"][name] >= WIN_SCORE:
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
                    await start_round(room_code)
                else:
                    # one side is waiting on the other
                    await manager.broadcast(room_code, {"type": "rematch_pending", "name": name})

    except WebSocketDisconnect:
        manager.disconnect(websocket, room_code)
        if room_code in games:
            del games[room_code]
        if room_code in manager.rooms:
            await manager.broadcast(room_code, {"type": "opponent_left"})
        
app.mount("/", StaticFiles(directory="static", html=True))