import random

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
    await manager.broadcast(room_code, {"type": "question", "text": f"What is {a} + {b}?"})


@app.websocket("/ws/{room_code}")
async def websocket_endpoint(websocket: WebSocket, room_code: str):
    await manager.connect(websocket, room_code)

    if room_code not in games:
        games[room_code] = {"answer": None, "scores": {}, "players": {}}

    player_name = f"player{len(manager.rooms[room_code])}"
    games[room_code]["players"][websocket] = player_name
    games[room_code]["scores"][player_name] = 0

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
                await manager.broadcast(room_code, {"type": "result", "winner": name,
                                                    "scores": games[room_code]["scores"]})
                #if player reached win_score, broadcast the result and no new round starts
                if games[room_code]["scores"][name] >= WIN_SCORE:
                    await manager.broadcast(room_code, {"type": "game_over", "winner": name,
                                                        "scores": games[room_code]["scores"]})
                    games [room_code]["answer"] = None  # Reset the answer to None to indicate the game is over
                else:
                    await start_round(room_code)
                
    except WebSocketDisconnect:
        manager.disconnect(websocket, room_code)
        if room_code in games:
            del games[room_code]
        if room_code in manager.rooms:
            await manager.broadcast(room_code, {"type": "opponent_left"})
        
app.mount("/", StaticFiles(directory="static", html=True))