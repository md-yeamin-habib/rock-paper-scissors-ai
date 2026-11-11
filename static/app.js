// Establish Socket.IO connection to the backend server
const socket = io();

// UI State tracking variables
let selectedGameMode = 'computer';
let selectedRoundMode = '3';
let waitingTimerInterval = null;
let currentAnimationInterval = null;
let activeTimerInterval = null;

// Room and Role state for matches
let currentRoom = null;
let currentRole = 'p1';
let isAnimating = false;

// Round history tracking for score pills
let roundHistory = [];

// ==========================================
// IMAGE PRELOADER ENGINE
// ==========================================
function preloadAllAssets() {
    const actors = ['player', 'opponent'];
    const actions = ['idle', 'rock', 'paper', 'scissor'];
    
    actors.forEach(actor => {
        actions.forEach(action => {
            const totalFrames = (action === 'idle') ? 15 : 41;
            for (let i = 0; i < totalFrames; i++) {
                const frameStr = String(i).padStart(2, '0');
                const imgPath = `/static/assets/${actor}/${action}/${frameStr}.png`;
                const img = new Image();
                img.src = imgPath;
            }
        });
    });
}

document.addEventListener('DOMContentLoaded', () => {
    // Preload all assets immediately on load
    preloadAllAssets();

    // 1. Handle Game Mode selection buttons
    const modeButtons = document.querySelectorAll('.game-mode-btn');
    modeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            modeButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            selectedGameMode = btn.getAttribute('data-mode');
        });
    });

    // 2. Handle Round Mode selection buttons
    const roundButtons = document.querySelectorAll('.round-btn');
    roundButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            roundButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            selectedRoundMode = btn.getAttribute('data-rounds');
        });
    });

    // 3. Handle Start Game Button click
    const startBtn = document.getElementById('start-game-btn');
    startBtn.addEventListener('click', () => {
        if (selectedGameMode === 'pvp') {
            showWaitingModal();
        } else {
            socket.emit('join_game', {
                gameMode: selectedGameMode,
                roundMode: selectedRoundMode
            });
        }
    });

    // 4. Handle Cancel Waiting Button in PvP Modal
    const cancelWaitingBtn = document.getElementById('cancel-waiting-btn');
    cancelWaitingBtn.addEventListener('click', () => {
        hideWaitingModal();
        window.location.reload();
    });

    // 5. Handle Quit Button & Confirmation Modal
    const quitBtn = document.getElementById('quit-btn');
    const quitModal = document.getElementById('quit-modal');
    const confirmQuitBtn = document.getElementById('confirm-quit-btn');
    const cancelQuitBtn = document.getElementById('cancel-quit-btn');

    quitBtn.addEventListener('click', () => {
        quitModal.classList.remove('hidden');
    });

    cancelQuitBtn.addEventListener('click', () => {
        quitModal.classList.add('hidden');
    });

    confirmQuitBtn.addEventListener('click', () => {
        quitModal.classList.add('hidden');
        if (currentRoom) {
            socket.emit('quit_game', { room: currentRoom });
        } else {
            showMatchOverModal({ p1_wins: 0, p2_wins: 0, draws: 0, reason: 'quit' });
        }
    });

    // 6. Handle Scorecard Buttons (Play Again & Home)
    const scorecardRestartBtn = document.getElementById('scorecard-restart-btn');
    if (scorecardRestartBtn) {
        scorecardRestartBtn.addEventListener('click', () => {
            const matchOverModal = document.getElementById('match-over-modal');
            if (matchOverModal) matchOverModal.classList.add('hidden');
            
            if (selectedGameMode === 'pvp') {
                showWaitingModal();
            } else {
                socket.emit('join_game', {
                    gameMode: selectedGameMode,
                    roundMode: selectedRoundMode
                });
            }
        });
    }

    const scorecardHomeBtn = document.getElementById('scorecard-home-btn');
    if (scorecardHomeBtn) {
        scorecardHomeBtn.addEventListener('click', () => {
            window.location.reload();
        });
    }

    // 7. Handle Move Buttons Selection
    const moveButtons = document.querySelectorAll('.move-btn');
    moveButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            if (isAnimating) return;
            const move = btn.getAttribute('data-move');
            if (currentRoom) {
                stopAllTimers();
                setMoveButtonsEnabled(false);
                
                // If we make a move first in PvP, start 10s timer on opponent's HUD (top-right)
                if (selectedGameMode === 'pvp') {
                    startOpponentHudTimer(10);
                }

                socket.emit('submit_move', {
                    room: currentRoom,
                    playerId: currentRole,
                    move: move
                });
            }
        });
    });
});

// ==========================================
// SOCKET.IO EVENT LISTENERS FOR MATCHMAKING & ROUNDS
// ==========================================

socket.on('waiting_for_opponent', (data) => {
    let timeLeft = data.duration || 120;
    const countdownEl = document.getElementById('countdown-val');
    countdownEl.textContent = timeLeft;

    if (waitingTimerInterval) clearInterval(waitingTimerInterval);

    waitingTimerInterval = setInterval(() => {
        timeLeft--;
        countdownEl.textContent = timeLeft;
        if (timeLeft <= 0) {
            clearInterval(waitingTimerInterval);
        }
    }, 1000);
});

socket.on('matchmaking_failed', (data) => {
    hideWaitingModal();
    alert(data.message || 'Failed to find another player.');
});

socket.on('game_joined', (data) => {
    if (waitingTimerInterval) clearInterval(waitingTimerInterval);
    hideWaitingModal();

    currentRoom = data.room;
    currentRole = data.role;

    console.log("Successfully joined game room:", currentRoom, "Role:", currentRole);
    transitionToGameScreen(data);
});

// Triggered when opponent makes a move first in PvP -> timer starts on OUR HUD (bottom-left)
socket.on('opponent_moved', (data) => {
    if (selectedGameMode === 'pvp') {
        startMyHudTimer(10, () => {
            // Auto-submit fallback move on timeout
            const moves = ['rock', 'paper', 'scissor'];
            const randomMove = moves[Math.floor(Math.random() * moves.length)];
            stopAllTimers();
            setMoveButtonsEnabled(false);
            socket.emit('submit_move', {
                room: currentRoom,
                playerId: currentRole,
                move: randomMove
            });
        });
    }
});

socket.on('resolve_round', (data) => {
    stopAllTimers();
    handleRoundResolution(data);
});

socket.on('show_scorecard', (data) => {
    stopAllTimers();
    showMatchOverModal(data);
});

// ==========================================
// ANIMATION ENGINE & HELPERS (20 FPS)
// ==========================================

function loadAssetSequence(actor, action, totalFrames) {
    const frames = [];
    for (let i = 0; i < totalFrames; i++) {
        const frameStr = String(i).padStart(2, '0');
        frames.push(`/static/assets/${actor}/${action}/${frameStr}.png`);
    }
    return frames;
}

function startIdleAnimations() {
    isAnimating = false;
    const playerFrames = loadAssetSequence('player', 'idle', 15);
    const opponentFrames = loadAssetSequence('opponent', 'idle', 15);

    const playerImg = document.getElementById('player-hand-img');
    const opponentImg = document.getElementById('opponent-hand-img');

    if (playerImg && opponentImg) {
        let idx = 0;
        if (currentAnimationInterval) clearInterval(currentAnimationInterval);
        currentAnimationInterval = setInterval(() => {
            playerImg.src = playerFrames[idx];
            opponentImg.src = opponentFrames[idx];
            idx = (idx + 1) % playerFrames.length;
        }, 65);
    }
}

// ==========================================
// GAME SCREEN INITIALIZATION & ROUND FLOW
// ==========================================

function transitionToGameScreen(data) {
    const matchModal = document.getElementById('match-over-modal');
    if (matchModal) matchModal.classList.add('hidden');

    document.getElementById('home-screen').classList.remove('active');
    document.getElementById('game-screen').classList.add('active');

    const playerNameEl = document.getElementById('player-name');
    const opponentNameEl = document.getElementById('opponent-name');
    const playerRug = document.querySelector('.player-sprite-box .floor-rug');
    const opponentRug = document.querySelector('.opponent-sprite-box .floor-rug');

    // Bottom HUD is ALWAYS You (local player), Top HUD is ALWAYS Opponent
    if (selectedGameMode === 'computer' || selectedGameMode === 'adaptive_ai') {
        playerNameEl.textContent = 'Player 1 (You)';
        if (playerRug) playerRug.className = 'floor-rug red-rug';

        opponentNameEl.textContent = (selectedGameMode === 'computer') ? 'Computer' : 'Adaptive AI';
        if (opponentRug) opponentRug.className = 'floor-rug blue-rug';
    } else if (selectedGameMode === 'pvp') {
        if (currentRole === 'p1') {
            playerNameEl.textContent = 'Player 1 (You)';
            if (playerRug) playerRug.className = 'floor-rug red-rug';
            opponentNameEl.textContent = 'Player 2';
            if (opponentRug) opponentRug.className = 'floor-rug blue-rug';
        } else {
            playerNameEl.textContent = 'Player 2 (You)';
            if (playerRug) playerRug.className = 'floor-rug blue-rug';
            opponentNameEl.textContent = 'Player 1';
            if (opponentRug) opponentRug.className = 'floor-rug red-rug';
        }
    }

    roundHistory = [];
    initializeScoreTrackers();
    startIdleAnimations();
    setMoveButtonsEnabled(true);
}

// Timer on OUR HUD (bottom-left) when opponent moves first
function startMyHudTimer(duration = 10, onTimeout = null) {
    stopAllTimers();
    let timeLeft = duration;
    
    const timerValEl = document.getElementById('player-timer-val');
    const timerPathEl = document.getElementById('player-timer-path');
    const timerContainer = document.getElementById('player-timer');
    
    if (timerContainer) timerContainer.classList.remove('hidden');

    activeTimerInterval = setInterval(() => {
        if (timerValEl) timerValEl.textContent = timeLeft;
        if (timerPathEl) {
            const percentage = (timeLeft / duration) * 100;
            timerPathEl.style.strokeDasharray = `${percentage}, 100`;
        }

        if (timeLeft <= 0) {
            stopAllTimers();
            if (typeof onTimeout === 'function') onTimeout();
        }
        timeLeft--;
    }, 1000);
}

// Timer on OPPONENT HUD (top-right) when we move first
function startOpponentHudTimer(duration = 10) {
    stopAllTimers();
    let timeLeft = duration;
    
    const timerValEl = document.getElementById('opponent-timer-val');
    const timerPathEl = document.getElementById('opponent-timer-path');
    const timerContainer = document.getElementById('opponent-timer');
    
    if (timerContainer) timerContainer.classList.remove('hidden');

    activeTimerInterval = setInterval(() => {
        if (timerValEl) timerValEl.textContent = timeLeft;
        if (timerPathEl) {
            const percentage = (timeLeft / duration) * 100;
            timerPathEl.style.strokeDasharray = `${percentage}, 100`;
        }

        if (timeLeft <= 0) {
            stopAllTimers();
        }
        timeLeft--;
    }, 1000);
}

function stopAllTimers() {
    if (activeTimerInterval) {
        clearInterval(activeTimerInterval);
        activeTimerInterval = null;
    }
    const playerTimer = document.getElementById('player-timer');
    const opponentTimer = document.getElementById('opponent-timer');
    if (playerTimer) playerTimer.classList.add('hidden');
    if (opponentTimer) opponentTimer.classList.add('hidden');
}

function initializeScoreTrackers() {
    const playerTrack = document.getElementById('player-score-track');
    const opponentTrack = document.getElementById('opponent-score-track');
    
    if (!playerTrack || !opponentTrack) return;

    playerTrack.innerHTML = '';
    opponentTrack.innerHTML = '';

    let totalPills = (selectedRoundMode === '999') ? 10 : parseInt(selectedRoundMode);

    for (let i = 0; i < totalPills; i++) {
        const pill = document.createElement('div');
        pill.className = 'score-pill';
        playerTrack.appendChild(pill);

        const oppPill = document.createElement('div');
        oppPill.className = 'score-pill';
        opponentTrack.appendChild(oppPill);
    }
}

function setMoveButtonsEnabled(enabled) {
    const moveButtons = document.querySelectorAll('.move-btn');
    moveButtons.forEach(btn => {
        btn.disabled = !enabled;
    });
}

function handleRoundResolution(data) {
    isAnimating = true;
    if (currentAnimationInterval) clearInterval(currentAnimationInterval);

    let playerMove, opponentMove;
    if (currentRole === 'p1') {
        playerMove = data.p1_move;
        opponentMove = data.p2_move;
    } else {
        playerMove = data.p2_move;
        opponentMove = data.p1_move;
    }

    const playerFrames = loadAssetSequence('player', playerMove, 41);
    const opponentFrames = loadAssetSequence('opponent', opponentMove, 41);

    const playerImg = document.getElementById('player-hand-img');
    const opponentImg = document.getElementById('opponent-hand-img');

    let frameIndex = 0;
    currentAnimationInterval = setInterval(() => {
        if (playerImg) playerImg.src = playerFrames[frameIndex];
        if (opponentImg) opponentImg.src = opponentFrames[frameIndex];
        frameIndex++;

        if (frameIndex >= playerFrames.length) {
            clearInterval(currentAnimationInterval);
            onBattleAnimationComplete(data);
        }
    }, 50);
}

function onBattleAnimationComplete(data) {
    updateScoreTrackers(data.outcome);
    triggerWinnerGlow(data.outcome);

    if (data.isGameOver) {
        setTimeout(() => {
            showMatchOverModal({
                p1_wins: data.scores.p1_wins,
                p2_wins: data.scores.p2_wins,
                draws: data.scores.draws,
                reason: 'complete'
            });
        }, 1200);
    } else {
        setTimeout(() => {
            startIdleAnimations();
            setMoveButtonsEnabled(true);
        }, 1000);
    }
}

function updateScoreTrackers(outcome) {
    let playerResult = 'draw';
    let opponentResult = 'draw';

    if (outcome === 'p1_win') {
        playerResult = (currentRole === 'p1') ? 'win' : 'loss';
        opponentResult = (currentRole === 'p1') ? 'loss' : 'win';
    } else if (outcome === 'p2_win') {
        playerResult = (currentRole === 'p2') ? 'win' : 'loss';
        opponentResult = (currentRole === 'p2') ? 'loss' : 'win';
    }

    roundHistory.push({ player: playerResult, opponent: opponentResult });

    const playerTrack = document.getElementById('player-score-track');
    const opponentTrack = document.getElementById('opponent-score-track');
    if (!playerTrack || !opponentTrack) return;

    const maxVisible = (selectedRoundMode === '999') ? 10 : parseInt(selectedRoundMode);
    
    let renderHistory = [...roundHistory];
    if (selectedRoundMode === '999' && renderHistory.length > maxVisible) {
        renderHistory = renderHistory.slice(renderHistory.length - maxVisible);
    }

    playerTrack.innerHTML = '';
    opponentTrack.innerHTML = '';

    renderHistory.forEach(h => {
        const pPill = document.createElement('div');
        pPill.className = `score-pill ${h.player}`;
        playerTrack.appendChild(pPill);

        const oPill = document.createElement('div');
        oPill.className = `score-pill ${h.opponent}`;
        opponentTrack.appendChild(oPill);
    });

    const blanksNeeded = maxVisible - renderHistory.length;
    for (let i = 0; i < blanksNeeded; i++) {
        const pPill = document.createElement('div');
        pPill.className = 'score-pill';
        playerTrack.appendChild(pPill);

        const oPill = document.createElement('div');
        oPill.className = 'score-pill';
        opponentTrack.appendChild(oPill);
    }
}

function triggerWinnerGlow(outcome) {
    let winningHudSelector = null;

    if (outcome === 'p1_win') {
        winningHudSelector = (currentRole === 'p1') ? '.player-hud .hud-box' : '.opponent-hud .hud-box';
    } else if (outcome === 'p2_win') {
        winningHudSelector = (currentRole === 'p2') ? '.player-hud .hud-box' : '.opponent-hud .hud-box';
    }

    if (winningHudSelector) {
        const hudBox = document.querySelector(winningHudSelector);
        if (hudBox) {
            hudBox.classList.add('winner-glow');
            setTimeout(() => {
                hudBox.classList.remove('winner-glow');
            }, 1000);
        }
    }
}

// ==========================================
// MODAL & SCORECARD HELPER FUNCTIONS
// ==========================================

function showWaitingModal() {
    const modal = document.getElementById('waiting-modal');
    modal.classList.remove('hidden');

    socket.emit('join_game', {
        gameMode: selectedGameMode,
        roundMode: selectedRoundMode
    });
}

function hideWaitingModal() {
    const modal = document.getElementById('waiting-modal');
    if (modal) modal.classList.add('hidden');
    if (waitingTimerInterval) clearInterval(waitingTimerInterval);
}

function showMatchOverModal(data) {
    const modal = document.getElementById('match-over-modal');
    if (!modal) return;

    const p1Wins = data.p1_wins || 0;
    const p2Wins = data.p2_wins || 0;
    const draws = data.draws || 0;

    const p1Losses = p2Wins;
    const p2Losses = p1Wins;

    // Table Mapping: Row 1 is ALWAYS Player 1, Row 2 is ALWAYS Player 2 (or AI/Computer)
    const isP1 = (currentRole === 'p1');
    const row1Label = (selectedGameMode === 'pvp') 
        ? (isP1 ? 'Player 1 (You)' : 'Player 1') 
        : 'Player 1 (You)';
    
    const opponentNameText = document.getElementById('opponent-name').textContent;
    const row2Label = (selectedGameMode === 'pvp')
        ? (!isP1 ? 'Player 2 (You)' : 'Player 2')
        : opponentNameText;

    document.getElementById('sc-row1-label').textContent = row1Label;
    document.getElementById('sc-row1-wins').textContent = p1Wins;
    document.getElementById('sc-row1-draws').textContent = draws;
    document.getElementById('sc-row1-losses').textContent = p1Losses;

    document.getElementById('sc-row2-label').textContent = row2Label;
    document.getElementById('sc-row2-wins').textContent = p2Wins;
    document.getElementById('sc-row2-draws').textContent = draws;
    document.getElementById('sc-row2-losses').textContent = p2Losses;

    const winnerBanner = document.getElementById('scorecard-winner-banner');
    const isEarlyQuit = (data.reason === 'quit' || data.reason === 'disconnect');
    
    if (isEarlyQuit && selectedRoundMode !== '999') {
        winnerBanner.textContent = 'Match Terminated';
    } else {
        if (p1Wins > p2Wins) {
            winnerBanner.textContent = (currentRole === 'p1') ? 'You Won The Match!' : `${row1Label.replace(' (You)', '')} Wins!`;
        } else if (p2Wins > p1Wins) {
            winnerBanner.textContent = (currentRole === 'p2') ? 'You Won The Match!' : `${row2Label.replace(' (You)', '')} Wins!`;
        } else {
            winnerBanner.textContent = 'Match Ended in a Draw!';
        }
    }

    modal.classList.remove('hidden');
}
