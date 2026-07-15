let ws = null;    // no connection yet — born when a room is joined
    let me = null;
    let currentRoom = null;
    let leaving = false;   // true while WE chose to close, so onclose stays quiet

// waiting = code-sharing hero; match = question + pips + input. Never both.
function setWaiting(w) {
    document.getElementById("wait").style.display = w ? "flex" : "none";
    document.getElementById("question").style.display = w ? "none" : "block";
    document.getElementById("score").style.display = w ? "none" : "flex";
    document.getElementById("controls").style.display = w ? "none" : "flex";
    document.getElementById("room-chip").style.display = w ? "none" : "";  // hero code IS the room; chip returns for the match
    if (w) { document.getElementById("pulse").style.display = "none"; }
    if (!w) { clearPostgameState(); }
}

function showLobbyError(text) {
    leaveRoom();
    const err = document.getElementById("lobby-error");
    err.textContent = text;
    err.classList.add("show");
}

function joinRoom(room) {
    document.getElementById("lobby-error").classList.remove("show");   // clear any stale error from a previous attempt
    let proto = "ws:";
    if (location.protocol === "https:") {
        proto = "wss:";
    }
    leaving = false;
    ws = new WebSocket(proto + "//" + location.host + "/ws/" + room);

    // the connection died and it wasn't us: say so, offer the exit
    ws.onclose = () => {
        if (!leaving) {
            document.getElementById("question").textContent = "connection lost";
            document.getElementById("pulse").style.display = "none";
            document.getElementById("controls").style.display = "none";
            document.getElementById("rematch").style.display = "none";   // no one to rematch with
            document.getElementById("postgame-actions").style.display = "flex";  // reveals "back to lobby"
        }
    };

ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    console.log("got:", msg);
    if (msg.type === "question") {
        // a "question" after postgame-actions was showing means this is a rematch's
        // first round, not the next round of an ongoing match — pips must go back to 0
        const isRematchStart = document.getElementById("postgame-actions").style.display !== "none";
        if (isRematchStart) {
            renderPips(document.getElementById("my-pips"), 0);
            renderPips(document.getElementById("their-pips"), 0);
        }
        setWaiting(false);                                            // opponent's here — match on
        document.getElementById("question").textContent = msg.text;
        document.getElementById("pulse").style.display = "block";   // round is live
        document.getElementById("answer").focus();                   // hands on keys, every round
    }
    if (msg.type === "result") {
        updateScore(msg.scores);
        flashRound(msg.winner === me);
    }
    if (msg.type === "game_over") {
        updateScore(msg.scores);
        document.getElementById("pulse").style.display = "none";
        document.getElementById("controls").style.display = "none";  // nothing left to answer
        document.getElementById("score").style.display = "none";      // pips step aside...
        document.getElementById("final-score").style.display = "flex"; // ...for a score that reads across the room
        clearPostgameState();
        const won = msg.winner === me;
        document.body.classList.add("match-over", won ? "won" : "lost");
        if (won) {
            document.getElementById("question").textContent = "you won the duel!";
            document.getElementById("question").classList.add("winner");
            showCelebration(true);
        } else {
            document.getElementById("question").textContent = "you lost the duel!";
            document.getElementById("question").classList.add("loser");
            showCelebration(false);
        }
        if (msg.fastest) {
            buildFastestStat(msg.fastest);
        }
        document.getElementById("rematch").style.display = "inline-block";
        document.getElementById("postgame-actions").style.display = "flex";
    }
    if (msg.type === "rematch_pending") {
        const isMe = msg.name === me;
        if (isMe) {
            setPostgameStatus("waiting for them…");
            const rematchBtn = document.getElementById("rematch");
            rematchBtn.disabled = true;
            rematchBtn.textContent = "waiting…";
        } else {
            setPostgameStatus("them wants a rematch");
            const rematchBtn = document.getElementById("rematch");
            if (!rematchRequested) {
                rematchBtn.disabled = false;
                rematchBtn.textContent = "rematch";
            }
        }
    }
    if (msg.type === "opponent_left") {
        setWaiting(false);   // in case they bailed before the match even started
        document.getElementById("question").textContent = "opponent left the game";
        document.getElementById("pulse").style.display = "none";
        document.getElementById("controls").style.display = "none";
        document.getElementById("score").style.display = "none";
        document.getElementById("final-score").style.display = "flex";  // the score as it stood when they bailed
        document.getElementById("rematch").style.display = "none";   // no one to rematch with
        document.getElementById("postgame-actions").style.display = "flex";  // reveals "back to lobby"
        document.body.classList.add("match-over");   // header trims; no won/lost — nobody actually won this
    }
    if (msg.type === "room_full") {
        leaving = true;   // this close is expected — don't let onclose show "connection lost"
        showLobbyError("that room already has two players — try a different code.");
    }
    if (msg.type === "welcome") {
        me = msg.name;
        const chip = document.getElementById("me-chip");
        chip.textContent = "you’re cyan ▸";
        chip.classList.add("cyan");
    }
};

    // swap screens: lobby out, game in (waiting state: share the code)
    currentRoom = room;
    document.getElementById("room-chip").textContent = "room: " + room;
    document.getElementById("invite-code").textContent = room;
    document.getElementById("copy").textContent = "copy invite link";
    document.getElementById("lobby").style.display = "none";
    document.getElementById("game").style.display = "flex";
    document.body.classList.add("playing");   // header steps aside
    renderPips(document.getElementById("my-pips"), 0);
    renderPips(document.getElementById("their-pips"), 0);
    setWaiting(true);
}

// --- score pips: 5 per side, you=cyan, them=coral ---
function renderPips(el, filled) {
    let html = "";
    for (let i = 0; i < 5; i++) {
        html += '<span class="pip' + (i < filled ? ' filled' : '') + '"></span>';
    }
    el.innerHTML = html;
}

function updateScore(scores) {
    let mine = 0, theirs = 0;
    for (const name in scores) {
        if (name === me) { mine = scores[name]; } else { theirs = scores[name]; }
    }
    renderPips(document.getElementById("my-pips"), mine);
    renderPips(document.getElementById("their-pips"), theirs);
    document.getElementById("fs-you").textContent = mine;
    document.getElementById("fs-them").textContent = theirs;
}

// --- round feedback: flash the question cyan (you scored) or coral (they did) ---
function flashRound(iWon) {
    const q = document.getElementById("question");
    q.classList.remove("flash-you", "flash-them");
    void q.offsetWidth;   // reflow trick: lets the same animation restart back-to-back
    q.classList.add(iWon ? "flash-you" : "flash-them");
}

function createDuel() {
    // mint a shareable 4-letter code; the backend accepts any room string
    const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";   // no I/O — they read as 1/0
    let code = "";
    for (let i = 0; i < 4; i++) {
        code += letters[Math.floor(Math.random() * letters.length)];
    }
    joinRoom(code);
}

function joinTyped() {
    const room = document.getElementById("room").value.trim().toUpperCase() || "DUEL";
    joinRoom(room);
}

function leaveRoom() {
    leaving = true;        // set BEFORE close(), so our own onclose stays quiet
    if (ws) ws.close();
    ws = null;
    me = null;
    // reset the game screen to its factory state for next time
    document.body.classList.remove("playing");   // full-size header returns for the lobby
    document.getElementById("question").textContent = "waiting for opponent...";
    document.getElementById("question").classList.remove("flash-you", "flash-them", "winner", "loser");
    renderPips(document.getElementById("my-pips"), 0);
    renderPips(document.getElementById("their-pips"), 0);
    document.getElementById("pulse").style.display = "none";
    const chip = document.getElementById("me-chip");
    chip.textContent = "connecting...";
    chip.classList.remove("cyan");
    document.getElementById("answer").value = "";
    clearPostgameState();   // hides postgame-actions, which #again lives inside — no separate reset needed
    // swap screens back
    document.getElementById("game").style.display = "none";
    document.getElementById("lobby").style.display = "flex";
    document.getElementById("room").focus();
}

function sendAnswer() {
  if (!ws) return;   // no live connection, nothing to send
  const box = document.getElementById("answer");
  ws.send(JSON.stringify({ type: "answer", value: Number(box.value) }));
  box.value = "";   // empty the box for the next round
}

document.getElementById("copy").onclick = () => {
    navigator.clipboard.writeText(location.origin + "/?room=" + currentRoom);
    const btn = document.getElementById("copy");
    btn.textContent = "copied ✓";
    setTimeout(() => { btn.textContent = "copy invite link"; }, 1500);
};

document.getElementById("leave").onclick = leaveRoom;
document.getElementById("again").onclick = leaveRoom;
document.getElementById("rematch").onclick = () => {
    if (!ws) return;
    rematchRequested = true;
    const rematchBtn = document.getElementById("rematch");
    rematchBtn.disabled = true;
    rematchBtn.textContent = "waiting…";
    setPostgameStatus("waiting for them…");
    ws.send(JSON.stringify({ type: "rematch" }));
};
document.getElementById("create").onclick = createDuel;
document.getElementById("join").onclick = joinTyped;
document.getElementById("room").addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinTyped();
});

document.getElementById("send").onclick = sendAnswer;
document.getElementById("answer").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendAnswer();
});

// invite links: /?room=XNDS joins straight into the room, no lobby
const inviteRoom = new URLSearchParams(location.search).get("room");
if (inviteRoom) {
    joinRoom(inviteRoom.trim().toUpperCase());
}

let rematchRequested = false;

function setPostgameStatus(text) {
    const note = document.getElementById("postgame-status");
    note.textContent = text || "";
    note.style.display = text ? "block" : "none";
}

// labeled pill: "FASTEST ANSWER  you · 2.49s" — whose it was reads from the color, same as the score side-labels
function buildFastestStat(fastest) {
    const stat = document.getElementById("fastest");
    const whoIsMe = fastest.name === me;
    stat.innerHTML = '<span class="stat-label">fastest answer</span>'
        + '<span class="stat-value ' + (whoIsMe ? "you" : "them") + '">'
        + (whoIsMe ? "you" : "them") + ' &middot; ' + fastest.time + 's</span>';
    stat.classList.add("show");
}

function clearPostgameState() {
    rematchRequested = false;
    const rematchBtn = document.getElementById("rematch");
    rematchBtn.style.display = "none";
    rematchBtn.disabled = false;
    rematchBtn.textContent = "rematch";
    document.getElementById("postgame-actions").style.display = "none";
    setPostgameStatus("");
    document.getElementById("fastest").classList.remove("show");
    showCelebration(false);
    document.getElementById("question").classList.remove("winner", "loser");
    document.body.classList.remove("match-over", "won", "lost");   // header/glow/triangles reset for the next match
    document.getElementById("final-score").style.display = "none";
    document.getElementById("score").style.display = "flex";        // pips return for live play
}

function showCelebration(show) {
    const celebration = document.getElementById("celebration");
    if (!show) {
        celebration.classList.remove("show");
        return;
    }
    celebration.classList.add("show");
    setTimeout(() => celebration.classList.remove("show"), 900);
}
