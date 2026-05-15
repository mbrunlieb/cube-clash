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

let currentWeek = {
  weekLabel: null,
  deckA: { name: null, drafter: null, cards: [] },
  deckB: { name: null, drafter: null, cards: [] },
};

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
  const library = shuffleArray(
    cards.map((card, i) => ({
      instanceId: generateId() + i,
      name: card.name,
      imageUrl: card.imageUrl || null,
      faceUp: false,
      tapped: false,
      counters: 0,
      isToken: false,
    }))
  );
  return { library, hand: [], battlefield: [], graveyard: [], exile: [], life: 20 };
}

function createGame() {
  const gameId = generateId();
  const game = {
    gameId,
    status: "waiting",
    players: {},
    state: {
      playerA: {
        seat: "A",
        drafter: currentWeek.deckA.drafter,
        deckName: currentWeek.deckA.name,
        ...buildDeckState(currentWeek.deckA.cards),
      },
      playerB: {
        seat: "B",
        drafter: currentWeek.deckB.drafter,
        deckName: currentWeek.deckB.name,
        ...buildDeckState(currentWeek.deckB.cards),
      },
      turn: "A",
      chat: [],
    },
    createdAt: Date.now(),
  };
  games[gameId] = game;
  return game;
}

function removeFromZone(playerState, zone, instanceId) {
  const idx = playerState[zone].findIndex(c => c.instanceId === instanceId);
  if (idx === -1) return null;
  return playerState[zone].splice(idx, 1)[0];
}

// ── REST API ──────────────────────────────────────────────────────────────────

app.get("/api/health", (req, res) => {
  res.json({ ok: true, weekLabel: currentWeek.weekLabel });
});

app.post("/api/set-decks", (req, res) => {
  const { secret, weekLabel, deckA, deckB } = req.body;
  if (secret !== process.env.CLASH_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  currentWeek = { weekLabel, deckA, deckB };
  Object.keys(games).forEach(id => delete games[id]);
  console.log(`New week set: ${weekLabel}`);
  res.json({ ok: true, weekLabel });
});

app.get("/api/lobby", (req, res) => {
  const activeGames = Object.values(games).map(g => ({
    gameId: g.gameId,
    status: g.status,
    playerCount: Object.keys(g.players).length,
    createdAt: g.createdAt,
  }));
  res.json({
    weekLabel: currentWeek.weekLabel,
    deckA: { name: currentWeek.deckA.name, drafter: currentWeek.deckA.drafter, cards: currentWeek.deckA.cards },
    deckB: { name: currentWeek.deckB.name, drafter: currentWeek.deckB.drafter, cards: currentWeek.deckB.cards },
    games: activeGames,
  });
});

app.post("/api/games", (req, res) => {
  if (!currentWeek.weekLabel) {
    return res.status(400).json({ error: "No decks set for this week yet." });
  }
  const game = createGame();
  res.json({ gameId: game.gameId });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Socket.io ─────────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Player updates their deck after editing in the lobby
  socket.on("update_deck", ({ gameId, seat, cards }) => {
    const game = games[gameId];
    if (!game) return;
    const playerKey = seat === "A" ? "playerA" : "playerB";
    const drafter = game.state[playerKey].drafter;
    const deckName = game.state[playerKey].deckName;
    game.state[playerKey] = { seat, drafter, deckName, ...buildDeckState(cards) };
    console.log(`Deck updated for seat ${seat} in game ${gameId}: ${cards.length} cards`);
  });

  socket.on("join_game", ({ gameId, playerName, seat }) => {
    const game = games[gameId];
    if (!game) { socket.emit("error", { message: "Game not found." }); return; }

    const seatTaken = Object.values(game.players).some(p => p.seat === seat);
    if (seatTaken) { socket.emit("error", { message: "That seat is already taken." }); return; }
    if (Object.keys(game.players).length >= 2) { socket.emit("error", { message: "Game is full." }); return; }

    game.players[socket.id] = { seat, name: playerName };
    socket.join(gameId);
    if (Object.keys(game.players).length === 2) game.status = "active";

    io.to(gameId).emit("game_state", game.state);
    io.to(gameId).emit("game_info", { gameId, status: game.status, players: Object.values(game.players) });
    console.log(`${playerName} joined game ${gameId} as Deck ${seat}`);
  });

  socket.on("game_action", ({ gameId, action }) => {
    const game = games[gameId];
    if (!game) return;
    const player = game.players[socket.id];
    if (!player) return;

    const seat = player.seat;
    const ps = seat === "A" ? game.state.playerA : game.state.playerB;

    switch (action.type) {

      case "DRAW_CARD": {
        if (ps.library.length === 0) break;
        const card = ps.library.shift();
        card.faceUp = true;
        ps.hand.push(card);
        break;
      }

      case "PLAY_CARD": {
        const idx = ps.hand.findIndex(c => c.instanceId === action.instanceId);
        if (idx === -1) break;
        const [card] = ps.hand.splice(idx, 1);
        card.faceUp = true;
        card.x = action.x || 100;
        card.y = action.y || 100;
        ps.battlefield.push(card);
        break;
      }

      case "PLAY_CARD_FACEDOWN": {
        const idx = ps.hand.findIndex(c => c.instanceId === action.instanceId);
        if (idx === -1) break;
        const [card] = ps.hand.splice(idx, 1);
        card.faceUp = false;
        card.x = action.x || 100;
        card.y = action.y || 100;
        ps.battlefield.push(card);
        break;
      }

      case "MOVE_CARD": {
        const card = ps.battlefield.find(c => c.instanceId === action.instanceId);
        if (card) { card.x = action.x; card.y = action.y; }
        break;
      }

      case "TAP_CARD": {
        const card = ps.battlefield.find(c => c.instanceId === action.instanceId);
        if (card) card.tapped = !card.tapped;
        break;
      }

      case "FLIP_CARD": {
        for (const zone of ["battlefield", "hand", "graveyard"]) {
          const card = ps[zone].find(c => c.instanceId === action.instanceId);
          if (card) { card.faceUp = !card.faceUp; break; }
        }
        break;
      }

      case "DISCARD_CARD": {
        const card = removeFromZone(ps, "hand", action.instanceId);
        if (card) { card.faceUp = true; ps.graveyard.push(card); }
        break;
      }

      case "HAND_TO_EXILE": {
        const card = removeFromZone(ps, "hand", action.instanceId);
        if (card) { card.faceUp = true; ps.exile.push(card); }
        break;
      }

      case "MOVE_TO_GRAVEYARD": {
        const card = removeFromZone(ps, "battlefield", action.instanceId);
        if (card) { card.faceUp = true; card.tapped = false; ps.graveyard.push(card); }
        break;
      }

      case "MOVE_TO_EXILE": {
        const card = removeFromZone(ps, "battlefield", action.instanceId);
        if (card) { card.faceUp = true; ps.exile.push(card); }
        break;
      }

      // Battlefield to other zones
      case "BF_TO_HAND": {
        const card = removeFromZone(ps, "battlefield", action.instanceId);
        if (card) { card.tapped = false; ps.hand.push(card); }
        break;
      }

      case "BF_TO_LIBRARY_TOP": {
        const card = removeFromZone(ps, "battlefield", action.instanceId);
        if (card) { card.tapped = false; card.faceUp = false; ps.library.unshift(card); }
        break;
      }

      case "BF_TO_LIBRARY_BOTTOM": {
        const card = removeFromZone(ps, "battlefield", action.instanceId);
        if (card) { card.tapped = false; card.faceUp = false; ps.library.push(card); }
        break;
      }

      // Hand to library
      case "HAND_TO_LIBRARY_TOP": {
        const card = removeFromZone(ps, "hand", action.instanceId);
        if (card) { card.faceUp = false; ps.library.unshift(card); }
        break;
      }

      case "HAND_TO_LIBRARY_BOTTOM": {
        const card = removeFromZone(ps, "hand", action.instanceId);
        if (card) { card.faceUp = false; ps.library.push(card); }
        break;
      }

      // Zone viewer actions (graveyard/exile to other zones)
      case "ZONE_TO_HAND": {
        const card = removeFromZone(ps, action.fromZone, action.instanceId);
        if (card) ps.hand.push(card);
        break;
      }

      case "ZONE_TO_BATTLEFIELD": {
        const card = removeFromZone(ps, action.fromZone, action.instanceId);
        if (card) { card.faceUp = true; card.x = 100; card.y = 50; ps.battlefield.push(card); }
        break;
      }

      case "ZONE_TO_LIBRARY_TOP": {
        const card = removeFromZone(ps, action.fromZone, action.instanceId);
        if (card) { card.faceUp = false; ps.library.unshift(card); }
        break;
      }

      case "ZONE_TO_LIBRARY_BOTTOM": {
        const card = removeFromZone(ps, action.fromZone, action.instanceId);
        if (card) { card.faceUp = false; ps.library.push(card); }
        break;
      }

      case "ZONE_TO_GRAVEYARD": {
        const card = removeFromZone(ps, action.fromZone, action.instanceId);
        if (card) { card.faceUp = true; ps.graveyard.push(card); }
        break;
      }

      case "ZONE_TO_EXILE": {
        const card = removeFromZone(ps, action.fromZone, action.instanceId);
        if (card) { card.faceUp = true; ps.exile.push(card); }
        break;
      }

      // Library viewer actions
      case "LIBRARY_CARD_TO_HAND": {
        const [card] = ps.library.splice(action.index, 1);
        if (card) { card.faceUp = true; ps.hand.push(card); }
        break;
      }

      case "LIBRARY_CARD_TO_BATTLEFIELD": {
        const [card] = ps.library.splice(action.index, 1);
        if (card) { card.faceUp = true; card.x = 100; card.y = 50; ps.battlefield.push(card); }
        break;
      }

      case "LIBRARY_CARD_TO_BOTTOM": {
        const [card] = ps.library.splice(action.index, 1);
        if (card) ps.library.push(card);
        break;
      }

      case "LIBRARY_CARD_TO_TOP": {
        const [card] = ps.library.splice(action.index, 1);
        if (card) ps.library.unshift(card);
        break;
      }

      case "LIBRARY_CARD_TO_GRAVEYARD": {
        const [card] = ps.library.splice(action.index, 1);
        if (card) { card.faceUp = true; ps.graveyard.push(card); }
        break;
      }

      case "SHUFFLE_LIBRARY": {
        ps.library = shuffleArray(ps.library);
        break;
      }

      case "ADD_COUNTER": {
        const card = ps.battlefield.find(c => c.instanceId === action.instanceId);
        if (card) card.counters = (card.counters || 0) + 1;
        break;
      }

      case "REMOVE_COUNTER": {
        const card = ps.battlefield.find(c => c.instanceId === action.instanceId);
        if (card) card.counters = Math.max(0, (card.counters || 0) - 1);
        break;
      }

      case "SET_LIFE": {
        ps.life = action.life;
        break;
      }

      case "UNTAP_ALL": {
        ps.battlefield.forEach(c => c.tapped = false);
        break;
      }

      case "CREATE_TOKEN": {
        ps.battlefield.push({
          instanceId: generateId() + "tok",
          name: action.name,
          pt: action.pt || "",
          desc: action.desc || "",
          imageUrl: null,
          faceUp: true,
          tapped: false,
          counters: 0,
          isToken: true,
          x: action.x || 100,
          y: action.y || 100,
        });
        break;
      }

      case "CLONE_CARD": {
        const original = ps.battlefield.find(c => c.instanceId === action.instanceId);
        if (original) {
          ps.battlefield.push({
            ...original,
            instanceId: generateId() + "clone",
            x: (original.x || 0) + 20,
            y: (original.y || 0) + 20,
            counters: 0,
            tapped: false,
          });
        }
        break;
      }

      case "CONCEDE": {
        game.status = "finished";
        io.to(gameId).emit("game_over", { reason: `${player.name} conceded.` });
        break;
      }

      case "CHAT": {
        game.state.chat.push({ name: player.name, message: action.message, time: Date.now() });
        break;
      }

      default:
        console.log(`Unknown action type: ${action.type}`);
    }

    io.to(gameId).emit("game_state", game.state);
  });

  socket.on("disconnect", () => {
    for (const game of Object.values(games)) {
      if (game.players[socket.id]) {
        const player = game.players[socket.id];
        delete game.players[socket.id];
        game.status = "waiting";
        io.to(game.gameId).emit("player_left", { name: player.name });
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
