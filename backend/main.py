import random

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

app = FastAPI()

@app.get("/")
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


@app.websocket("/ws/{room_code}")
async def websocket_endpoint(websocket: WebSocket, room_code: str):
    await manager.connect(websocket, room_code) #connect the websocket to the room code
    if room_code not in games:
        games[room_code] = {"answer": None, "scores": {}, "players": {}} #initialize the game if it does not exist
        
    player_name = f"player{len((manager.rooms[room_code]))}" #generate a player name based on the number of players in the room
    games[room_code]["players"][websocket] = player_name
    games[room_code]["scores"][player_name] = 0 #initialize the score for the player

    if len(manager.rooms[room_code]) == 2:
        a = random.randint(1, 100) #generate a random number between 1 and 100
        b = random.randint(1, 100) #generate a random number between 1 and 100
        games[room_code]["answer"] = a + b #set the answer to the sum of the two random numbers
        await manager.broadcast(room_code, {"type": "question", "text": f"What is {a} + {b}?"}) #broadcast the question to all connections in the room code
    try: #attempt to receive messages from the websocket
        while True:
            data = await websocket.receive_json() #receive the message from the websocket
            await manager.broadcast(room_code, data) #broadcast the message to all connections in the room code
    except WebSocketDisconnect: #if the websocket disconnects
        manager.disconnect(websocket, room_code) #disconnect the websocket from the room code

