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

// --- session stats: deliberately NOT persisted. These reset on every page
// load, so the win rate always describes "how am I doing right now" rather
// than dragging a lifetime average around. The lobby SETTINGS are the
// opposite — see loadSettings() — since re-picking them every visit is pure
// friction, while a stale win rate is actively misleading. ---
let sessionStats = { gamesPlayed: 0, wins: 0, soloBest: 0 };

// a leftover from when these WERE persisted — drop it so an old lifetime
// total can't reappear if this ever reads localStorage again
localStorage.removeItem("duely-stats");

function loadStats() {
    return sessionStats;
}
function saveStats(stats) {
    sessionStats = stats;
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

let isGeoMatch = false;      // set from "welcome" — gates the skip row, math has no use for it
let controlsVisible = false; // whether the round's answering controls belong on screen at all

// the one place #controls' visibility changes — #skip-row and the multi-choice
// buttons ride along with it, so every caller that used to touch #controls
// directly can't forget them and leave them showing over a math round or a
// postgame screen
function setControlsVisible(visible) {
    controlsVisible = visible;
    document.getElementById("skip-row").style.display = (visible && isGeoMatch) ? "flex" : "none";
    renderAnswerUI();
}

// which answering control the round actually gets: four buttons when the
// server sent choices, the text box otherwise. Split out from
// setControlsVisible so a new question can re-render the buttons without the
// caller needing to know which mode the room is in.
function renderAnswerUI() {
    const wantChoices = controlsVisible && Array.isArray(lastQuestionChoices);
    document.getElementById("controls").style.display = (controlsVisible && !wantChoices) ? "flex" : "none";
    if (wantChoices) {
        renderChoiceButtons("answer-choices", lastQuestionChoices, sendChoiceAnswer);
        if (choiceLockedOut) { lockChoiceButtons("answer-choices", null); }
    } else {
        clearChoiceButtons("answer-choices");
        if (controlsVisible) { document.getElementById("answer").focus(); }   // hands on keys, every round
    }
}

// waiting = code-sharing hero; match = question + pips + input. Never both.
function setWaiting(w) {
    document.getElementById("wait").style.display = w ? "flex" : "none";
    document.getElementById("question").style.display = w ? "none" : "block";
    document.getElementById("score").style.display = w ? "none" : "flex";
    setControlsVisible(!w);
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
    document.getElementById("skip-btn").disabled = paused || skipRequested;   // stays disabled after unpause if already voted this round
    // same rule for the multi-choice buttons — and an already-spent guess
    // stays spent after the opponent comes back
    document.querySelectorAll("#answer-choices .choice-btn").forEach((b) => {
        b.disabled = paused || choiceLockedOut;
    });
    document.getElementById("pulse").classList.toggle("paused", paused);
}

let opponentGraceInterval = null;
let lastQuestionText = "";   // so the paused screen can hand the LIVE question back, not a blank one
let lastQuestionDisplay = "big";   // "big" | "sentence" | "flag" — restored alongside lastQuestionText
let lastQuestionChoices = null;    // the live round's multi-choice options, or null in type mode

const FLAG_BASE = "https://flagcdn.com/";   // e.g. https://flagcdn.com/us.svg — free, no key; swap for a bundled set if ever going fully offline

// the ONE place question text becomes on-screen content, shared by the live
// "question" handler, the reconnect-resume path, AND solo — so a flag renders
// as an image (not the raw "us") everywhere, identically.
function renderPrompt(el, text, display) {
    el.classList.toggle("sentence", display === "sentence");   // smaller size for a full prompt like "capital of Brazil?"
    if (display === "flag") {
        el.textContent = "";
        const img = document.createElement("img");
        img.className = "flag-img";
        img.src = FLAG_BASE + encodeURIComponent(text) + ".svg";   // text is the iso2 code (e.g. "us") — from our own dataset, not user input
        img.alt = "flag";
        // if flagcdn is blocked/unreachable the image would silently show a
        // broken-icon — make that failure loud instead so it's diagnosable
        img.onerror = () => { console.warn("flag image failed to load:", img.src); el.textContent = "🏳 (flag image blocked)"; };
        el.appendChild(img);
    } else {
        el.textContent = text;
    }
}

function renderQuestion(text, display) {
    renderPrompt(document.getElementById("question"), text, display);
}

// the pause takes over the question area itself — hidden pulse/controls, a
// countdown standing in where the question was — rather than a small banner
// next to a question that's misleadingly still sitting there unanswerable
function startOpponentGraceCountdown(totalSeconds) {
    let remaining = Math.round(totalSeconds);
    clearInterval(opponentGraceInterval);
    setMatchPaused(true);
    document.getElementById("pulse").style.display = "none";
    setControlsVisible(false);
    const questionEl = document.getElementById("question");
    questionEl.classList.remove("sentence");   // this overlay's own text is always short, regardless of the live question's style
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
    renderQuestion(lastQuestionText, lastQuestionDisplay);
    document.getElementById("pulse").style.display = "block";
    setControlsVisible(true);
}

let deathmatchInterval = null;

// both sides tied one point from winning — a real 3-2-1-GO before the harder
// decider question lands (see DEATHMATCH_DIFFICULTY_BUMP in main.py). The
// countdown itself is presentation, replaying its shake/glow every tick for
// maximum "oh no" — but the question that follows genuinely takes longer.
function startDeathmatchCountdown(totalSeconds) {
    document.body.classList.add("deathmatch");
    document.getElementById("pulse").style.display = "none";
    setControlsVisible(false);
    const q = document.getElementById("question");
    q.classList.remove("sentence");   // this overlay's own text is always short, regardless of the live question's style
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
    setControlsVisible(false);
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
    setControlsVisible(false);
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
                    lastJoinParams.ops, lastJoinParams.bot, lastJoinParams.category, lastJoinParams.geo,
                    lastJoinParams.answerMode);
    }, RECONNECT_RETRY_MS);
}

// opens (or reopens) the websocket and wires its handlers. Used both for the
// original join AND every reconnect retry — reconnecting must NOT touch the
// screen/pips setup that joinRoom does once below, or a mid-match reconnect
// would look like starting a brand new duel from scratch.
function buildSocket(room, difficulty, target, ops, bot, category, geo, answerMode) {
    let proto = "ws:";
    if (location.protocol === "https:") {
        proto = "wss:";
    }
    leaving = false;
    // difficulty/target/ops/category/geo only matter to whoever CREATES the room —
    // the server stores them once and every later joiner (typed code, invite link)
    // just inherits them. display_name is different: it's per-PLAYER, sent by everyone.
    // bot is like difficulty/target/ops — only meaningful from the creator, on a fresh room.
    let url = proto + "//" + location.host + "/ws/" + room;
    const params = [];
    if (difficulty) { params.push("difficulty=" + difficulty); }
    if (target) { params.push("target=" + target); }
    if (ops) { params.push("ops=" + ops); }
    if (bot) { params.push("bot=" + bot); }
    if (category) { params.push("category=" + category); }
    if (geo) { params.push("geo=" + geo); }
    if (answerMode) { params.push("answer_mode=" + answerMode); }
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
        lastQuestionDisplay = msg.display || "big";
        lastQuestionChoices = msg.choices || null;
        renderQuestion(msg.text, lastQuestionDisplay);
        document.getElementById("pulse").style.display = "block";   // round is live
        document.getElementById("answer").value = "";                 // whatever you were mid-typing belonged to the OLD question
        document.getElementById("answer").classList.remove("wrong", "shake");  // fresh round, clear the last miss
        choiceLockedOut = false;
        renderAnswerUI();
        submissionPending = false;
        clearTimeout(submissionTimer);
        resetSkipState();   // a fresh question means any pending skip vote is stale
    }
    if (msg.type === "locked_out") {
        // the server rejected our guess and spent our one shot for this round
        choiceLockedOut = true;
    }
    if (msg.type === "round_lost") {
        // both players guessed wrong — nobody takes this round. The next
        // "question" is right behind this, so this is just the miss cue.
        flashRound(false);
        playMiss();
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
        setControlsVisible(false);   // nothing left to answer
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
    if (msg.type === "skip_pending") {
        const isMe = msg.name === me;
        if (isMe) {
            setSkipStatus("waiting for " + theirLabel() + "…");
        } else {
            setSkipStatus(theirLabel() + " wants to skip");
            if (!skipRequested) {
                document.getElementById("skip-btn").disabled = false;
            }
        }
    }
    if (msg.type === "skipped") {
        setSkipStatus("skipped!");   // the "question" message right behind this one clears it via resetSkipState()
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
        setControlsVisible(false);
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
        // the ROOM'S real category — not our own local lobby pick — since a
        // joiner inherits whatever the creator actually chose. Text-answer
        // categories need a real keyboard, not the numeric-only one math gets.
        const answerBox = document.getElementById("answer");
        const isTextCategory = msg.category === "geography";
        answerBox.inputMode = isTextCategory ? "text" : "numeric";
        answerBox.classList.toggle("text-answer", isTextCategory);
        isGeoMatch = isTextCategory;   // gates the skip row — read by every setControlsVisible() call from here on
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

function joinRoom(room, difficulty, target, ops, bot, category, geo, answerMode) {
    document.getElementById("lobby-error").classList.remove("show");   // clear any stale error from a previous attempt
    hasJoinedGame = false;
    reconnectDeadline = 0;
    clearTimeout(reconnectTimer);
    lastJoinParams = { room, difficulty, target, ops, bot, category, geo, answerMode };
    buildSocket(room, difficulty, target, ops, bot, category, geo, answerMode);

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

// --- lobby settings: remembered across visits (unlike the session stats
// above). One JSON blob rather than six keys, so a future setting is a field
// here instead of another localStorage entry to migrate. Every default here
// must match the SERVER's own fallback (see the websocket_endpoint defaults
// in main.py) — the two are read independently. ---
const SETTINGS_DEFAULTS = {
    difficulty: "medium",
    target: "5",
    ops: ["add", "sub"],          // multi-select
    category: "math",
    geoModes: ["flag", "capital"], // multi-select
    answerMode: "type",            // geography only: "type" | "choice"
};

const VALID_SETTINGS = {
    difficulty: ["easy", "medium", "hard"],
    target: ["3", "5", "10", "15", "30"],
    ops: ["add", "sub", "mul", "div", "mod"],
    category: ["math", "geography"],
    geoModes: ["flag", "capital"],
    answerMode: ["type", "choice"],
};

// storage is user-editable and survives across deploys, so a saved value can
// name an option that no longer exists — every field is validated back down
// to a default rather than trusted, same "never trust the client" instinct
// the server applies to these exact values
function loadSettings() {
    let saved = {};
    try {
        saved = JSON.parse(localStorage.getItem("duely-settings")) || {};
    } catch (e) {
        saved = {};   // corrupted storage — fall back to defaults rather than crash
    }
    const clean = { ...SETTINGS_DEFAULTS };
    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
        const value = saved[key];
        const allowed = VALID_SETTINGS[key];
        if (Array.isArray(SETTINGS_DEFAULTS[key])) {
            const kept = Array.isArray(value) ? value.filter((v) => allowed.includes(v)) : [];
            if (kept.length) { clean[key] = kept; }   // never restore an empty multi-select — nothing to ask
        } else if (allowed.includes(value)) {
            clean[key] = value;
        }
    }
    return clean;
}

function saveSettings() {
    localStorage.setItem("duely-settings", JSON.stringify({
        difficulty: selectedDifficulty,
        target: selectedTarget,
        ops: selectedOps,
        category: selectedCategory,
        geoModes: selectedGeoModes,
        answerMode: selectedAnswerMode,
    }));
}

const savedSettings = loadSettings();
let selectedDifficulty = savedSettings.difficulty;
let selectedTarget = savedSettings.target;
let selectedOps = savedSettings.ops;
let selectedCategory = savedSettings.category;
let selectedGeoModes = savedSettings.geoModes;
let selectedAnswerMode = savedSettings.answerMode;

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
    const q = SOLO_OPERATIONS[op](difficulty);
    // math answers are numbers, exact-matched; the {display,isText} fields keep
    // solo's question shape uniform with geography's (see soloGenGeoQuestion)
    return { text: q.text, answer: q.answer, display: "big", isText: false };
}

// --- solo geography: the SAME country data the server uses, fetched once from
// /geo-data (see that endpoint) rather than duplicated here — so there's a
// single source of truth. Loaded lazily on entering solo; if it hasn't
// arrived yet (slow/asleep backend), solo quietly falls back to math. ---
let geoData = null;

function loadGeoData() {
    if (geoData) return Promise.resolve(geoData);
    return fetch("/geo-data")
        .then((r) => r.json())
        .then((d) => { geoData = d.countries; return geoData; })
        .catch(() => { geoData = null; return null; });   // offline/asleep — caller falls back to math
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// --- typo tolerance, mirrored from main.py (_edit_distance / _typo_threshold
// / _close_enough). Solo checks answers locally, so the same forgiveness has
// to exist on both sides — keep the thresholds here and there in sync. ---
function editDistance(a, b, cap) {
    if (a === b) return 0;
    let prev2 = null;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = new Array(b.length + 1).fill(0);
        cur[0] = i;
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                              prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                cur[j] = Math.min(cur[j], prev2[j - 2] + 1);   // adjacent-letter swap counts as one edit
            }
        }
        if (Math.min(...cur) > cap) return cap + 1;   // can only grow from here
        prev2 = prev;
        prev = cur;
    }
    return prev[b.length];
}

function typoThreshold(length) {
    if (length <= 4) return 0;   // too short to have any slack ("Chad"/"Chat")
    if (length <= 8) return 1;
    return 2;
}

function closeEnough(guess, accepted) {
    return accepted.some((candidate) => {
        const cap = typoThreshold(candidate.length);
        if (cap === 0) return false;   // exact match was already tried by the caller
        if (Math.abs(guess.length - candidate.length) > cap) return false;
        return editDistance(guess, candidate, cap) <= cap;
    });
}

// mirrors _pick_distractors/_with_choices in main.py: wrong options are other
// countries' real values, so every button is plausible
function soloBuildChoices(correctValue, key) {
    const pool = [...new Set(geoData.map((c) => c[key]))].filter((v) => v !== correctValue);
    const options = [correctValue];
    while (options.length < SOLO_CHOICE_COUNT && pool.length) {
        options.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    for (let i = options.length - 1; i > 0; i--) {   // shuffle, or the answer always sits first
        const j = Math.floor(Math.random() * (i + 1));
        [options[i], options[j]] = [options[j], options[i]];
    }
    return options;
}

const SOLO_CHOICE_COUNT = 4;   // matches CHOICE_COUNT in main.py

function soloGenGeoQuestion(geoModes, answerMode) {
    const modes = geoModes.filter((m) => m === "flag" || m === "capital");
    const mode = pick(modes.length ? modes : ["flag", "capital"]);
    const c = pick(geoData);
    const wantChoices = answerMode === "choice";
    if (mode === "flag") {
        const accepted = [c.name.toLowerCase(), ...c.aliases.map((a) => a.toLowerCase())];
        return { text: c.iso2, answer: accepted, display: "flag", isText: true,
                 choices: wantChoices ? soloBuildChoices(c.name, "name") : null };
    }
    const accepted = [c.capital.toLowerCase(), ...c.capital_aliases.map((a) => a.toLowerCase())];
    return { text: "capital of " + c.name + "?", answer: accepted, display: "sentence", isText: true,
             choices: wantChoices ? soloBuildChoices(c.capital, "capital") : null };
}

// geography if that's what's picked AND the data actually loaded; otherwise math
function soloGenForCategory() {
    if (selectedCategory === "geography" && geoData && geoData.length) {
        return soloGenGeoQuestion(selectedGeoModes, selectedAnswerMode);
    }
    return soloGenQuestion(selectedDifficulty, selectedOps);
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
let soloAnswerIsText = false;   // geography rounds check text, not a parsed Number
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
    if (selectedCategory === "geography") { loadGeoData(); }   // prefetch so it's ready before "start"
    renderSoloBestChip();
    setSoloState("intro");
}

function leaveSolo() {
    stopSoloTimer();
    clearChoiceButtons("solo-answer-choices");
    document.body.classList.remove("playing");
    document.getElementById("solo").style.display = "none";
    document.getElementById("lobby").style.display = "flex";
}

async function startSolo() {
    // geography needs the country data — guarantee it's here before the run so
    // there's no silent fall-back to math on a slow first fetch (the timer only
    // starts after, so the wait never eats into the player's clock)
    if (selectedCategory === "geography") { await loadGeoData(); }
    soloStreak = 0;
    soloTimeBank = SOLO_BASE_TIME;
    setSoloState("play");
    document.getElementById("solo-answer").value = "";
    startSoloTimer();      // ONE continuous clock for the whole run — never reset per question
    soloNextQuestion();
}

function soloNextQuestion() {
    const q = soloGenForCategory();
    soloCorrectAnswer = q.answer;   // a number (math) OR an array of accepted lowercase strings (geo)
    soloAnswerIsText = q.isText;
    renderPrompt(document.getElementById("solo-question"), q.text, q.display);
    document.getElementById("solo-question").classList.remove("flash-you", "flash-them");
    const box = document.getElementById("solo-answer");
    box.classList.remove("wrong", "shake");
    box.inputMode = q.isText ? "text" : "numeric";
    // multi-choice swaps the input row out for buttons, same as multiplayer
    const wantChoices = Array.isArray(q.choices);
    document.getElementById("solo-controls").style.display = wantChoices ? "none" : "flex";
    if (wantChoices) {
        renderChoiceButtons("solo-answer-choices", q.choices, submitSoloChoice);
    } else {
        clearChoiceButtons("solo-answer-choices");
        box.focus();
    }
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

// exact first, then typo-tolerant — but only when typing. A clicked button
// is either exactly right or it isn't, same rule as answer_matches in main.py.
function soloTextMatches(raw) {
    const guess = raw.trim().toLowerCase();
    if (soloCorrectAnswer.includes(guess)) return true;
    return selectedAnswerMode === "type" && closeEnough(guess, soloCorrectAnswer);
}

function soloScoreCorrect() {
    soloStreak += 1;
    soloTimeBank = Math.min(SOLO_MAX_BANK, soloTimeBank + SOLO_BONUS);   // the reward: top up the bank, capped
    playCorrect();
    const q = document.getElementById("solo-question");
    q.classList.remove("flash-you", "flash-them");
    void q.offsetWidth;
    q.classList.add("flash-you");
    setTimeout(soloNextQuestion, 250);   // the clock keeps draining underneath this brief pause — no reset
}

// unlike multiplayer, a wrong tap only burns THAT option — the remaining
// buttons stay live. There's no opponent to be fair to here, so the draining
// clock is the only cost, matching how a mistyped answer costs nothing but time.
function submitSoloChoice(choice, btn) {
    if (soloCorrectAnswer.includes(choice.trim().toLowerCase())) {
        soloScoreCorrect();
    } else {
        btn.disabled = true;
        btn.classList.add("chosen-wrong");
        playMiss();
    }
}

function submitSoloAnswer() {
    const box = document.getElementById("solo-answer");
    if (box.value.trim() === "") return;
    // geography: same exact-then-typo-tolerant check the server does in
    // answer_matches; math: exact numeric equality
    const correct = soloAnswerIsText
        ? soloTextMatches(box.value)
        : Number(box.value) === soloCorrectAnswer;
    box.value = "";
    if (correct) {
        soloScoreCorrect();
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
    clearChoiceButtons("solo-answer-choices");   // #solo-play hides, but its buttons would survive a retry otherwise
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
    joinRoom(mintRoomCode(), selectedDifficulty, selectedTarget, selectedOps.join(","), null,
             selectedCategory, selectedGeoModes.join(","), selectedAnswerMode);
}

// same engine as a real duel — the "opponent" is just a server-simulated
// player (see games[room_code]["bot"] in main.py) that answers on a randomized
// delay. Bot SPEED is tied to the same difficulty dial as the QUESTIONS —
// one control instead of two, at the cost of not being separately tunable.
function createBotDuel() {
    joinRoom(mintRoomCode(), selectedDifficulty, selectedTarget, selectedOps.join(","), selectedDifficulty,
             selectedCategory, selectedGeoModes.join(","), selectedAnswerMode);
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
    clearInviteParam();    // we're back in the lobby — the URL shouldn't still say otherwise
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
    resetSkipState();
    isGeoMatch = false;
    lastQuestionChoices = null;
    choiceLockedOut = false;
    clearChoiceButtons("answer-choices");
    // swap screens back
    document.getElementById("game").style.display = "none";
    document.getElementById("lobby").style.display = "flex";
    document.getElementById("room").focus();
}

function sendAnswer() {
  if (!ws) return;   // no live connection, nothing to send
  const box = document.getElementById("answer");
  if (box.value.trim() === "") return;   // nothing typed, nothing to submit
  // geography answers are words — the server does its own trim/lowercase
  // matching against a set of accepted spellings (see answer_matches in
  // main.py), so the raw text goes over the wire, not a parsed Number
  const isText = box.classList.contains("text-answer");
  const value = isText ? box.value : Number(box.value);
  ws.send(JSON.stringify({ type: "answer", value: value }));
  box.value = "";   // empty the box for the next round
  box.classList.remove("wrong");   // this attempt is fresh; drop any red tint from the last one
  armSubmissionWatch();
}

// multi-choice: one guess per round, so the buttons lock the moment one is
// clicked. The server enforces the same rule (see locked_out in main.py) —
// this is just so the UI says so immediately rather than after a round-trip.
function sendChoiceAnswer(choice, btn) {
  if (!ws || choiceLockedOut) return;
  choiceLockedOut = true;
  lockChoiceButtons("answer-choices", btn);
  ws.send(JSON.stringify({ type: "answer", value: choice }));
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
document.getElementById("skip-btn").onclick = () => {
    if (!ws || skipRequested) return;
    skipRequested = true;
    const skipBtn = document.getElementById("skip-btn");
    skipBtn.disabled = true;
    skipBtn.textContent = "waiting…";
    setSkipStatus("waiting for " + theirLabel() + "…");
    ws.send(JSON.stringify({ type: "skip" }));
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

// --- the pickers. Every one saves on change and is redrawn from the saved
// values on load (see applySettingsToUI) — the .active classes in index.html
// are only the first-visit defaults, never the source of truth. ---

// single-select: exactly one chip in the group carries .active
function markSingleSelect(selector, isActive) {
    document.querySelectorAll(selector).forEach((b) => {
        const active = isActive(b);
        b.classList.toggle("active", active);
        b.setAttribute("aria-checked", active ? "true" : "false");
    });
}

// multi-select: each chip stands alone, so .active is per-button membership
function markMultiSelect(selector, datasetKey, chosen) {
    document.querySelectorAll(selector).forEach((b) => {
        const active = chosen.includes(b.dataset[datasetKey]);
        b.classList.toggle("active", active);
        b.setAttribute("aria-checked", active ? "true" : "false");
    });
}

// math and geography need different sub-pickers, so half the card swaps out
function applyCategoryVisibility() {
    const isGeo = selectedCategory === "geography";
    document.getElementById("ops-group").style.display = isGeo ? "none" : "flex";
    document.getElementById("geo-modes-group").style.display = isGeo ? "flex" : "none";
    // geography ignores difficulty entirely — its tiers meant country
    // obscurity, but that's a confusing knob for a casual quiz, so the
    // whole row is hidden and the server draws from all countries (see
    // the mixed-tier note in gen_geo_question / _countries_for_tier)
    document.getElementById("difficulty-group").style.display = isGeo ? "none" : "flex";
    // type-vs-multi-choice is meaningless for math — a number has no spelling
    document.getElementById("answer-mode-group").style.display = isGeo ? "flex" : "none";
}

// redraw every picker from the restored values. Without this the chips would
// keep index.html's hardcoded defaults highlighted while the variables behind
// them said something else — the settings would work but LOOK unsaved.
function applySettingsToUI() {
    markSingleSelect(".diff-opt", (b) => b.dataset.difficulty === selectedDifficulty);
    markSingleSelect(".target-opt", (b) => b.dataset.target === selectedTarget);
    markSingleSelect(".cat-opt", (b) => b.dataset.category === selectedCategory);
    markSingleSelect(".answer-mode-opt", (b) => b.dataset.answerMode === selectedAnswerMode);
    markMultiSelect(".op-opt", "op", selectedOps);
    markMultiSelect(".geo-opt", "geo", selectedGeoModes);
    applyCategoryVisibility();
}

document.querySelectorAll(".diff-opt").forEach((btn) => {
    btn.onclick = () => {
        selectedDifficulty = btn.dataset.difficulty;
        markSingleSelect(".diff-opt", (b) => b === btn);
        saveSettings();
    };
});

document.querySelectorAll(".target-opt").forEach((btn) => {
    btn.onclick = () => {
        selectedTarget = btn.dataset.target;
        markSingleSelect(".target-opt", (b) => b === btn);
        saveSettings();
    };
});

// single-select: which QUESTION SET this match draws from. Toggles which of
// the two mutually-exclusive sub-pickers below (operations vs geo modes) is
// relevant — math's operators mean nothing for a flag/capital question.
document.querySelectorAll(".cat-opt").forEach((btn) => {
    btn.onclick = () => {
        selectedCategory = btn.dataset.category;
        markSingleSelect(".cat-opt", (b) => b === btn);
        applyCategoryVisibility();
        saveSettings();
    };
});

// single-select: how geography answers get given. "type" keeps the text box
// (with typo tolerance); "choice" swaps it for four buttons.
document.querySelectorAll(".answer-mode-opt").forEach((btn) => {
    btn.onclick = () => {
        selectedAnswerMode = btn.dataset.answerMode;
        markSingleSelect(".answer-mode-opt", (b) => b === btn);
        saveSettings();
    };
});

// multi-select: same "at least one stays on" rule as operations above
document.querySelectorAll(".geo-opt").forEach((btn) => {
    btn.onclick = () => {
        const mode = btn.dataset.geo;
        const isActive = btn.classList.contains("active");
        if (isActive && selectedGeoModes.length === 1) { return; }
        if (isActive) {
            selectedGeoModes = selectedGeoModes.filter((m) => m !== mode);
        } else {
            selectedGeoModes.push(mode);
        }
        btn.classList.toggle("active", !isActive);
        btn.setAttribute("aria-checked", (!isActive).toString());
        saveSettings();
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
        saveSettings();
    };
});

applySettingsToUI();   // restore whatever was remembered, before anything is clicked
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

// type="number" inputs still accept e/E (scientific notation, 1e5), sign
// characters, and the decimal point — but every MATH answer in this game is
// a non-negative integer, so none of those are ever part of a valid answer.
// Solo is always math, so its guard is unconditional; #answer's own is gated
// on the "text-answer" class (see the "welcome" handler) since a geography
// answer is a real word that may legitimately contain any of those letters.
document.getElementById("answer").addEventListener("keydown", (e) => {
    if (document.getElementById("answer").classList.contains("text-answer")) { return; }
    if (["e", "E", "+", "-", "."].includes(e.key)) { e.preventDefault(); }
});
document.getElementById("solo-answer").addEventListener("keydown", (e) => {
    if (soloAnswerIsText) { return; }   // a geography answer is a word — those chars are legit
    if (["e", "E", "+", "-", "."].includes(e.key)) { e.preventDefault(); }
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

// Once you're back in the lobby the "?room=" in the address bar is a lie: a
// refresh (or a bookmark, or that URL pasted anywhere) would auto-rejoin the
// room you just left. replaceState rather than pushState — the stale invite
// URL shouldn't become a back-button destination either.
function clearInviteParam() {
    if (!new URLSearchParams(location.search).has("room")) { return; }
    history.replaceState(null, "", location.pathname);
}

// invite links: /?room=XNDS joins straight into the room, no lobby
const inviteRoom = new URLSearchParams(location.search).get("room");
if (inviteRoom) {
    joinRoom(inviteRoom.trim().toUpperCase());
}

let rematchRequested = false;
let skipRequested = false;

function setSkipStatus(text) {
    document.getElementById("skip-status").textContent = text || "";
}

// --- multi-choice answering: the four buttons replace #controls entirely for
// the round. Built from the server's `choices` list every question, never
// reused, so a stale option can't survive into the next round. ---
let choiceLockedOut = false;   // true once this round's single guess is spent

// shared by multiplayer and solo — same markup, different submit callback
function renderChoiceButtons(containerId, choices, onPick) {
    const box = document.getElementById(containerId);
    box.innerHTML = "";
    choices.forEach((choice) => {
        const btn = document.createElement("button");
        btn.className = "choice-btn";
        btn.type = "button";
        btn.textContent = choice;   // textContent, not innerHTML — never inject question data as markup
        btn.onclick = () => onPick(choice, btn);
        box.appendChild(btn);
    });
    box.style.display = "grid";
}

function clearChoiceButtons(containerId) {
    const box = document.getElementById(containerId);
    box.innerHTML = "";
    box.style.display = "none";
}

// one guess per round: grey everything, and mark the one they actually picked
function lockChoiceButtons(containerId, pickedBtn) {
    document.querySelectorAll("#" + containerId + " .choice-btn").forEach((b) => {
        b.disabled = true;
    });
    if (pickedBtn) { pickedBtn.classList.add("chosen-wrong"); }
}

// mirrors clearPostgameState()'s job, but for the live-round skip vote —
// called whenever a new question makes any prior vote stale
function resetSkipState() {
    skipRequested = false;
    const skipBtn = document.getElementById("skip-btn");
    skipBtn.disabled = false;
    skipBtn.textContent = "idk, skip ▸";
    setSkipStatus("");
}

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
