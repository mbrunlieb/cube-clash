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

function buildPlayerState(seat, deckInfo, cards) {
  return {
    seat,
    drafter: deckInfo.drafter,
    deckName: deckInfo.name,
    ...buildDeckState(cards),
  };
}

function createGame() {
  const gameId = generateId();
  const game = {
    gameId,
    status: "waiting",
    players: {},
    // Store original cards for restart
    originalCards: { A: currentWeek.deckA.cards, B: currentWeek.deckB.cards },
    state: {
      playerA: buildPlayerState("A", currentWeek.deckA, currentWeek.deckA.cards),
      playerB: buildPlayerState("B", currentWeek.deckB, currentWeek.deckB.cards),
      turn: "A",
      chat: [],
      log: [],
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

function addLog(game, message) {
  game.state.log.push({ message, time: Date.now() });
  // Keep log to last 100 entries
  if (game.state.log.length > 100) game.state.log.shift();
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

  socket.on("update_deck", ({ gameId, seat, cards }) => {
    const game = games[gameId];
    if (!game) return;
    const playerKey = seat === "A" ? "playerA" : "playerB";
    const deckInfo = seat === "A" ? currentWeek.deckA : currentWeek.deckB;
    game.state[playerKey] = buildPlayerState(seat, deckInfo, cards);
    // Update stored original cards for restart
    game.originalCards[seat] = cards;
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
    const oppSeat = seat === "A" ? "B" : "A";
    const ps = seat === "A" ? game.state.playerA : game.state.playerB;
    const ops = seat === "A" ? game.state.playerB : game.state.playerA;
    const name = player.name;

    switch (action.type) {

      case "DRAW_CARD": {
        if (ps.library.length === 0) break;
        const card = ps.library.shift();
        card.faceUp = true;
        ps.hand.push(card);
        addLog(game, `${name} drew a card`);
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
        addLog(game, `${name} played ${card.name}`);
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
        addLog(game, `${name} played a card face-down`);
        break;
      }

      case "MOVE_CARD": {
        const card = ps.battlefield.find(c => c.instanceId === action.instanceId);
        if (card) { card.x = action.x; card.y = action.y; }
        break;
      }

      case "TAP_CARD": {
        const card = ps.battlefield.find(c => c.instanceId === action.instanceId);
        if (card) {
          card.tapped = !card.tapped;
          addLog(game, `${name} ${card.tapped ? "tapped" : "untapped"} ${card.faceUp ? card.name : "a face-down card"}`);
        }
        break;
      }

      case "FLIP_CARD": {
        for (const zone of ["battlefield", "hand", "graveyard"]) {
          const card = ps[zone].find(c => c.instanceId === action.instanceId);
          if (card) {
            card.faceUp = !card.faceUp;
            addLog(game, `${name} flipped ${card.name} face-${card.faceUp ? "up" : "down"}`);
            break;
          }
        }
        break;
      }

      case "DISCARD_CARD": {
        const card = removeFromZone(ps, "hand", action.instanceId);
        if (card) { card.faceUp = true; ps.graveyard.push(card); addLog(game, `${name} discarded ${card.name}`); }
        break;
      }

      case "HAND_TO_EXILE": {
        const card = removeFromZone(ps, "hand", action.instanceId);
        if (card) { card.faceUp = true; ps.exile.push(card); addLog(game, `${name} exiled ${card.name} from hand`); }
        break;
      }

      case "MOVE_TO_GRAVEYARD": {
        const card = removeFromZone(ps, "battlefield", action.instanceId);
        if (card) { card.faceUp = true; card.tapped = false; ps.graveyard.push(card); addLog(game, `${name} sent ${card.name} to graveyard`); }
        break;
      }

      case "MOVE_TO_EXILE": {
        const card = removeFromZone(ps, "battlefield", action.instanceId);
        if (card) { card.faceUp = true; ps.exile.push(card); addLog(game, `${name} exiled ${card.name}`); }
        break;
      }

      case "MOVE_TO_OPP_BATTLEFIELD": {
        const card = removeFromZone(ps, "battlefield", action.instanceId);
        if (card) {
          card.tapped = false;
          card.x = 100;
          card.y = 50;
          ops.battlefield.push(card);
          addLog(game, `${name} gave control of ${card.faceUp ? card.name : "a card"} to opponent`);
        }
        break;
      }

      case "BF_TO_HAND": {
        const card = removeFromZone(ps, "battlefield", action.instanceId);
        if (card) { card.tapped = false; ps.hand.push(card); addLog(game, `${name} returned ${card.name} to hand`); }
        break;
      }

      case "BF_TO_LIBRARY_TOP": {
        const card = removeFromZone(ps, "battlefield", action.instanceId);
        if (card) { card.tapped = false; card.faceUp = false; ps.library.unshift(card); addLog(game, `${name} put ${card.name} on top of library`); }
        break;
      }

      case "BF_TO_LIBRARY_BOTTOM": {
        const card = removeFromZone(ps, "battlefield", action.instanceId);
        if (card) { card.tapped = false; card.faceUp = false; ps.library.push(card); addLog(game, `${name} put ${card.name} on bottom of library`); }
        break;
      }

      case "HAND_TO_LIBRARY_TOP": {
        const card = removeFromZone(ps, "hand", action.instanceId);
        if (card) { card.faceUp = false; ps.library.unshift(card); addLog(game, `${name} put a card on top of library`); }
        break;
      }

      case "HAND_TO_LIBRARY_BOTTOM": {
        const card = removeFromZone(ps, "hand", action.instanceId);
        if (card) { card.faceUp = false; ps.library.push(card); addLog(game, `${name} put a card on bottom of library`); }
        break;
      }

      case "ZONE_TO_HAND": {
        const card = removeFromZone(ps, action.fromZone, action.instanceId);
        if (card) { ps.hand.push(card); addLog(game, `${name} returned ${card.name} to hand from ${action.fromZone}`); }
        break;
      }

      case "ZONE_TO_BATTLEFIELD": {
        const card = removeFromZone(ps, action.fromZone, action.instanceId);
        if (card) { card.faceUp = true; card.x = 100; card.y = 50; ps.battlefield.push(card); addLog(game, `${name} put ${card.name} onto battlefield from ${action.fromZone}`); }
        break;
      }

      case "ZONE_TO_LIBRARY_TOP": {
        const card = removeFromZone(ps, action.fromZone, action.instanceId);
        if (card) { card.faceUp = false; ps.library.unshift(card); addLog(game, `${name} put ${card.name} on top of library`); }
        break;
      }

      case "ZONE_TO_LIBRARY_BOTTOM": {
        const card = removeFromZone(ps, action.fromZone, action.instanceId);
        if (card) { card.faceUp = false; ps.library.push(card); addLog(game, `${name} put ${card.name} on bottom of library`); }
        break;
      }

      case "ZONE_TO_GRAVEYARD": {
        const card = removeFromZone(ps, action.fromZone, action.instanceId);
        if (card) { card.faceUp = true; ps.graveyard.push(card); addLog(game, `${name} sent ${card.name} to graveyard`); }
        break;
      }

      case "ZONE_TO_EXILE": {
        const card = removeFromZone(ps, action.fromZone, action.instanceId);
        if (card) { card.faceUp = true; ps.exile.push(card); addLog(game, `${name} exiled ${card.name}`); }
        break;
      }

      case "LIBRARY_CARD_TO_HAND": {
        const [card] = ps.library.splice(action.index, 1);
        if (card) { card.faceUp = true; ps.hand.push(card); addLog(game, `${name} took ${card.name} from library to hand`); }
        break;
      }

      case "LIBRARY_CARD_TO_BATTLEFIELD": {
        const [card] = ps.library.splice(action.index, 1);
        if (card) { card.faceUp = true; card.x = 100; card.y = 50; ps.battlefield.push(card); addLog(game, `${name} put ${card.name} from library onto battlefield`); }
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
        if (card) { card.faceUp = true; ps.graveyard.push(card); addLog(game, `${name} sent ${card.name} from library to graveyard`); }
        break;
      }

      case "SHUFFLE_LIBRARY": {
        ps.library = shuffleArray(ps.library);
        addLog(game, `${name} shuffled their library`);
        break;
      }

      case "SEARCH_LIBRARY": {
        addLog(game, `${name} is searching their library`);
        break;
      }

      case "VIEW_TOP_LIBRARY": {
        addLog(game, `${name} is looking at the top ${action.count} card${action.count !== 1 ? "s" : ""} of their library`);
        break;
      }

      case "ADD_COUNTER": {
        const card = ps.battlefield.find(c => c.instanceId === action.instanceId);
        if (card) { card.counters = (card.counters || 0) + 1; addLog(game, `${name} added a counter to ${card.faceUp ? card.name : "a card"} (now ${card.counters})`); }
        break;
      }

      case "REMOVE_COUNTER": {
        const card = ps.battlefield.find(c => c.instanceId === action.instanceId);
        if (card) { card.counters = Math.max(0, (card.counters || 0) - 1); addLog(game, `${name} removed a counter from ${card.faceUp ? card.name : "a card"} (now ${card.counters})`); }
        break;
      }

      case "SET_LIFE": {
        const old = ps.life;
        ps.life = action.life;
        addLog(game, `${name} life: ${old} → ${action.life}`);
        break;
      }

      case "UNTAP_ALL": {
        ps.battlefield.forEach(c => c.tapped = false);
        addLog(game, `${name} untapped all permanents`);
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
        addLog(game, `${name} created a ${action.name} token`);
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
          addLog(game, `${name} cloned ${original.faceUp ? original.name : "a card"}`);
        }
        break;
      }

      case "CONCEDE": {
        game.status = "finished";
        addLog(game, `${name} conceded`);
        io.to(gameId).emit("game_over", { reason: `${name} conceded.` });
        break;
      }

      case "RESTART_GAME": {
        // Rebuild both player states from stored original cards
        game.state.playerA = buildPlayerState("A", currentWeek.deckA, game.originalCards.A || []);
        game.state.playerB = buildPlayerState("B", currentWeek.deckB, game.originalCards.B || []);
        game.state.log = [{ message: `${name} restarted the game`, time: Date.now() }];
        game.status = "active";
        io.to(gameId).emit("game_restart", {});
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Cube Clash server running on port ${PORT}`);
});
