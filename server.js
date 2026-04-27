const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── In-memory state ───────────────────────────────────────────────────────────

// Current week's decks — set via API from the trophy battle script
let currentWeek = {
  weekLabel: null,
  deckA: { name: null, drafter: null, cards: [] },
  deckB: { name: null, drafter: null, cards: [] },
};

// Active games — keyed by gameId
const games = {};

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildDeckState(cards) {
  // Each card gets a unique instance ID
  const library = shuffleArray(
    cards.map((card, i) => ({
      instanceId: generateId() + i,
      name: card.name,
      imageUrl: card.imageUrl,
      faceUp: false,
      tapped: false,
      counters: 0,
    }))
  );
  return {
    library,
    hand: [],
    battlefield: [],
    graveyard: [],
    exile: [],
    life: 20,
  };
}

function createGame(deckChoice) {
  const gameId = generateId();
  const deckA = currentWeek.deckA;
  const deckB = currentWeek.deckB;

  const game = {
    gameId,
    status: "waiting", // waiting | active | finished
    players: {},       // socketId -> { seat, name }
    state: {
      playerA: {
        seat: "A",
        drafter: deckA.drafter,
        deckName: deckA.name,
        ...buildDeckState(deckA.cards),
      },
      playerB: {
        seat: "B",
        drafter: deckB.drafter,
        deckName: deckB.name,
        ...buildDeckState(deckB.cards),
      },
      turn: "A",
      phase: "main",
      chat: [],
    },
    createdAt: Date.now(),
  };

  games[gameId] = game;
  return game;
}

// ── REST API ──────────────────────────────────────────────────────────────────

// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, weekLabel: currentWeek.weekLabel });
});

// Set this week's decks (called by trophy_battle.py)
app.post("/api/set-decks", (req, res) => {
  const { secret, weekLabel, deckA, deckB } = req.body;

  if (secret !== process.env.CLASH_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  currentWeek = { weekLabel, deckA, deckB };

  // Clear old games when new week starts
  Object.keys(games).forEach((id) => delete games[id]);

  console.log(`New week set: ${weekLabel} — ${deckA.drafter} vs ${deckB.drafter}`);
  res.json({ ok: true, weekLabel });
});

// Get current week info + active games (for lobby page)
app.get("/api/lobby", (req, res) => {
  const activeGames = Object.values(games).map((g) => ({
    gameId: g.gameId,
    status: g.status,
    playerCount: Object.keys(g.players).length,
    createdAt: g.createdAt,
  }));

  res.json({
    weekLabel: currentWeek.weekLabel,
    deckA: { name: currentWeek.deckA.name, drafter: currentWeek.deckA.drafter },
    deckB: { name: currentWeek.deckB.name, drafter: currentWeek.deckB.drafter },
    games: activeGames,
  });
});

// Create a new game
app.post("/api/games", (req, res) => {
  if (!currentWeek.weekLabel) {
    return res.status(400).json({ error: "No decks set for this week yet." });
  }
  const game = createGame();
  res.json({ gameId: game.gameId });
});

// Serve the frontend for all other routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Socket.io ─────────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Join a game
  socket.on("join_game", ({ gameId, playerName, seat }) => {
    const game = games[gameId];
    if (!game) {
      socket.emit("error", { message: "Game not found." });
      return;
    }

    const playerCount = Object.keys(game.players).length;

    // Check if seat is taken
    const seatTaken = Object.values(game.players).some((p) => p.seat === seat);
    if (seatTaken) {
      socket.emit("error", { message: "That seat is already taken." });
      return;
    }

    if (playerCount >= 2) {
      socket.emit("error", { message: "Game is full." });
      return;
    }

    game.players[socket.id] = { seat, name: playerName };
    socket.join(gameId);

    if (Object.keys(game.players).length === 2) {
      game.status = "active";
    }

    io.to(gameId).emit("game_state", game.state);
    io.to(gameId).emit("game_info", {
      gameId,
      status: game.status,
      players: Object.values(game.players),
    });

    console.log(`${playerName} joined game ${gameId} as Deck ${seat}`);
  });

  // Generic game action handler
  socket.on("game_action", ({ gameId, action }) => {
    const game = games[gameId];
    if (!game) return;

    const player = game.players[socket.id];
    if (!player) return;

    const seat = player.seat; // "A" or "B"
    const playerState = seat === "A" ? game.state.playerA : game.state.playerB;

    switch (action.type) {

      case "DRAW_CARD": {
        if (playerState.library.length === 0) break;
        const card = playerState.library.shift();
        card.faceUp = true;
        playerState.hand.push(card);
        break;
      }

      case "PLAY_CARD": {
        // Move card from hand to battlefield
        const idx = playerState.hand.findIndex((c) => c.instanceId === action.instanceId);
        if (idx === -1) break;
        const [card] = playerState.hand.splice(idx, 1);
        card.faceUp = true;
        card.x = action.x || 100;
        card.y = action.y || 100;
        playerState.battlefield.push(card);
        break;
      }

      case "MOVE_CARD": {
        // Move a card on the battlefield
        const card = playerState.battlefield.find((c) => c.instanceId === action.instanceId);
        if (!card) break;
        card.x = action.x;
        card.y = action.y;
        break;
      }

      case "TAP_CARD": {
        const card = playerState.battlefield.find((c) => c.instanceId === action.instanceId);
        if (!card) break;
        card.tapped = !card.tapped;
        break;
      }

      case "FLIP_CARD": {
        // Flip face up/down anywhere
        for (const zone of ["battlefield", "hand", "graveyard"]) {
          const card = playerState[zone].find((c) => c.instanceId === action.instanceId);
          if (card) { card.faceUp = !card.faceUp; break; }
        }
        break;
      }

      case "DISCARD_CARD": {
        const idx = playerState.hand.findIndex((c) => c.instanceId === action.instanceId);
        if (idx === -1) break;
        const [card] = playerState.hand.splice(idx, 1);
        card.faceUp = true;
        playerState.graveyard.push(card);
        break;
      }

      case "MOVE_TO_GRAVEYARD": {
        const idx = playerState.battlefield.findIndex((c) => c.instanceId === action.instanceId);
        if (idx === -1) break;
        const [card] = playerState.battlefield.splice(idx, 1);
        card.faceUp = true;
        card.tapped = false;
        playerState.graveyard.push(card);
        break;
      }

      case "MOVE_TO_EXILE": {
        const idx = playerState.battlefield.findIndex((c) => c.instanceId === action.instanceId);
        if (idx === -1) break;
        const [card] = playerState.battlefield.splice(idx, 1);
        card.faceUp = true;
        playerState.exile.push(card);
        break;
      }

      case "RETURN_TO_HAND": {
        const idx = playerState.graveyard.findIndex((c) => c.instanceId === action.instanceId);
        if (idx === -1) break;
        const [card] = playerState.graveyard.splice(idx, 1);
        playerState.hand.push(card);
        break;
      }

      case "SHUFFLE_LIBRARY": {
        playerState.library = shuffleArray(playerState.library);
        break;
      }

      case "ADD_COUNTER": {
        const card = playerState.battlefield.find((c) => c.instanceId === action.instanceId);
        if (!card) break;
        card.counters = (card.counters || 0) + 1;
        break;
      }

      case "REMOVE_COUNTER": {
        const card = playerState.battlefield.find((c) => c.instanceId === action.instanceId);
        if (!card) break;
        card.counters = Math.max(0, (card.counters || 0) - 1);
        break;
      }

      case "SET_LIFE": {
        playerState.life = action.life;
        break;
      }

      case "UNTAP_ALL": {
        playerState.battlefield.forEach((c) => (c.tapped = false));
        break;
      }

      case "CHAT": {
        game.state.chat.push({
          name: player.name,
          message: action.message,
          time: Date.now(),
        });
        break;
      }
    }

    // Broadcast updated state to all players in the game
    io.to(gameId).emit("game_state", game.state);
  });

  socket.on("disconnect", () => {
    // Find and clean up player from any game
    for (const game of Object.values(games)) {
      if (game.players[socket.id]) {
        const player = game.players[socket.id];
        delete game.players[socket.id];
        game.status = "waiting";
        io.to(game.gameId).emit("player_left", { name: player.name });
        console.log(`${player.name} left game ${game.gameId}`);
        break;
      }
    }
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Cube Clash server running on port ${PORT}`);
});
