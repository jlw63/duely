let ws = null;    // no connection yet — born when a room is joined
    let me = null;
    let currentRoom = null;
    let leaving = false;   // true while WE chose to close, so onclose stays quiet

// --- sound: short tones synthesized on the fly, no audio files needed ---
// remembered across visits — nobody wants to re-mute every time they reload
let soundOn = localStorage.getItem("duely-sound") !== "off";

function updateSoundToggle() {
    const btn = document.getElementById("sound-toggle");
    btn.classList.toggle("muted", !soundOn);
    btn.setAttribute("aria-pressed", String(!soundOn));
    btn.setAttribute("aria-label", soundOn ? "mute sound" : "unmute sound");
}

let audioCtx = null;
function getAudioCtx() {
    // browsers block audio until a user gesture has happened (autoplay policy) —
    // by the time any sound plays here, the player has already clicked something,
    // so this just needs to lazily create ONE shared context and keep reusing it
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") {
        audioCtx.resume();
    }
    return audioCtx;
}

// one oscillator = one pitch. `type` is the waveform: "sine" is smooth/pleasant,
// "square"/"sawtooth" are buzzier — good for a "miss" or "lose" cue.
// every sound function routes through here, so this is the one place a mute has to check.
function playTone(freq, startTime, duration, type, volume) {
    if (!soundOn) return;
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    // ramping the volume down instead of cutting it dead avoids an audible "click"
    gain.gain.setValueAtTime(volume, ctx.currentTime + startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startTime + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime + startTime);
    osc.stop(ctx.currentTime + startTime + duration);
}

function playCorrect() {   // a quick rising two-note "ding" — you scored
    playTone(660, 0,    0.12, "sine", 0.18);
    playTone(990, 0.09, 0.16, "sine", 0.18);
}
function playMiss() {   // a short low buzz — they were faster this round
    playTone(180, 0, 0.18, "square", 0.09);
}
function playWin() {   // a three-note major triad, the duel's actual fanfare
    playTone(523, 0,    0.14, "sine", 0.2);
    playTone(659, 0.12, 0.14, "sine", 0.2);
    playTone(784, 0.24, 0.3,  "sine", 0.22);
}
function playLose() {   // two descending, buzzy notes
    playTone(300, 0,    0.22, "sawtooth", 0.1);
    playTone(220, 0.18, 0.32, "sawtooth", 0.1);
}
function playWrong() {   // a flat little buzz for a miss on the input itself
    playTone(160, 0, 0.14, "square", 0.08);
}

// --- "wrong answer" feedback ---
// the server never tells a client "you were wrong" (it silently ignores bad
// guesses — see the never-trust-the-client rule in the judge). So this can
// only react to OUR OWN submission: if a short window passes without a
// "result" naming us the winner, treat it as a miss. That covers both an
// actually-wrong number AND being correct-but-too-slow — from the player's
// side, both feel identical ("that attempt didn't score"), so one signal for
// both is honest, not a compromise.
let submissionPending = false;
let submissionTimer = null;

function armSubmissionWatch() {
    submissionPending = true;
    clearTimeout(submissionTimer);
    submissionTimer = setTimeout(() => {
        if (submissionPending) {
            submissionPending = false;
            shakeWrong();
        }
    }, 450);
}

function resolveSubmissionWatch(iWonThisRound) {
    if (!submissionPending) return;
    submissionPending = false;
    clearTimeout(submissionTimer);
    if (!iWonThisRound) { shakeWrong(); }
}

function shakeWrong(elementId) {
    playWrong();
    const box = document.getElementById(elementId || "answer");   // defaults to the answer box (its original use)
    box.classList.add("wrong");        // red border — stays until the player tries again
    box.classList.remove("shake");
    void box.offsetWidth;               // reflow trick: lets the shake replay on back-to-back misses
    box.classList.add("shake");         // one-shot motion — removed by the animationend listener below
}

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

function joinRoom(room, difficulty, target, ops) {
    document.getElementById("lobby-error").classList.remove("show");   // clear any stale error from a previous attempt
    let proto = "ws:";
    if (location.protocol === "https:") {
        proto = "wss:";
    }
    leaving = false;
    // difficulty/target/ops only matter to whoever CREATES the room — the server
    // stores them once and every later joiner (typed code, invite link) just inherits them
    let url = proto + "//" + location.host + "/ws/" + room;
    const params = [];
    if (difficulty) { params.push("difficulty=" + difficulty); }
    if (target) { params.push("target=" + target); }
    if (ops) { params.push("ops=" + ops); }
    if (params.length) { url += "?" + params.join("&"); }
    ws = new WebSocket(url);

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
        document.getElementById("answer").classList.remove("wrong", "shake");  // fresh round, clear the last miss
        submissionPending = false;
        clearTimeout(submissionTimer);
    }
    if (msg.type === "result") {
        updateScore(msg.scores);
        const iWon = msg.winner === me;
        flashRound(iWon);
        resolveSubmissionWatch(iWon);
    }
    if (msg.type === "game_over") {
        updateScore(msg.scores);
        document.getElementById("pulse").style.display = "none";
        document.getElementById("controls").style.display = "none";  // nothing left to answer
        // clearPostgameState() runs FIRST — it resets score/final-score to their
        // "live play" defaults (pips shown), so the postgame overrides below must
        // come AFTER it, or clearPostgameState undoes them the instant they're set
        clearPostgameState();
        document.getElementById("score").style.display = "none";      // pips step aside...
        document.getElementById("final-score").style.display = "flex"; // ...for a score that reads across the room
        const won = msg.winner === me;
        document.body.classList.add("match-over", won ? "won" : "lost");
        if (won) {
            document.getElementById("question").textContent = "you won the duel!";
            document.getElementById("question").classList.add("winner");
            showCelebration(true);
            playWin();
        } else {
            document.getElementById("question").textContent = "you lost the duel!";
            document.getElementById("question").classList.add("loser");
            showCelebration(false);
            playLose();
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
        winTarget = msg.target || 5;   // however many points this room's creator picked
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

// --- score pips: one per side, you=cyan, them=coral ---
// how many is the room's own choice (3/5/10) — learned from "welcome", not hardcoded
let winTarget = 5;

function renderPips(el, filled) {
    let html = "";
    for (let i = 0; i < winTarget; i++) {
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
    if (iWon) { playCorrect(); } else { playMiss(); }
    const q = document.getElementById("question");
    q.classList.remove("flash-you", "flash-them");
    void q.offsetWidth;   // reflow trick: lets the same animation restart back-to-back
    q.classList.add(iWon ? "flash-you" : "flash-them");
}

let selectedDifficulty = "medium";
let selectedTarget = "5";
let selectedOps = ["add", "sub"];   // multi-select — matches the server's own default

function createDuel() {
    // mint a shareable 4-letter code; the backend accepts any room string
    const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";   // no I/O — they read as 1/0
    let code = "";
    for (let i = 0; i < 4; i++) {
        code += letters[Math.floor(Math.random() * letters.length)];
    }
    joinRoom(code, selectedDifficulty, selectedTarget, selectedOps.join(","));
}

function joinTyped() {
    const room = document.getElementById("room").value.trim().toUpperCase();
    if (!room) {
        // no silent fallback room — an empty box used to default to "DUEL" for
        // everyone, which is exactly the "strangers collide" problem the
        // room-full guard exists to catch, just walking in the front door instead.
        // Same shake+red treatment as a missed answer — one visual language for
        // "you need to actually enter something here" everywhere in the app.
        shakeWrong("room");
        document.getElementById("join").classList.add("wrong");   // the whole control flags red, not just the box
        document.getElementById("room").focus();
        return;
    }
    joinRoom(room);
}

function leaveRoom() {
    leaving = true;        // set BEFORE close(), so our own onclose stays quiet
    if (ws) ws.close();
    ws = null;
    me = null;
    winTarget = 5;         // back to the default until the next room's "welcome" says otherwise
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
  if (box.value.trim() === "") return;   // nothing typed, nothing to submit
  ws.send(JSON.stringify({ type: "answer", value: Number(box.value) }));
  box.value = "";   // empty the box for the next round
  box.classList.remove("wrong");   // this attempt is fresh; drop any red tint from the last one
  armSubmissionWatch();
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

document.getElementById("sound-toggle").onclick = () => {
    soundOn = !soundOn;
    localStorage.setItem("duely-sound", soundOn ? "on" : "off");
    updateSoundToggle();
};
updateSoundToggle();   // reflect whatever localStorage remembered, on load

document.querySelectorAll(".diff-opt").forEach((btn) => {
    btn.onclick = () => {
        selectedDifficulty = btn.dataset.difficulty;
        document.querySelectorAll(".diff-opt").forEach((b) => {
            const active = b === btn;
            b.classList.toggle("active", active);
            b.setAttribute("aria-checked", active ? "true" : "false");
        });
    };
});

document.querySelectorAll(".target-opt").forEach((btn) => {
    btn.onclick = () => {
        selectedTarget = btn.dataset.target;
        document.querySelectorAll(".target-opt").forEach((b) => {
            const active = b === btn;
            b.classList.toggle("active", active);
            b.setAttribute("aria-checked", active ? "true" : "false");
        });
    };
});

// multi-select: each chip toggles independently, but at least one operator
// must always stay on — a match with nothing selected has no questions to ask
document.querySelectorAll(".op-opt").forEach((btn) => {
    btn.onclick = () => {
        const op = btn.dataset.op;
        const isActive = btn.classList.contains("active");
        if (isActive && selectedOps.length === 1) { return; }   // refuse to drop the last one
        if (isActive) {
            selectedOps = selectedOps.filter((o) => o !== op);
        } else {
            selectedOps.push(op);
        }
        btn.classList.toggle("active", !isActive);
        btn.setAttribute("aria-checked", (!isActive).toString());
    };
});
document.getElementById("room").addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinTyped();
});
document.getElementById("room").addEventListener("animationend", (e) => {
  if (e.animationName === "shake-wrong") { e.target.classList.remove("shake"); }
});
document.getElementById("room").addEventListener("input", () => {
  document.getElementById("room").classList.remove("wrong");
  document.getElementById("join").classList.remove("wrong");
  document.getElementById("lobby-error").classList.remove("show");   // still used by the room-full server response
});

document.getElementById("send").onclick = sendAnswer;
document.getElementById("answer").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendAnswer();
});
// the shake is a one-shot animation — clear its class the moment CSS says it finished,
// rather than duplicating "0.4s" as a magic number in a setTimeout here too
document.getElementById("answer").addEventListener("animationend", (e) => {
  if (e.animationName === "shake-wrong") { e.target.classList.remove("shake"); }
});
// typing again means a fresh attempt — drop the red tint from the last miss
document.getElementById("answer").addEventListener("input", () => {
  document.getElementById("answer").classList.remove("wrong");
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
