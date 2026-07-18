let ws = null;    // no connection yet — born when a room is joined
    let me = null;
    let opponentName = null;   // learned passively from scores — see ws.onmessage
    let currentRoom = null;
    let leaving = false;   // true while WE chose to close, so onclose stays quiet

// --- display name: optional, remembered across visits. Blank means "let the
// server assign player1/player2" — nobody's forced to pick a name to play. ---
function getPlayerName() {
    return (localStorage.getItem("duely-name") || "").trim().slice(0, 16);
}
function setPlayerName(name) {
    localStorage.setItem("duely-name", name.trim().slice(0, 16));
}

// --- sound: short tones synthesized on the fly, no audio files needed ---
// remembered across visits — nobody wants to re-mute every time they reload
let soundOn = localStorage.getItem("duely-sound") !== "off";

function updateSoundToggle() {
    const btn = document.getElementById("sound-toggle");
    btn.classList.toggle("muted", !soundOn);
    btn.setAttribute("aria-pressed", String(!soundOn));
    btn.setAttribute("aria-label", soundOn ? "mute sound" : "unmute sound");
}

// --- session stats: local only, no accounts, one JSON blob in localStorage ---
function loadStats() {
    try {
        const saved = JSON.parse(localStorage.getItem("duely-stats"));
        return saved || { gamesPlayed: 0, wins: 0, soloBest: 0 };
    } catch (e) {
        return { gamesPlayed: 0, wins: 0, soloBest: 0 };   // corrupted storage — start clean rather than crash
    }
}
function saveStats(stats) {
    localStorage.setItem("duely-stats", JSON.stringify(stats));
}
function recordMultiplayerResult(won) {
    const stats = loadStats();
    stats.gamesPlayed += 1;
    if (won) { stats.wins += 1; }
    saveStats(stats);
    renderStatsStrip();
}
function recordSoloResult(streak) {
    const stats = loadStats();
    const isNewBest = streak > stats.soloBest;
    if (isNewBest) { stats.soloBest = streak; }
    saveStats(stats);
    renderStatsStrip();
    renderSoloBestChip();
    return isNewBest;
}
function renderStatsStrip() {
    const stats = loadStats();
    const strip = document.getElementById("stats-strip");
    if (stats.gamesPlayed === 0) { strip.classList.remove("show"); return; }   // nothing to say to a new visitor yet
    const winRate = Math.round((stats.wins / stats.gamesPlayed) * 100);
    strip.textContent = stats.gamesPlayed + (stats.gamesPlayed === 1 ? " duel played" : " duels played")
        + " · " + winRate + "% win rate";
    strip.classList.add("show");
}
function renderSoloBestChip() {
    const stats = loadStats();
    document.getElementById("solo-best-chip").textContent =
        stats.soloBest > 0 ? "best streak: " + stats.soloBest : "no runs yet";
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
function playDeathmatch() {   // a two-blast klaxon — the decider's tension, not the win/lose fanfare
    playTone(440, 0,    0.16, "sawtooth", 0.14);
    playTone(440, 0.22, 0.16, "sawtooth", 0.14);
}
function playDeathmatchTick() {   // a sharp short beep, one per countdown number
    playTone(520, 0, 0.1, "square", 0.12);
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

// --- reconnect: a dropped socket gets a short window of silent retries before
// giving up. The server holds the match's state open for its own grace period
// (see GRACE_SECONDS in main.py) — this is the client-side half of that same
// idea, so a flaky wifi blip doesn't have to end the match on either side. ---
let lastJoinParams = null;     // remembered so a retry reopens the SAME room/settings, not a fresh join
let hasJoinedGame = false;     // true once "welcome" arrives — gates retries to a real mid-match drop,
                                // not a failed FIRST connection (room full, bad code, etc.)
let reconnectTimer = null;
let reconnectDeadline = 0;
const RECONNECT_RETRY_MS = 1500;
const RECONNECT_WINDOW_MS = 18000;   // a bit under the server's own grace window

function showConnectionStatus(text) {
    const el = document.getElementById("connection-status");
    el.textContent = text;
    el.classList.add("show");
}
function hideConnectionStatus() {
    document.getElementById("connection-status").classList.remove("show");
}

// answering while the opponent's gone is disabled client-side to match the
// server (which silently ignores answers while games[room_code]["paused"]) —
// and the pulse bar visibly freezes rather than hiding, so the match reads as
// "on hold", not "over"
function setMatchPaused(paused) {
    document.getElementById("answer").disabled = paused;
    document.getElementById("send").disabled = paused;
    document.getElementById("pulse").classList.toggle("paused", paused);
}

let opponentGraceInterval = null;
let lastQuestionText = "";   // so the paused screen can hand the LIVE question back, not a blank one

// the pause takes over the question area itself — hidden pulse/controls, a
// countdown standing in where the question was — rather than a small banner
// next to a question that's misleadingly still sitting there unanswerable
function startOpponentGraceCountdown(totalSeconds) {
    let remaining = Math.round(totalSeconds);
    clearInterval(opponentGraceInterval);
    setMatchPaused(true);
    document.getElementById("pulse").style.display = "none";
    document.getElementById("controls").style.display = "none";
    const questionEl = document.getElementById("question");
    const tick = () => {
        questionEl.textContent = "waiting for opponent to reconnect… (" + remaining + "s)";
        remaining -= 1;
    };
    tick();
    opponentGraceInterval = setInterval(() => {
        if (remaining < 0) { clearInterval(opponentGraceInterval); opponentGraceInterval = null; return; }
        tick();
    }, 1000);
}

function stopOpponentGraceCountdown() {
    clearInterval(opponentGraceInterval);
    opponentGraceInterval = null;
    setMatchPaused(false);
    document.getElementById("question").textContent = lastQuestionText;
    document.getElementById("pulse").style.display = "block";
    document.getElementById("controls").style.display = "flex";
}

let deathmatchInterval = null;

// both sides tied one point from winning — a real 3-2-1-GO before the harder
// decider question lands (see DEATHMATCH_DIFFICULTY_BUMP in main.py). The
// countdown itself is presentation, replaying its shake/glow every tick for
// maximum "oh no" — but the question that follows genuinely takes longer.
function startDeathmatchCountdown(totalSeconds) {
    document.body.classList.add("deathmatch");
    document.getElementById("pulse").style.display = "none";
    document.getElementById("controls").style.display = "none";
    const q = document.getElementById("question");
    let remaining = Math.round(totalSeconds);
    clearInterval(deathmatchInterval);
    playDeathmatch();   // the big two-blast klaxon, once, right as the screen goes red
    const tick = () => {
        q.textContent = remaining > 0 ? "DEATHMATCH " + remaining : "DEATHMATCH — GO!";
        q.classList.remove("deathmatch-text");
        void q.offsetWidth;   // reflow trick: replays the shake/glow animation on every tick, not just the first
        q.classList.add("deathmatch-text");
        if (remaining > 0) { playDeathmatchTick(); }
    };
    tick();
    deathmatchInterval = setInterval(() => {
        remaining -= 1;
        if (remaining < -1) { clearInterval(deathmatchInterval); deathmatchInterval = null; return; }
        tick();
    }, 1000);
}

function stopDeathmatchCountdown() {
    clearInterval(deathmatchInterval);
    deathmatchInterval = null;
    document.body.classList.remove("deathmatch");
    document.getElementById("question").classList.remove("deathmatch-text");
}

let matchStartInterval = null;

// the pre-round beat: names flanking a big pulsing countdown — this is the
// ONE place in a normal match a chosen display name is guaranteed to actually
// show up, since the rest (streak badge, fastest-answer stat) are situational
function startMatchStartCountdown(names) {
    const other = names.find((n) => n !== me);
    if (other) { opponentName = other; }
    setWaiting(false);
    document.getElementById("pulse").style.display = "none";
    document.getElementById("controls").style.display = "none";
    document.getElementById("result-row").style.display = "none";   // the countdown screen replaces it, not sits beside it
    document.getElementById("ms-you").textContent = "you";
    document.getElementById("ms-them").textContent = theirLabel();
    document.getElementById("match-start-screen").classList.add("show");
    const countEl = document.getElementById("ms-count");
    let remaining = 3;
    clearInterval(matchStartInterval);
    const tick = () => {
        countEl.textContent = remaining > 0 ? remaining : "GO";
        countEl.style.animation = "none";
        void countEl.offsetWidth;   // reflow trick: replays the pulse animation on every tick, not just the first
        countEl.style.animation = "";
    };
    tick();
    matchStartInterval = setInterval(() => {
        remaining -= 1;
        if (remaining < -1) {
            clearInterval(matchStartInterval);
            matchStartInterval = null;
            return;
        }
        tick();
    }, 1000);
}

function hideMatchStartScreen() {
    document.getElementById("match-start-screen").classList.remove("show");
    document.getElementById("result-row").style.display = "";
}

function giveUpReconnecting() {
    reconnectDeadline = 0;
    hideConnectionStatus();
    clearInterval(matchStartInterval);
    matchStartInterval = null;
    hideMatchStartScreen();
    document.getElementById("question").textContent = "connection lost";
    document.getElementById("pulse").style.display = "none";
    document.getElementById("controls").style.display = "none";
    document.getElementById("rematch").style.display = "none";   // no one to rematch with
    document.getElementById("postgame-actions").style.display = "flex";  // reveals "back to lobby"
}

function attemptReconnect() {
    if (!reconnectDeadline) { reconnectDeadline = performance.now() + RECONNECT_WINDOW_MS; }
    showConnectionStatus("connection lost — reconnecting…");
    setMatchPaused(true);   // our own socket is down — nothing to send anyway
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
        if (performance.now() > reconnectDeadline) { giveUpReconnecting(); return; }
        buildSocket(lastJoinParams.room, lastJoinParams.difficulty, lastJoinParams.target,
                    lastJoinParams.ops, lastJoinParams.bot);
    }, RECONNECT_RETRY_MS);
}

// opens (or reopens) the websocket and wires its handlers. Used both for the
// original join AND every reconnect retry — reconnecting must NOT touch the
// screen/pips setup that joinRoom does once below, or a mid-match reconnect
// would look like starting a brand new duel from scratch.
function buildSocket(room, difficulty, target, ops, bot) {
    let proto = "ws:";
    if (location.protocol === "https:") {
        proto = "wss:";
    }
    leaving = false;
    // difficulty/target/ops only matter to whoever CREATES the room — the server
    // stores them once and every later joiner (typed code, invite link) just inherits them.
    // display_name is different: it's per-PLAYER, sent by everyone, every time.
    // bot is like difficulty/target/ops — only meaningful from the creator, on a fresh room.
    let url = proto + "//" + location.host + "/ws/" + room;
    const params = [];
    if (difficulty) { params.push("difficulty=" + difficulty); }
    if (target) { params.push("target=" + target); }
    if (ops) { params.push("ops=" + ops); }
    if (bot) { params.push("bot=" + bot); }
    const displayName = getPlayerName();
    if (displayName) { params.push("display_name=" + encodeURIComponent(displayName)); }
    if (params.length) { url += "?" + params.join("&"); }
    ws = new WebSocket(url);

    // the connection died and it wasn't us: retry silently if we were mid-match,
    // otherwise say so and offer the exit
    ws.onclose = () => {
        if (leaving) return;
        if (hasJoinedGame) {
            attemptReconnect();
        } else {
            giveUpReconnecting();
        }
    };

ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    console.log("got:", msg);
    // scores is name-keyed and rides along on "question"/"result"/"game_over"/
    // a reconnect "welcome" — whichever key isn't "me" IS the opponent's real
    // chosen display name, learned passively rather than needing its own message
    if (msg.scores) {
        const other = Object.keys(msg.scores).find((n) => n !== me);
        if (other) {
            opponentName = other;
            document.getElementById("their-side-label").textContent = other;   // real name on THEIR pips, not a static "them" — must match the streak copy/callouts, which already use it
        }
        // the pips ALWAYS mirror the server's scores, whatever message they
        // arrived on — a rematch's first question (server just reset to 0-0)
        // used to slip past this, leaving the previous match's pips on screen
        updateScore(msg.scores);
    }
    if (msg.type === "match_start") {
        // a match_start is a fresh match by definition — initial OR rematch —
        // so the board resets HERE, not inferred later from what the question
        // handler can still see of the postgame screen (that inference broke
        // the moment this countdown started clearing the postgame state early)
        renderPips(document.getElementById("my-pips"), 0);
        renderPips(document.getElementById("their-pips"), 0);
        resetStreakBadge();
        startMatchStartCountdown(msg.names);
    }
    if (msg.type === "deathmatch") {
        startDeathmatchCountdown(msg.seconds || 3);
    }
    if (msg.type === "question") {
        clearInterval(matchStartInterval);   // in case the real question ever beats our local countdown to zero
        matchStartInterval = null;
        hideMatchStartScreen();
        stopDeathmatchCountdown();   // the decider's live now — the beat's over, the glow/shake should be too
        setWaiting(false);                                            // opponent's here — match on
        lastQuestionText = msg.text;
        document.getElementById("question").textContent = msg.text;
        document.getElementById("pulse").style.display = "block";   // round is live
        document.getElementById("answer").value = "";                 // whatever you were mid-typing belonged to the OLD question
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
        updateStreak(msg.winner);
    }
    if (msg.type === "emote") {
        showEmoteToast(msg.emoji, false);
    }
    if (msg.type === "game_over") {
        updateScore(msg.scores);
        document.getElementById("pulse").style.display = "none";
        document.getElementById("controls").style.display = "none";  // nothing left to answer
        clearTimeout(streakFadeTimer);
        document.getElementById("streak-badge").classList.remove("show", "fade");  // final-score is the story now, not the streak
        // clearPostgameState() runs FIRST — it resets score/final-score to their
        // "live play" defaults (pips shown), so the postgame overrides below must
        // come AFTER it, or clearPostgameState undoes them the instant they're set
        clearPostgameState();
        document.getElementById("score").style.display = "none";      // pips step aside...
        document.getElementById("final-score").style.display = "flex"; // ...for a score that reads across the room
        const won = msg.winner === me;
        document.body.classList.add("match-over", won ? "won" : "lost");
        recordMultiplayerResult(won);
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
            setPostgameStatus("waiting for " + theirLabel() + "…");
            const rematchBtn = document.getElementById("rematch");
            rematchBtn.disabled = true;
            rematchBtn.textContent = "waiting…";
        } else {
            setPostgameStatus(theirLabel() + " wants a rematch");
            const rematchBtn = document.getElementById("rematch");
            if (!rematchRequested) {
                rematchBtn.disabled = false;
                rematchBtn.textContent = "rematch";
            }
        }
    }
    if (msg.type === "opponent_left") {
        setWaiting(false);   // in case they bailed before the match even started
        hideConnectionStatus();
        stopOpponentGraceCountdown();
        clearInterval(matchStartInterval);
        matchStartInterval = null;
        hideMatchStartScreen();
        stopDeathmatchCountdown();
        document.getElementById("question").textContent = "opponent left the game";
        document.getElementById("pulse").style.display = "none";
        document.getElementById("controls").style.display = "none";
        document.getElementById("score").style.display = "none";
        document.getElementById("final-score").style.display = "flex";  // the score as it stood when they bailed
        document.getElementById("rematch").style.display = "none";   // no one to rematch with
        document.getElementById("postgame-actions").style.display = "flex";  // reveals "back to lobby"
        document.body.classList.add("match-over");   // header trims; no won/lost — nobody actually won this
    }
    // their socket dropped — the server is holding the match open for a
    // little while, waiting to see if they come back, same idea as our own
    // reconnect logic above but for the OTHER side of the duel
    if (msg.type === "opponent_disconnected") {
        startOpponentGraceCountdown(msg.grace_seconds || 20);
    }
    if (msg.type === "opponent_reconnected") {
        stopOpponentGraceCountdown();
        hideConnectionStatus();
    }
    if (msg.type === "room_full") {
        leaving = true;   // this close is expected — don't let onclose show "connection lost"
        showLobbyError("that room already has two players — try a different code.");
    }
    if (msg.type === "welcome") {
        me = msg.name;
        winTarget = msg.target || 5;   // however many points this room's creator picked
        // joinRoom() already drew the pips at the OLD winTarget (5, the module
        // default) before this async "welcome" ever arrived — without a
        // re-render here they'd silently stay wrong until the first scored
        // round happened to call renderPips again via updateScore()
        renderPips(document.getElementById("my-pips"), 0);
        renderPips(document.getElementById("their-pips"), 0);
        const chip = document.getElementById("me-chip");
        chip.textContent = "you’re cyan ▸";
        chip.classList.add("cyan");
        hasJoinedGame = true;
        reconnectDeadline = 0;
        clearTimeout(reconnectTimer);
        hideConnectionStatus();
        setMatchPaused(false);   // covers OUR OWN reconnect; opponent_reconnected handles the other side
        if (msg.reconnected) {
            // WE just reconnected mid-match — resync score, but the screen/pips
            // were never torn down (this socket reopened silently), so no
            // other setup here, just bring the numbers back in line
            updateScore(msg.scores);
        }
    }
};
}

function joinRoom(room, difficulty, target, ops, bot) {
    document.getElementById("lobby-error").classList.remove("show");   // clear any stale error from a previous attempt
    hasJoinedGame = false;
    reconnectDeadline = 0;
    clearTimeout(reconnectTimer);
    lastJoinParams = { room, difficulty, target, ops, bot };
    buildSocket(room, difficulty, target, ops, bot);

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
    resetStreakBadge();
    opponentName = null;
    document.getElementById("their-side-label").textContent = "them";
    setWaiting(true);
}

// "them" was fine when nobody had names, but once real ones exist, showing
// the actual person is worth the extra glance — falls back to "them" until
// their name's been learned (see the msg.scores handling above)
function theirLabel() {
    return opponentName || "them";
}

// --- quick reactions: a fixed emoji set relayed to the OTHER player only
// (the server never echoes a click back to its own sender) — shown as a
// transient pop, not a persistent chat log, since it's flavor, not content ---
// two independent timers — one per side — so a reaction from each player
// arriving close together can't have one's fade-out cancel the other's
let emoteToastTimerYou = null;
let emoteToastTimerThem = null;

function showEmoteToast(emoji, isMine) {
    // one toast lives inside EACH .side (see index.html) — picking the right
    // one means it's centered over that side's own label+pips by ordinary
    // layout, not a guessed offset that can drift off-grid
    const toast = document.getElementById(isMine ? "emote-toast-you" : "emote-toast-them");
    toast.textContent = (isMine ? "you " : theirLabel() + " ");
    const glyph = document.createElement("span");
    glyph.className = "emote-glyph";
    glyph.textContent = emoji;
    toast.append(glyph);
    toast.classList.remove("show");
    void toast.offsetWidth;   // reflow trick: replays the pop on back-to-back reactions
    toast.classList.add("show");
    if (isMine) {
        clearTimeout(emoteToastTimerYou);
        emoteToastTimerYou = setTimeout(() => toast.classList.remove("show"), 1800);
    } else {
        clearTimeout(emoteToastTimerThem);
        emoteToastTimerThem = setTimeout(() => toast.classList.remove("show"), 1800);
    }
}

document.querySelectorAll(".emote-btn").forEach((btn) => {
    btn.onclick = () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const emoji = btn.dataset.emoji;
        ws.send(JSON.stringify({ type: "emote", emoji }));
        showEmoteToast(emoji, true);   // shown locally too — a click should never feel like it did nothing
    };
});

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

// --- duel streak: consecutive rounds taken by the SAME side, tracked purely
// client-side from "result" messages — cosmetic feedback only, mirrors solo's
// "current run" callout without touching the actual scoring/win condition,
// so it can't tilt a competitive 1v1 the way a real bonus would.
// Fires at 3+ (not 2 — a 2-streak happens almost every match and would dilute
// "on fire" into background noise), docked above whichever side's pips are
// actually streaking, and transient: it holds briefly then fades, rather than
// sitting permanently between the score and the input where the eye travels
// to answer the next question. ---
let streakName = null;
let streakCount = 0;
let streakFadeTimer = null;
const STREAK_THRESHOLD = 3;
const STREAK_HOLD_MS = 2200;

function updateStreak(winnerName) {
    if (winnerName === streakName) {
        streakCount += 1;
    } else {
        streakName = winnerName;
        streakCount = 1;
    }
    const badge = document.getElementById("streak-badge");
    clearTimeout(streakFadeTimer);
    if (streakCount < STREAK_THRESHOLD) {
        badge.classList.remove("show", "fade");
        return;
    }
    const iAmStreaking = streakName === me;
    const flames = "\u{1F525}".repeat(Math.min(streakCount - STREAK_THRESHOLD + 1, 3));   // scales, capped at 3
    badge.textContent = (iAmStreaking ? "you're" : theirLabel() + " is") + " on a " + streakCount + "-streak " + flames;
    badge.classList.remove("you", "them", "fade");
    badge.classList.add(iAmStreaking ? "you" : "them");
    badge.classList.remove("show");
    void badge.offsetWidth;   // reflow trick: replays the pop animation on every extension, not just the first
    badge.classList.add("show");
    streakFadeTimer = setTimeout(() => badge.classList.add("fade"), STREAK_HOLD_MS);
}

function resetStreakBadge() {
    streakName = null;
    streakCount = 0;
    clearTimeout(streakFadeTimer);
    document.getElementById("streak-badge").classList.remove("show", "fade");
}

let selectedDifficulty = "medium";
let selectedTarget = "5";
let selectedOps = ["add", "sub"];   // multi-select — matches the server's own default

// ============================================================
// SOLO PRACTICE — a "ghost timer" instead of an opponent. Runs
// entirely client-side: no second player to keep honest against,
// so no server round-trip needed, and it works even if the
// backend is asleep. Reuses the SAME difficulty/ops the player
// already picked in the lobby.
//
// Trade-off worth knowing: this means the question generator
// below is a hand-written JS MIRROR of gen_question() in main.py.
// They are two separate sources of truth — if you change the
// ranges or add an operator on one side, change the other too.
// ============================================================

const SOLO_NUMBER_RANGE = { easy: [1, 20], medium: [1, 100], hard: [1, 300] };
const SOLO_FACTOR_RANGE = { easy: [2, 6],  medium: [2, 12],  hard: [2, 20] };

function soloRandInt(lo, hi) {
    return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function soloGenAdd(difficulty) {
    const [lo, hi] = SOLO_NUMBER_RANGE[difficulty] || SOLO_NUMBER_RANGE.medium;
    const a = soloRandInt(lo, hi), b = soloRandInt(lo, hi);
    return { text: a + " + " + b, answer: a + b };
}
function soloGenSubtract(difficulty) {
    const [lo, hi] = SOLO_NUMBER_RANGE[difficulty] || SOLO_NUMBER_RANGE.medium;
    let a = soloRandInt(lo, hi), b = soloRandInt(lo, hi);
    if (b > a) { const t = a; a = b; b = t; }   // keep it non-negative, same as the server's version
    return { text: a + " - " + b, answer: a - b };
}
function soloGenMultiply(difficulty) {
    const [lo, hi] = SOLO_FACTOR_RANGE[difficulty] || SOLO_FACTOR_RANGE.medium;
    const a = soloRandInt(lo, hi), b = soloRandInt(lo, hi);
    return { text: a + " × " + b, answer: a * b };
}
function soloGenDivide(difficulty) {
    // built backwards from the answer, exactly like the server does — always exact, never a fraction
    const [lo, hi] = SOLO_FACTOR_RANGE[difficulty] || SOLO_FACTOR_RANGE.medium;
    const divisor = soloRandInt(lo, hi), answer = soloRandInt(lo, hi);
    return { text: (divisor * answer) + " ÷ " + divisor, answer: answer };
}
function soloGenModulo(difficulty) {
    const [lo, hi] = SOLO_NUMBER_RANGE[difficulty] || SOLO_NUMBER_RANGE.medium;
    const [dlo, dhi] = SOLO_FACTOR_RANGE[difficulty] || SOLO_FACTOR_RANGE.medium;
    const dividend = soloRandInt(lo, hi);
    const divisor = soloRandInt(Math.max(2, dlo), dhi);   // divisor of 1 is a trivial always-zero remainder
    return { text: dividend + " % " + divisor, answer: dividend % divisor };
}

const SOLO_OPERATIONS = {
    add: soloGenAdd, sub: soloGenSubtract, mul: soloGenMultiply, div: soloGenDivide, mod: soloGenModulo,
};

function soloGenQuestion(difficulty, ops) {
    const validOps = ops.filter((op) => op in SOLO_OPERATIONS);
    const list = validOps.length ? validOps : ["add", "sub"];   // never trust selectedOps blindly either
    const op = list[Math.floor(Math.random() * list.length)];
    return SOLO_OPERATIONS[op](difficulty);
}

// --- the "ghost timer": a single continuously-draining time BANK, not a
// per-question countdown. It keeps running underneath every question in the
// run; a correct answer tops it up (a reward), capped so bonuses can't
// stockpile forever. This is what makes it feel like a personal-best chase
// ("how far can you push before the clock catches you") instead of a
// pass/fail wall each round — there's no human opponent to be fair to here,
// so the pressure comes entirely from this one resource running out. ---
const SOLO_BASE_TIME = 11;    // starting bank
const SOLO_BONUS = 2;         // added to the bank per correct answer
const SOLO_MAX_BANK = 11;     // hard cap — the bar's "full" reading; kept equal to
                               // the starting bank so the run opens with a full bar

// --- solo state machine: intro -> play -> result, same "screens" pattern as lobby/game ---
let soloCorrectAnswer = null;
let soloStreak = 0;
let soloTimeBank = SOLO_BASE_TIME;
let soloTimerHandle = null;   // requestAnimationFrame id, so leaving mid-run can cancel it cleanly
let soloLastTick = 0;

function setSoloState(state) {
    document.getElementById("solo-intro").style.display = state === "intro" ? "flex" : "none";
    document.getElementById("solo-play").style.display = state === "play" ? "flex" : "none";
    document.getElementById("solo-result").style.display = state === "result" ? "flex" : "none";
}

function enterSolo() {
    document.getElementById("lobby").style.display = "none";
    document.getElementById("solo").style.display = "flex";
    document.body.classList.add("playing");   // same compact-header treatment as multiplayer
    renderSoloBestChip();
    setSoloState("intro");
}

function leaveSolo() {
    stopSoloTimer();
    document.body.classList.remove("playing");
    document.getElementById("solo").style.display = "none";
    document.getElementById("lobby").style.display = "flex";
}

function startSolo() {
    soloStreak = 0;
    soloTimeBank = SOLO_BASE_TIME;
    setSoloState("play");
    document.getElementById("solo-answer").value = "";
    startSoloTimer();      // ONE continuous clock for the whole run — never reset per question
    soloNextQuestion();
}

function soloNextQuestion() {
    const q = soloGenQuestion(selectedDifficulty, selectedOps);
    soloCorrectAnswer = q.answer;
    document.getElementById("solo-question").textContent = q.text;
    document.getElementById("solo-question").classList.remove("flash-you", "flash-them");
    document.getElementById("solo-answer").classList.remove("wrong", "shake");
    document.getElementById("solo-answer").focus();
    updateSoloStreakDisplay();
    // deliberately no timer touch here — the bank keeps draining seamlessly across questions
}

// "current run: N correct · best: M" — the retention hook that replaces the
// multiplayer scoreboard. Flips to "new best!" live, the moment this run overtakes it.
function updateSoloStreakDisplay() {
    const best = loadStats().soloBest;
    const bestText = soloStreak > best ? "new best!" : ("best: " + best);
    document.getElementById("solo-streak").innerHTML =
        "current run: <strong>" + soloStreak + "</strong> correct &middot; " + bestText;
}

function startSoloTimer() {
    soloLastTick = performance.now();
    const bar = document.querySelector("#solo-pulse div");
    bar.classList.remove("low");
    bar.style.width = ((soloTimeBank / SOLO_MAX_BANK) * 100) + "%";
    updateSoloTimerNum();
    stopSoloTimer();   // clear any previous loop before starting a fresh one
    soloTimerHandle = requestAnimationFrame(soloTick);
}

// whole seconds left, rounded up — "2" should mean "still some of second 2
// left", not flash to "1" the instant it ticks below 2.0
function updateSoloTimerNum() {
    const num = document.getElementById("solo-timer-num");
    const secondsLeft = Math.max(0, Math.ceil(soloTimeBank));
    num.textContent = secondsLeft;
    num.classList.toggle("low", (soloTimeBank / SOLO_MAX_BANK) < 0.25);
}

function stopSoloTimer() {
    if (soloTimerHandle) { cancelAnimationFrame(soloTimerHandle); soloTimerHandle = null; }
}

function soloTick(now) {
    const elapsed = (now - soloLastTick) / 1000;
    soloLastTick = now;
    soloTimeBank -= elapsed;
    const bar = document.querySelector("#solo-pulse div");
    const pct = Math.max(0, (soloTimeBank / SOLO_MAX_BANK) * 100);
    bar.style.width = pct + "%";
    bar.classList.toggle("low", pct < 25);   // the last stretch turns the bar red — real urgency, not decoration
    updateSoloTimerNum();
    if (soloTimeBank <= 0) {
        stopSoloTimer();
        soloFlashMiss();
        setTimeout(endSoloRun, 400);   // let the coral flash register before the screen changes
        return;
    }
    soloTimerHandle = requestAnimationFrame(soloTick);
}

function soloFlashMiss() {
    playMiss();
    const q = document.getElementById("solo-question");
    q.classList.remove("flash-you", "flash-them");
    void q.offsetWidth;
    q.classList.add("flash-them");
}

function submitSoloAnswer() {
    const box = document.getElementById("solo-answer");
    if (box.value.trim() === "") return;
    const value = Number(box.value);
    box.value = "";
    if (value === soloCorrectAnswer) {
        soloStreak += 1;
        soloTimeBank = Math.min(SOLO_MAX_BANK, soloTimeBank + SOLO_BONUS);   // the reward: top up the bank, capped
        playCorrect();
        const q = document.getElementById("solo-question");
        q.classList.remove("flash-you", "flash-them");
        void q.offsetWidth;
        q.classList.add("flash-you");
        setTimeout(soloNextQuestion, 250);   // the clock keeps draining underneath this brief pause — no reset
    } else {
        // a wrong guess has no run-ending penalty — the time bank hitting zero
        // (see soloTick) is the ONLY way a run ends. This is just visual
        // feedback so a miss doesn't pass by silently: shake + red border,
        // same language as the multiplayer answer box, but no consequence.
        shakeWrong("solo-answer");
    }
}

function endSoloRun() {
    stopSoloTimer();
    const isNewBest = recordSoloResult(soloStreak);
    document.getElementById("solo-final").textContent = soloStreak;
    document.getElementById("solo-final-note").innerHTML = isNewBest
        ? "new best! <strong>" + soloStreak + "</strong> in a row"
        : soloStreak + " in a row — best is " + loadStats().soloBest;
    setSoloState("result");
    document.getElementById("solo-actions").style.display = "flex";   // shares display:none with #postgame-actions — must be revealed explicitly
}

function mintRoomCode() {
    // a shareable 4-letter code; the backend accepts any room string
    const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";   // no I/O — they read as 1/0
    let code = "";
    for (let i = 0; i < 4; i++) {
        code += letters[Math.floor(Math.random() * letters.length)];
    }
    return code;
}

function createDuel() {
    joinRoom(mintRoomCode(), selectedDifficulty, selectedTarget, selectedOps.join(","));
}

// same engine as a real duel — the "opponent" is just a server-simulated
// player (see games[room_code]["bot"] in main.py) that answers on a randomized
// delay. Bot SPEED is tied to the same difficulty dial as the QUESTIONS —
// one control instead of two, at the cost of not being separately tunable.
function createBotDuel() {
    joinRoom(mintRoomCode(), selectedDifficulty, selectedTarget, selectedOps.join(","), selectedDifficulty);
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
    setPostgameStatus("waiting for " + theirLabel() + "…");
    ws.send(JSON.stringify({ type: "rematch" }));
};
document.getElementById("create").onclick = createDuel;
document.getElementById("join").onclick = joinTyped;

const nameInput = document.getElementById("player-name");
nameInput.value = getPlayerName();
nameInput.addEventListener("input", () => setPlayerName(nameInput.value));

// settings stay collapsed by default — most visitors keep the defaults and
// only need this open when they specifically want to change something
document.getElementById("settings-toggle").onclick = () => {
    const toggle = document.getElementById("settings-toggle");
    const card = document.getElementById("settings-card");
    const expanded = card.classList.toggle("show");
    toggle.setAttribute("aria-expanded", expanded.toString());
    // closed -> ▾ (more below), open -> ▴ (collapse back up) — an explicit glyph
    // swap, not a rotated ▾, so the character itself is never ambiguous
    toggle.querySelector(".chevron").textContent = expanded ? "▴" : "▾";
};

document.getElementById("solo-link").onclick = enterSolo;
document.getElementById("bot-link").onclick = createBotDuel;
document.getElementById("solo-leave").onclick = leaveSolo;
document.getElementById("solo-back").onclick = leaveSolo;
document.getElementById("solo-start").onclick = startSolo;
document.getElementById("solo-retry").onclick = startSolo;
document.getElementById("solo-send").onclick = submitSoloAnswer;
document.getElementById("solo-answer").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitSoloAnswer();
});
document.getElementById("solo-answer").addEventListener("animationend", (e) => {
    if (e.animationName === "shake-wrong") { e.target.classList.remove("shake"); }
});
document.getElementById("solo-answer").addEventListener("input", () => {
    document.getElementById("solo-answer").classList.remove("wrong");
});

renderStatsStrip();   // show existing stats immediately on page load, if any

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
    // built with textContent, not innerHTML — fastest.name traces back to
    // whatever display name the OTHER player typed, so it's untrusted text
    stat.innerHTML = "";
    const label = document.createElement("span");
    label.className = "stat-label";
    label.textContent = "fastest answer";
    const value = document.createElement("span");
    value.className = "stat-value " + (whoIsMe ? "you" : "them");
    value.textContent = (whoIsMe ? "you" : theirLabel()) + " · " + fastest.time + "s";
    stat.append(label, value);
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
