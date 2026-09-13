// server.js
// Node/Express + Socket.IO backend for Thesia's multiplayer game mode.

// ------------------------------------------------------------------
// 1. Load libraries
// ------------------------------------------------------------------
const express = require('express');      // Web framework for serving static files
const http = require('http');            // Built-in HTTP server
const path = require('path');            // Cross-platform file paths
const { Server } = require('socket.io'); // Real-time WebSocket communication

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
const TURN_DURATION = 60;

// How long into the turn before the Play button is enabled, in seconds.
const PLAY_UNLOCK_TIME = 30;

// How long the revealed answer lingers before the next turn starts, in seconds.
const REVEAL_LINGER_TIME = 5;

// Maximum score for a correct guess and how many points are lost per second.
const MAX_GUESS_SCORE = 500;
const SCORE_LOSS_PER_SECOND = 10;
const FULL_SCORE_WINDOW = 10;

// Drawing mode options.
const MODES = ['Draw', 'ASCII'];

// Round-limit options.
const ROUND_OPTIONS = ['3 rounds', 'Unlimited'];

// Classical music prompts used for every game (genre is locked to Classical).
const CLASSICAL_SONGS = [
  'Fur Elise - Beethoven', 'Canon in D - Pachelbel', 'Clair de Lune - Debussy',
  'The Four Seasons: Spring - Vivaldi', 'Eine kleine Nachtmusik - Mozart',
  'Moonlight Sonata - Beethoven', 'Ode to Joy - Beethoven', 'Swan Lake - Tchaikovsky',
  'The Nutcracker - Tchaikovsky', 'Air on the G String - Bach', 'Symphony No. 5 - Beethoven',
  'Hall of the Mountain King - Grieg'
];

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

  const players = activePlayers(room);
  // Pick a random starting drawer; after that we rotate through the list.
  room.currentDrawerIndex = players.length ? Math.floor(Math.random() * players.length) : 0;

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
  const title = room.currentPrompt.split(' - ')[0].trim();
  room.currentAnswerTitle = title;
  room.turnStartTime = Date.now();

  // Build a hangman-style blank pattern: single spaces between letters,
  // wider gaps (four spaces) between words.
  const blanks = title
    .split('')
    .map(ch => (ch === ' ' ? '    ' : '_ '))
    .join('')
    .trim();

  // Public turn announcement (answer omitted; guessers see blanks).
  io.to(room.code).emit('turn-started', {
    drawerId: drawer.id,
    drawerName: drawer.name || 'Player',
    round: room.currentRound,
    totalRounds: room.choices.totalRounds || null,
    drawCountLeft,
    blanks,
    answerLength: title.length
  });

  // Private prompt sent only to the drawer.
  io.to(drawer.id).emit('your-prompt', { prompt: room.currentPrompt });

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

function endTurn(room) {
  clearTurnTimer(room);

  const players = activePlayers(room);
  if (players.length === 0) return;

  room.currentDrawerIndex = (room.currentDrawerIndex + 1) % players.length;

  // For a fixed number of rounds, end the game once every active player has drawn enough.
  if (room.choices.totalRounds) {
    const allDone = players.every(p => (room.drawCounts[p.id] || 0) >= room.choices.totalRounds);
    if (allDone) {
      io.to(room.code).emit('game-over', { drawCounts: room.drawCounts, scores: room.scores });
      room.phase = 'finished';
      return;
    }
  }

  startTurn(room);
}

// ------------------------------------------------------------------
// 8. Broadcast the current player list to everyone in a room
// ------------------------------------------------------------------
function broadcastPlayers(room) {
  const players = activePlayers(room);
  io.to(room.code).emit('player-list', {
    players: players.map(p => ({
      id: p.id,
      name: p.name,
      score: room.scores?.[p.id] || 0
    })),
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
      turnTimer: null,
      playUnlockTimer: null,
      playUnlocked: false
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

    // If this socket is rejoining, update its entry instead of adding a duplicate.
    const existing = room.players.find(p => p.id === socket.id);
    if (!existing) {
      room.players.push({ id: socket.id, name: '', kicked: false });
    }

    socket.join(code);
    socket.emit('joined-room', { code, role: 'player', strokes: room.strokes, asciiText: room.asciiText });
    broadcastPlayers(room);
    console.log(`Player ${socket.id} joined room ${code}`);
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

    const player = room.players.find(p => p.id === playerId);
    if (player) {
      player.kicked = true;
      room.kickedIds.add(playerId);
      const target = io.sockets.sockets.get(playerId);
      if (target) {
        target.leave(code);
        target.emit('kicked');
      }
      broadcastPlayers(room);
      console.log(`Host kicked player ${playerId} from room ${code}`);
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
  // Drawer/host signals the current drawing is finished
  // --------------------------------------------------------------
  socket.on('done-drawing', (code) => {
    const room = rooms[code?.toUpperCase?.()];
    if (!room || room.phase !== 'playing') return;

    const isDrawer = room.currentDrawerId === socket.id;
    const isHost = room.hostId === socket.id;
    if (!isDrawer && !isHost) return;

    endTurn(room);
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

    const player = room.players.find(p => p.id === socket.id);
    const playerName = player?.name || 'Player';
    const guess = String(text || '').trim();
    if (!guess) return;

    const answer = room.currentAnswerTitle || '';
    // Compare ignoring case and extra whitespace; composer is not required.
    const isCorrect = answer.localeCompare(guess, undefined, { sensitivity: 'base' }) === 0 ||
      answer.toLowerCase() === guess.toLowerCase();

    if (isCorrect) {
      const elapsedSeconds = Math.max(0, (Date.now() - (room.turnStartTime || Date.now())) / 1000);
      const secondsPastWindow = Math.max(0, elapsedSeconds - FULL_SCORE_WINDOW);
      const points = Math.max(0, MAX_GUESS_SCORE - Math.floor(secondsPastWindow) * SCORE_LOSS_PER_SECOND);
      room.scores[socket.id] = (room.scores[socket.id] || 0) + points;

      io.to(room.code).emit('guess-result', {
        playerId: socket.id,
        playerName,
        guess,
        correct: true,
        answer,
        points
      });
      // Reveal the answer and move on after a short celebration delay.
      io.to(room.code).emit('answer-revealed', { answer });
      clearTurnTimer(room);
      room.turnTimer = setTimeout(() => endTurn(room), REVEAL_LINGER_TIME * 1000);
      broadcastPlayers(room);
    } else {
      io.to(room.code).emit('guess-result', {
        playerId: socket.id,
        playerName,
        guess,
        correct: false
      });
    }
  });

  // --------------------------------------------------------------
  // Disconnect cleanup
  // --------------------------------------------------------------
  socket.on('disconnect', () => {
    console.log('A user disconnected:', socket.id);

    for (const code in rooms) {
      const room = rooms[code];
      const index = room.players.findIndex(p => p.id === socket.id);

      if (index !== -1) {
        room.players.splice(index, 1);

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
          broadcastPlayers(room);

          // If the drawer left mid-game, skip to the next turn so the game doesn't stall.
          if (room.phase === 'playing' && room.currentDrawerId === socket.id) {
            endTurn(room);
          }
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
