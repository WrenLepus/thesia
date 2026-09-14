// server.js
// Node/Express + Socket.IO backend for Thesia's multiplayer game mode.

// ------------------------------------------------------------------
// 1. Load libraries
// ------------------------------------------------------------------
const express = require('express');      // Web framework for serving static files
const http = require('http');            // Built-in HTTP server
const path = require('path');            // Cross-platform file paths
const { Server } = require('socket.io'); // Real-time WebSocket communication
const CLASSICAL_SONGS = require('./music-pieces');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['https://wrenlepus.github.io', 'http://localhost:3000', 'http://localhost:3001'],
    methods: ['GET', 'POST']
  }
});

// ------------------------------------------------------------------
// 2. Serve static files (index.html, script.js, style.css, assets...)
// ------------------------------------------------------------------
app.use(express.static(path.join(__dirname)));

// ------------------------------------------------------------------
// 3. Game data
// ------------------------------------------------------------------
// How long each vote lasts, in seconds.
const CHOICE_DURATION = 5;

// How long the winning customization card is shown, in seconds.
const RESULT_DISPLAY_TIME = 2;

// How long each charades turn lasts, in seconds.
const TURN_DURATION = parseInt(process.env.THESIA_TURN_DURATION, 10) || 60;

// How long into the turn before the Play button is enabled, in seconds.
const PLAY_UNLOCK_TIME = parseInt(process.env.THESIA_PLAY_UNLOCK_TIME, 10) || 30;

// How long the revealed answer lingers before the next turn starts, in seconds.
const REVEAL_LINGER_TIME = parseInt(process.env.THESIA_REVEAL_LINGER_TIME, 10) || 5;

// Charades stays readable and the score panel usable with up to ten players.
const MAX_PLAYERS = 10;

// Maximum score for a correct guess and how many points are lost per second.
const MAX_GUESS_SCORE = 500;
const SCORE_LOSS_PER_SECOND = 10;
const FULL_SCORE_WINDOW = 10;

// Drawing mode options.
const MODES = ['Draw', 'ASCII'];

// Round-limit options.
const ROUND_OPTIONS = ['3 rounds', 'Unlimited'];

// ------------------------------------------------------------------
// 4. Helpers
// ------------------------------------------------------------------
function makeRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

// Fisher-Yates shuffle: puts an array in random order without repeats.
function shuffle(array) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Picks the winning option. If multiple options tie (including all zero), one is chosen at random.
function pickWinner(votes) {
  const maxVotes = Math.max(...votes);
  const tiedIndexes = votes.map((v, i) => v === maxVotes ? i : -1).filter(i => i !== -1);
  return tiedIndexes[Math.floor(Math.random() * tiedIndexes.length)];
}

// Active (non-kicked) players in a room.
function activePlayers(room) {
  return room.players.filter(p => !p.kicked);
}

function publicPlayers(room) {
  return activePlayers(room).map(player => ({
    id: player.id,
    name: player.name,
    score: room.scores?.[player.id] || 0
  }));
}

// Remove a player from a room and keep the rotating drawer index pointing at
// the correct next player. Returns { removed, wasDrawer }.
function removePlayer(room, playerId) {
  const index = room.players.findIndex(p => p.id === playerId);
  if (index === -1) return { removed: false, wasDrawer: false };

  const wasDrawer = room.currentDrawerId === playerId;
  const wasBeforeDrawer = index < room.currentDrawerIndex;

  room.players.splice(index, 1);

  if (wasDrawer) {
    // The next turn should start with whoever now occupies the removed slot,
    // wrapping to the front when the last player left. endTurn() will then
    // advance from this value to that player.
    room.currentDrawerIndex = (index - 1 + room.players.length) % room.players.length;
  } else if (wasBeforeDrawer) {
    room.currentDrawerIndex--;
  }

  return { removed: true, wasDrawer };
}

function normalizeGuess(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function titleFromPrompt(prompt) {
  const separatorIndex = String(prompt).lastIndexOf(' - ');
  return (separatorIndex === -1 ? prompt : prompt.slice(0, separatorIndex)).trim();
}

function scoreForCorrectGuess(elapsedMilliseconds) {
  const elapsedSeconds = Math.max(0, elapsedMilliseconds / 1000);
  if (elapsedSeconds <= FULL_SCORE_WINDOW) return MAX_GUESS_SCORE;

  // The first instant after the 10-second full-score window is in the first
  // deduction second, so it is worth 490; each subsequent second loses 10.
  const deductionSeconds = Math.ceil(elapsedSeconds - FULL_SCORE_WINDOW);
  return Math.max(0, MAX_GUESS_SCORE - deductionSeconds * SCORE_LOSS_PER_SECOND);
}

// ------------------------------------------------------------------
// 5. In-memory room storage
// ------------------------------------------------------------------
const rooms = {};

// ------------------------------------------------------------------
// 6. Voting / customization logic
// ------------------------------------------------------------------
function startChoice(room, type) {
  // Decide the list of options for this round.
  let options;
  if (type === 'mode') options = MODES.slice();
  else if (type === 'rounds') options = ROUND_OPTIONS.slice();
  else return;

  room.phase = 'customize';
  room.currentChoice = {
    type,
    options,
    votes: new Array(options.length).fill(0),
    voterIds: new Set()
  };

  // Tell everyone in the room a new vote has started.
  io.to(room.code).emit('choice-started', {
    type,
    options,
    duration: CHOICE_DURATION
  });

  // Automatically end the vote after the duration.
  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => finalizeChoice(room), CHOICE_DURATION * 1000);
}

function finalizeChoice(room) {
  if (!room.currentChoice) return;
  if (room.timer) clearTimeout(room.timer);

  const winnerIndex = pickWinner(room.currentChoice.votes);
  const winner = room.currentChoice.options[winnerIndex];

  // Save the result.
  room.choices[room.currentChoice.type] = winner;

  // Show everyone the winning card for a short moment.
  io.to(room.code).emit('choice-result', {
    type: room.currentChoice.type,
    winner,
    votes: room.currentChoice.votes
  });

  room.currentChoice = null;

  // Then move on to the next choice, or start the game if all done.
  setTimeout(() => advanceCustomization(room), RESULT_DISPLAY_TIME * 1000);
}

function advanceCustomization(room) {
  if (!room.choices.mode) {
    startChoice(room, 'mode');
  } else if (!room.choices.rounds) {
    startChoice(room, 'rounds');
  } else {
    // All customization choices made; start playing.
    startGame(room);
  }
}

// ------------------------------------------------------------------
// 7. Gameplay logic
// ------------------------------------------------------------------
function startGame(room) {
  // Convert the rounds label into a number or null for unlimited.
  room.choices.totalRounds = room.choices.rounds === '3 rounds' ? 3 : null;

  room.phase = 'playing';
  room.strokes = [];
  room.asciiText = '';
  room.drawCounts = {};
  room.scores = {};
  room.currentPrompt = null;
  room.promptQueue = [];
  room.turnStartTime = null;
  room.turnResolved = false;

  const players = activePlayers(room);
  if (players.length < 2) {
    room.phase = 'waiting';
    io.to(room.hostId).emit('room-error', 'Need at least 2 players to start');
    return;
  }
  // Pick a random starting drawer; after that we rotate through the list.
  room.currentDrawerIndex = players.length ? Math.floor(Math.random() * players.length) : 0;
  room.finishVotes = new Set();

  io.to(room.code).emit('customize-done', {
    choices: room.choices
  });

  startTurn(room);
}

function startTurn(room) {
  const players = activePlayers(room);
  if (players.length === 0) return;

  // Compute the round number from total completed turns.
  const totalDrawsBefore = Object.values(room.drawCounts).reduce((a, b) => a + b, 0);
  room.currentRound = Math.floor(totalDrawsBefore / players.length) + 1;

  // Pick the next Classical prompt, avoiding immediate repeats within a room.
  if (!room.promptQueue || room.promptQueue.length === 0) {
    room.promptQueue = shuffle(CLASSICAL_SONGS);
    // If possible, don't put the just-used prompt at the front of the new queue.
    if (room.currentPrompt && room.promptQueue.length > 1 && room.promptQueue[0] === room.currentPrompt) {
      const swapIdx = 1 + Math.floor(Math.random() * (room.promptQueue.length - 1));
      [room.promptQueue[0], room.promptQueue[swapIdx]] = [room.promptQueue[swapIdx], room.promptQueue[0]];
    }
  }
  room.currentPrompt = room.promptQueue.pop();

  // Assign the drawer in rotating order.
  const drawer = players[room.currentDrawerIndex % players.length];
  room.currentDrawerId = drawer.id;
  room.drawCounts[drawer.id] = (room.drawCounts[drawer.id] || 0) + 1;

  const drawCountLeft = room.choices.totalRounds
    ? room.choices.totalRounds - room.drawCounts[drawer.id]
    : null;

  // Clear the shared canvas for the new turn.
  room.strokes = [];
  room.asciiText = '';
  io.to(room.code).emit('state-update', { strokes: [], asciiText: '' });

  // Extract just the song title for guessing (composer is not required).
  const title = titleFromPrompt(room.currentPrompt);
  room.currentAnswerTitle = title;
  room.turnStartTime = Date.now();
  room.turnResolved = false;
  room.correctGuessers = new Set();

  // Build a hangman-style blank pattern: one string per word so the client
  // can render larger gaps between words and wrap long titles onto two lines.
  const titleWords = title.split(/\s+/).filter(w => w.length > 0);
  const blankWords = titleWords.map(word => word.split('').map(() => '_').join(' '));
  const blanks = blankWords.join('     ');

  // Public turn announcement (answer omitted; guessers see blanks).
  io.to(room.code).emit('turn-started', {
    drawerId: drawer.id,
    drawerName: drawer.name || 'Player',
    round: room.currentRound,
    totalRounds: room.choices.totalRounds || null,
    drawCountLeft,
    blanks,
    blankWords,
    answerLength: title.length,
    duration: TURN_DURATION,
    // Send the current leaderboard so the client can render the drawer icon
    // immediately without waiting for the separate player-list broadcast.
    players: publicPlayers(room),
    finishVotes: Array.from(room.finishVotes)
  });

  // Private prompt sent only to the drawer.
  io.to(drawer.id).emit('your-prompt', { prompt: room.currentPrompt });

  // Broadcast the updated player list so the scoreboard shows the new drawer icon.
  broadcastPlayers(room);

  // Sync the current "finish game" vote state (unlimited mode only).
  io.to(room.code).emit('finish-votes-update', {
    votes: Array.from(room.finishVotes),
    total: activePlayers(room).length
  });

  // Start the turn timer. Play unlocks halfway through; turn ends at timeout.
  startTurnTimer(room);
}

function startTurnTimer(room) {
  clearTurnTimer(room);

  room.playUnlocked = false;
  room.playUnlockTimer = setTimeout(() => {
    room.playUnlocked = true;
    io.to(room.code).emit('play-unlocked');
  }, PLAY_UNLOCK_TIME * 1000);

  room.turnTimer = setTimeout(() => {
    room.turnResolved = true;
    // Time is up: reveal the answer, then move to the next turn automatically.
    io.to(room.code).emit('answer-revealed', { answer: room.currentAnswerTitle || '' });
    room.turnTimer = setTimeout(() => endTurn(room), REVEAL_LINGER_TIME * 1000);
  }, TURN_DURATION * 1000);
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  if (room.playUnlockTimer) {
    clearTimeout(room.playUnlockTimer);
    room.playUnlockTimer = null;
  }
  room.playUnlocked = false;
}

function finishGame(room) {
  clearTurnTimer(room);
  room.currentDrawerId = null;
  room.finishVotes = new Set();
  broadcastPlayers(room);
  io.to(room.code).emit('game-over', {
    drawCounts: room.drawCounts,
    scores: room.scores,
    players: publicPlayers(room)
  });
  room.phase = 'finished';
}

function endTurn(room) {
  clearTurnTimer(room);
  console.log(`[endTurn] room=${room.code} advancing drawer index`);

  const players = activePlayers(room);
  if (players.length === 0) return;

  room.currentDrawerIndex = (room.currentDrawerIndex + 1) % players.length;

  // For a fixed number of rounds, end the game once every active player has drawn enough.
  if (room.choices.totalRounds) {
    const allDone = players.every(p => (room.drawCounts[p.id] || 0) >= room.choices.totalRounds);
    if (allDone) {
      finishGame(room);
      return;
    }
  }

  // A charades turn needs at least one guesser. End early if too many left.
  if (players.length < 2) {
    finishGame(room);
    return;
  }

  startTurn(room);
}

// ------------------------------------------------------------------
// 8. Broadcast the current player list to everyone in a room
// ------------------------------------------------------------------
function broadcastPlayers(room) {
  const players = activePlayers(room);
  io.to(room.code).emit('player-list', {
    players: publicPlayers(room),
    playerCount: players.length,
    hostId: room.hostId,
    drawerId: room.currentDrawerId
  });
}

// ------------------------------------------------------------------
// 9. Handle each browser connection
// ------------------------------------------------------------------
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // --------------------------------------------------------------
  // Create a room
  // --------------------------------------------------------------
  socket.on('create-room', () => {
    let code = makeRoomCode();
    while (rooms[code]) code = makeRoomCode();

    rooms[code] = {
      code,
      hostId: socket.id,
      players: [{ id: socket.id, name: '', kicked: false }],
      kickedIds: new Set(),
      phase: 'waiting',
      strokes: [],
      asciiText: '',
      choices: {},
      currentChoice: null,
      timer: null,
      // Classical charades turn state
      currentRound: 0,
      currentDrawerIndex: 0,
      currentDrawerId: null,
      currentPrompt: null,
      currentAnswerTitle: null,
      promptQueue: [],
      drawCounts: {},
      scores: {},
      turnStartTime: null,
      turnResolved: false,
      correctGuessers: new Set(),
      turnTimer: null,
      playUnlockTimer: null,
      playUnlocked: false,
      finishVotes: new Set()
    };

    socket.join(code);
    socket.emit('room-created', { code, role: 'host' });
    broadcastPlayers(rooms[code]);
    console.log(`Room ${code} created by ${socket.id}`);
  });

  // --------------------------------------------------------------
  // Join a room
  // --------------------------------------------------------------
  socket.on('join-room', (code) => {
    const room = rooms[code?.toUpperCase?.()];

    if (!room) {
      socket.emit('room-error', 'Room not found');
      return;
    }

    if (room.kickedIds.has(socket.id)) {
      socket.emit('room-error', 'You were removed from this room');
      return;
    }

    if (room.phase !== 'waiting') {
      socket.emit('room-error', 'This game has already started');
      return;
    }

    // If this socket is rejoining, update its entry instead of adding a duplicate.
    const existing = room.players.find(p => p.id === socket.id);
    if (!existing) {
      if (activePlayers(room).length >= MAX_PLAYERS) {
        socket.emit('room-error', `This room is full (maximum ${MAX_PLAYERS} players)`);
        return;
      }
      room.players.push({ id: socket.id, name: '', kicked: false });
    }

    socket.join(room.code);
    socket.emit('joined-room', { code: room.code, role: 'player', strokes: room.strokes, asciiText: room.asciiText });
    broadcastPlayers(room);
    console.log(`Player ${socket.id} joined room ${room.code}`);
  });

  // --------------------------------------------------------------
  // Set or change display name
  // --------------------------------------------------------------
  socket.on('set-name', ({ code, name }) => {
    const room = rooms[code?.toUpperCase?.()];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const candidate = String(name || '').trim().substring(0, 16) || 'Player';
    const normalized = candidate.toLowerCase();

    // Reject names that match another active player's name (case-insensitive).
    const duplicate = activePlayers(room).some(
      p => p.id !== socket.id && p.name.trim().toLowerCase() === normalized
    );
    if (duplicate) {
      socket.emit('room-error', 'That name is already taken');
      return;
    }

    player.name = candidate;
    socket.emit('name-set', { name: candidate });
    broadcastPlayers(room);
  });

  // --------------------------------------------------------------
  // Host kicks a player
  // --------------------------------------------------------------
  socket.on('kick-player', ({ code, playerId }) => {
    const room = rooms[code?.toUpperCase?.()];
    if (!room || room.hostId !== socket.id) return; // only host can kick

    const { removed, wasDrawer } = removePlayer(room, playerId);
    if (!removed) return;

    room.kickedIds.add(playerId);
    const target = io.sockets.sockets.get(playerId);
    if (target) {
      target.leave(code);
      target.emit('kicked');
    }

    // Their finish vote, if any, leaves with them.
    room.finishVotes.delete(playerId);
    broadcastPlayers(room);
    console.log(`Host kicked player ${playerId} from room ${code}`);

    // If the drawer was removed, advance so the game doesn't stall.
    if (room.phase === 'playing' && wasDrawer) {
      endTurn(room);
    }

    // A departure may change the finish threshold; end the game if consensus remains.
    if (room.phase === 'playing' && room.finishVotes.size >= activePlayers(room).length) {
      finishGame(room);
    }
  });

  // --------------------------------------------------------------
  // Host starts the customization vote
  // --------------------------------------------------------------
  socket.on('go-to-customize', (code) => {
    const room = rooms[code?.toUpperCase?.()];
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'waiting') return;

    // Need at least two active players to play.
    if (activePlayers(room).length < 2) {
      socket.emit('room-error', 'Need at least 2 players to start');
      return;
    }

    advanceCustomization(room);
  });

  // --------------------------------------------------------------
  // Host starts a rematch after the game ends
  // --------------------------------------------------------------
  socket.on('rematch', (code) => {
    const room = rooms[code?.toUpperCase?.()];
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'finished') return;

    // Need at least two active players to rematch.
    if (activePlayers(room).length < 2) {
      socket.emit('room-error', 'Need at least 2 players to rematch');
      return;
    }

    // Reset turn/game state while preserving players and kicked list.
    room.phase = 'waiting';
    room.choices = {};
    room.currentChoice = null;
    room.strokes = [];
    room.asciiText = '';
    room.scores = {};
    room.drawCounts = {};
    room.currentPrompt = null;
    room.currentAnswerTitle = null;
    room.promptQueue = [];
    room.currentDrawerId = null;
    room.currentDrawerIndex = 0;
    room.currentRound = 0;
    room.turnStartTime = null;
    room.turnResolved = false;
    room.playUnlocked = false;
    room.finishVotes = new Set();
    clearTurnTimer(room);

    // Tell everyone the rematch is starting, then run the customization vote.
    io.to(room.code).emit('rematch-started', { code: room.code });
    advanceCustomization(room);
  });

  // --------------------------------------------------------------
  // Player casts a vote
  // --------------------------------------------------------------
  socket.on('vote', ({ code, choiceIndex }) => {
    const room = rooms[code?.toUpperCase?.()];
    if (!room || room.phase !== 'customize' || !room.currentChoice) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.kicked) return;
    if (room.currentChoice.voterIds.has(socket.id)) return; // one vote per player

    room.currentChoice.votes[choiceIndex] = (room.currentChoice.votes[choiceIndex] || 0) + 1;
    room.currentChoice.voterIds.add(socket.id);

    // Send updated vote counts to everyone so cards can show live results.
    io.to(room.code).emit('vote-update', {
      votes: room.currentChoice.votes
    });

    // If everyone has voted, end the round early.
    if (room.currentChoice.voterIds.size >= activePlayers(room).length) {
      finalizeChoice(room);
    }
  });

  // --------------------------------------------------------------
  // In-game drawing/ASCII state sync
  // --------------------------------------------------------------
  socket.on('state-update', ({ code, strokes, asciiText }) => {
    const room = rooms[code?.toUpperCase?.()];
    if (!room) return;
    if (strokes !== undefined) room.strokes = strokes;
    if (asciiText !== undefined) room.asciiText = asciiText;
    socket.to(code).emit('state-update', { strokes, asciiText });
  });

  socket.on('play-sequence', ({ code }) => {
    const room = rooms[code?.toUpperCase?.()];
    if (!room) return;
    socket.to(code).emit('play-sequence');
  });

  socket.on('guess', ({ code, text }) => {
    const room = rooms[code?.toUpperCase?.()];
    if (!room || room.phase !== 'playing') return;
    if (room.turnResolved) {
      console.log(`[guess] rejected: room=${room.code} player=${socket.id} guess="${text}" (turn already resolved)`);
      return;
    }
    // The drawer receives the prompt, so only guessers may earn points.
    if (room.currentDrawerId === socket.id) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.kicked) return;
    const playerName = player?.name || 'Player';
    const guess = String(text || '').trim();
    if (!guess) return;

    const answer = room.currentAnswerTitle || '';
    // Compare case-insensitively while treating repeated whitespace as one space.
    const isCorrect = normalizeGuess(answer) === normalizeGuess(guess);

    if (isCorrect) {
      // A player can only score once per turn. The round keeps running so other
      // guessers can still try, but ends early once every active guesser has
      // scored.
      if (room.correctGuessers.has(socket.id)) {
        console.log(`[guess] already-scored: room=${room.code} player=${socket.id} guess="${guess}"`);
        return;
      }
      room.correctGuessers.add(socket.id);
      const points = scoreForCorrectGuess(Date.now() - (room.turnStartTime || Date.now()));
      room.scores[socket.id] = (room.scores[socket.id] || 0) + points;
      console.log(`[guess] correct: room=${room.code} player=${socket.id} guess="${guess}" +${points}pts`);

      io.to(room.code).emit('guess-result', {
        playerId: socket.id,
        playerName,
        guess,
        correct: true,
        points
      });
      broadcastPlayers(room);

      // If every active guesser has now scored, end the round early.
      const guessers = activePlayers(room).filter(p => p.id !== room.currentDrawerId);
      if (guessers.length > 0 && guessers.every(p => room.correctGuessers.has(p.id))) {
        console.log(`[guess] all guessers correct: room=${room.code} ending turn early`);
        room.turnResolved = true;
        clearTurnTimer(room);
        io.to(room.code).emit('answer-revealed', { answer: room.currentAnswerTitle || '' });
        room.turnTimer = setTimeout(() => endTurn(room), REVEAL_LINGER_TIME * 1000);
      }
    } else {
      console.log(`[guess] wrong: room=${room.code} player=${socket.id} guess="${guess}"`);
      io.to(room.code).emit('guess-result', {
        playerId: socket.id,
        playerName,
        guess,
        correct: false
      });
    }
  });

  // --------------------------------------------------------------
  // Vote to finish an unlimited game
  // --------------------------------------------------------------
  socket.on('vote-finish', ({ code, finish }, ack) => {
    const room = rooms[code?.toUpperCase?.()];
    if (!room) {
      console.log(`[vote-finish] rejected: room not found for code=${code}`);
      if (typeof ack === 'function') ack({ ok: false, reason: 'room-not-found' });
      return;
    }
    if (room.phase !== 'playing') {
      console.log(`[vote-finish] rejected: room=${room.code} phase=${room.phase}`);
      if (typeof ack === 'function') ack({ ok: false, reason: 'not-playing', phase: room.phase });
      return;
    }

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.kicked) {
      console.log(`[vote-finish] rejected: room=${room.code} player=${socket.id} not found or kicked`);
      if (typeof ack === 'function') ack({ ok: false, reason: 'player-not-found' });
      return;
    }

    // Defensive: old rooms or edge cases may not have the set.
    if (!room.finishVotes) room.finishVotes = new Set();

    if (finish) {
      room.finishVotes.add(socket.id);
    } else {
      room.finishVotes.delete(socket.id);
    }

    const players = activePlayers(room);
    console.log(`[finish-vote] room=${room.code} voter=${socket.id} finish=${finish} votes=${room.finishVotes.size}/${players.length}`);
    io.to(room.code).emit('finish-votes-update', {
      votes: Array.from(room.finishVotes),
      total: players.length
    });

    if (typeof ack === 'function') {
      ack({ ok: true, votes: room.finishVotes.size, total: players.length });
    }

    // If every active player wants to finish, end the game immediately.
    if (room.finishVotes.size >= players.length) {
      console.log(`[finish-vote] consensus reached in room=${room.code}; ending game`);
      finishGame(room);
    }
  });

  // --------------------------------------------------------------
  // Disconnect cleanup
  // --------------------------------------------------------------
  socket.on('disconnect', () => {
    console.log('A user disconnected:', socket.id);

    for (const code in rooms) {
      const room = rooms[code];
      const { removed, wasDrawer } = removePlayer(room, socket.id);
      if (!removed) continue;

      // If the host leaves, assign a new host or delete the room.
      if (socket.id === room.hostId) {
        const nextHost = room.players.find(p => !p.kicked);
        if (nextHost) {
          room.hostId = nextHost.id;
          io.to(nextHost.id).emit('became-host');
        } else {
          delete rooms[code];
          console.log(`Room ${code} deleted (host left)`);
          continue;
        }
      }

      if (activePlayers(room).length === 0) {
        delete rooms[code];
        console.log(`Room ${code} deleted (empty)`);
      } else {
        // Their finish vote, if any, leaves with them.
        room.finishVotes.delete(socket.id);
        broadcastPlayers(room);

        // If the drawer left mid-game, skip to the next turn so the game doesn't stall.
        if (room.phase === 'playing' && wasDrawer) {
          endTurn(room);
        }

        // A departure may change the finish threshold; end the game if consensus remains.
        if (room.phase === 'playing' && room.finishVotes.size >= activePlayers(room).length) {
          finishGame(room);
        }
      }
    }
  });
});

// ------------------------------------------------------------------
// 10. Start server
// ------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Thesia server running on http://localhost:${PORT}`);
});
