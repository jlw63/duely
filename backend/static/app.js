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
const SOLO_BASE_TIME = 13;    // starting bank
const SOLO_BONUS = 3;         // added to the bank per correct answer
const SOLO_MAX_BANK = 13;     // hard cap — the bar's "full" reading

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
    stopSoloTimer();   // clear any previous loop before starting a fresh one
    soloTimerHandle = requestAnimationFrame(soloTick);
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

document.getElementById("solo-link").onclick = enterSolo;
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
