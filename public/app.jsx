const { useState, useEffect, useRef, useCallback } = React;

const socket = io();

// ── Utility ───────────────────────────────────────────────────────────────────

function getFaceDownUrl() {
  return "https://cards.scryfall.io/png/back/0/0/00000000-0000-0000-0000-000000000000.png?1562370455";
}

// ── Context Menu ─────────────────────────────────────────────────────────────

function ContextMenu({ x, y, items, onClose }) {
  useEffect(() => {
    const handler = () => onClose();
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [onClose]);

  return (
    <div className="context-menu" style={{ left: x, top: y }}>
      {items.map((item) => (
        <div
          key={item.label}
          className="context-item"
          onClick={(e) => { e.stopPropagation(); item.action(); onClose(); }}
        >
          {item.label}
        </div>
      ))}
    </div>
  );
}

// ── Battlefield Card ──────────────────────────────────────────────────────────

function BattlefieldCard({ card, onAction, isMe, onPreview }) {
  const [dragging, setDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const cardRef = useRef(null);

  const handleMouseDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = cardRef.current.getBoundingClientRect();
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => {
      if (!isMe) return;
      const parent = cardRef.current?.parentElement?.getBoundingClientRect();
      if (!parent) return;
      const x = e.clientX - parent.left - dragOffset.current.x;
      const y = e.clientY - parent.top - dragOffset.current.y;
      onAction({ type: "MOVE_CARD", instanceId: card.instanceId, x, y });
    };
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, isMe, card, onAction]);

  const handleContextMenu = (e) => {
    e.preventDefault();
    if (!isMe) return;
    const items = [
      { label: card.tapped ? "↺ Untap" : "↷ Tap", action: () => onAction({ type: "TAP_CARD", instanceId: card.instanceId }) },
      { label: card.faceUp ? "🔽 Flip face down" : "🔼 Flip face up", action: () => onAction({ type: "FLIP_CARD", instanceId: card.instanceId }) },
      { label: "💀 Send to graveyard", action: () => onAction({ type: "MOVE_TO_GRAVEYARD", instanceId: card.instanceId }) },
      { label: "🚫 Exile", action: () => onAction({ type: "MOVE_TO_EXILE", instanceId: card.instanceId }) },
      { label: "+ Add counter", action: () => onAction({ type: "ADD_COUNTER", instanceId: card.instanceId }) },
      { label: "− Remove counter", action: () => onAction({ type: "REMOVE_COUNTER", instanceId: card.instanceId }) },
    ];
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  const style = {
    left: card.x || 0,
    top: card.y || 0,
    cursor: dragging ? "grabbing" : "grab",
  };

  return (
    <>
      <div
        ref={cardRef}
        className={`battlefield-card${card.tapped ? " tapped" : ""}`}
        style={style}
        onMouseDown={handleMouseDown}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => onPreview(card)}
        onMouseLeave={() => onPreview(null)}
      >
        {card.faceUp && card.imageUrl ? (
          <img src={card.imageUrl} alt={card.name} draggable={false} />
        ) : (
          <div className="face-down">🂠</div>
        )}
        {card.counters > 0 && (
          <div className="counter-badge">+{card.counters}</div>
        )}
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}

// ── Player Area ───────────────────────────────────────────────────────────────

function PlayerArea({ playerState, isMe, onAction, onPreview, label }) {
  const handleBfClick = (e) => {
    if (!isMe) return;
    // Double-click on empty battlefield to play a card from hand - handled in side panel
  };

  return (
    <div className={`player-area ${isMe ? "me" : "opponent"}`} onClick={handleBfClick}>
      <div className="area-label">
        {label} — {playerState.drafter}'s deck
        {" "}({playerState.battlefield.length} permanents)
      </div>
      {playerState.battlefield.map((card) => (
        <BattlefieldCard
          key={card.instanceId}
          card={card}
          onAction={isMe ? onAction : () => {}}
          isMe={isMe}
          onPreview={onPreview}
        />
      ))}
    </div>
  );
}

// ── Side Panel ────────────────────────────────────────────────────────────────

function SidePanel({ myState, oppState, onAction, chat, playerName, onChat, onPreview }) {
  const [chatInput, setChatInput] = useState("");
  const chatRef = useRef(null);

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [chat]);

  const sendChat = (e) => {
    if (e.key === "Enter" && chatInput.trim()) {
      onChat(chatInput.trim());
      setChatInput("");
    }
  };

  const playCard = (card) => {
    onAction({
      type: "PLAY_CARD",
      instanceId: card.instanceId,
      x: 80 + Math.random() * 200,
      y: 30 + Math.random() * 80,
    });
  };

  return (
    <div className="side-panel">
      {/* My life */}
      <div className="zone-section">
        <h4>My Life</h4>
        <div className="life-display">{myState.life}</div>
        <div className="life-controls">
          <button className="life-btn" onClick={() => onAction({ type: "SET_LIFE", life: myState.life + 1 })}>+</button>
          <button className="life-btn" onClick={() => onAction({ type: "SET_LIFE", life: myState.life - 1 })}>−</button>
        </div>
      </div>

      {/* Opp life */}
      <div className="zone-section">
        <h4>Opponent Life</h4>
        <div className="life-display" style={{ fontSize: "1.4rem", color: "#aaa" }}>{oppState.life}</div>
      </div>

      {/* Actions */}
      <div className="zone-section">
        <h4>Actions</h4>
        <button className="action-btn" onClick={() => onAction({ type: "DRAW_CARD" })}>
          📚 Draw ({myState.library.length} left)
        </button>
        <button className="action-btn" onClick={() => onAction({ type: "UNTAP_ALL" })}>
          ↺ Untap all
        </button>
        <button className="action-btn" onClick={() => onAction({ type: "SHUFFLE_LIBRARY" })}>
          🔀 Shuffle library
        </button>
      </div>

      {/* Hand */}
      <div className="zone-section">
        <h4>Hand ({myState.hand.length})</h4>
        <div className="hand-cards">
          {myState.hand.map((card) => (
            <div
              key={card.instanceId}
              className="hand-card"
              title={card.name}
              onMouseEnter={() => onPreview(card)}
              onMouseLeave={() => onPreview(null)}
              onClick={() => playCard(card)}
              onContextMenu={(e) => {
                e.preventDefault();
                // Discard on right-click
                onAction({ type: "DISCARD_CARD", instanceId: card.instanceId });
              }}
            >
              {card.imageUrl ? (
                <img src={card.imageUrl} alt={card.name} draggable={false} />
              ) : (
                <div className="face-down" style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#1e3a5f", borderRadius: "3px" }}>🂠</div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Graveyard / Exile */}
      <div className="zone-section">
        <div className="zone-pill">
          <span>💀 Graveyard</span>
          <span>{myState.graveyard.length}</span>
        </div>
        <div className="zone-pill" style={{ marginTop: 4 }}>
          <span>🚫 Exile</span>
          <span>{myState.exile.length}</span>
        </div>
        <div className="zone-pill" style={{ marginTop: 4 }}>
          <span>👁 Opp GY</span>
          <span>{oppState.graveyard.length}</span>
        </div>
      </div>

      {/* Chat */}
      <div className="chat-section">
        <h4 style={{ fontSize: "0.7rem", color: "#666", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "6px" }}>Chat</h4>
        <div className="chat-messages" ref={chatRef}>
          {chat.map((msg, i) => (
            <div key={i} className="chat-msg">
              <span className="sender">{msg.name}: </span>
              {msg.message}
            </div>
          ))}
        </div>
        <input
          className="chat-input"
          placeholder="Say something..."
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          onKeyDown={sendChat}
        />
      </div>
    </div>
  );
}

// ── Game Board ────────────────────────────────────────────────────────────────

function GameBoard({ gameId, seat, playerName }) {
  const [gameState, setGameState] = useState(null);
  const [gameInfo, setGameInfo] = useState(null);
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    socket.emit("join_game", { gameId, playerName, seat });

    socket.on("game_state", (state) => setGameState(state));
    socket.on("game_info", (info) => setGameInfo(info));
    socket.on("player_left", ({ name }) => {
      alert(`${name} has left the game.`);
    });
    socket.on("error", ({ message }) => alert(message));

    return () => {
      socket.off("game_state");
      socket.off("game_info");
      socket.off("player_left");
      socket.off("error");
    };
  }, [gameId, seat, playerName]);

  const onAction = useCallback((action) => {
    socket.emit("game_action", { gameId, action });
  }, [gameId]);

  const onChat = useCallback((message) => {
    socket.emit("game_action", { gameId, action: { type: "CHAT", message } });
  }, [gameId]);

  if (!gameState) {
    return <div className="waiting-banner">⚔️ Connecting to game...</div>;
  }

  const myState = seat === "A" ? gameState.playerA : gameState.playerB;
  const oppState = seat === "A" ? gameState.playerB : gameState.playerA;

  return (
    <div className="game-layout">
      <div className="board">
        {gameInfo?.status === "waiting" && (
          <div className="waiting-banner">⏳ Waiting for opponent to join...</div>
        )}
        <PlayerArea
          playerState={oppState}
          isMe={false}
          onAction={onAction}
          onPreview={setPreview}
          label="Opponent"
        />
        <PlayerArea
          playerState={myState}
          isMe={true}
          onAction={onAction}
          onPreview={setPreview}
          label="You"
        />
      </div>
      <SidePanel
        myState={myState}
        oppState={oppState}
        onAction={onAction}
        chat={gameState.chat}
        playerName={playerName}
        onChat={onChat}
        onPreview={setPreview}
      />
      {preview && preview.imageUrl && (
        <div className="card-preview">
          <img src={preview.imageUrl} alt={preview.name} />
        </div>
      )}
    </div>
  );
}

// ── Lobby ─────────────────────────────────────────────────────────────────────

function Lobby() {
  const [lobby, setLobby] = useState(null);
  const [playerName, setPlayerName] = useState("");
  const [joiningGame, setJoiningGame] = useState(null); // { gameId, seat }
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/api/lobby")
      .then((r) => r.json())
      .then(setLobby)
      .catch(() => setError("Could not connect to server."));

    const interval = setInterval(() => {
      fetch("/api/lobby").then((r) => r.json()).then(setLobby).catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const createGame = async (seat) => {
    if (!playerName.trim()) {
      alert("Please enter your name first!");
      return;
    }
    const resp = await fetch("/api/games", { method: "POST" });
    const { gameId } = await resp.json();
    setJoiningGame({ gameId, seat });
  };

  const joinGame = (gameId, seat) => {
    if (!playerName.trim()) {
      alert("Please enter your name first!");
      return;
    }
    setJoiningGame({ gameId, seat });
  };

  if (joiningGame) {
    return (
      <GameBoard
        gameId={joiningGame.gameId}
        seat={joiningGame.seat}
        playerName={playerName.trim()}
      />
    );
  }

  if (error) {
    return <div className="lobby"><p style={{ color: "#f87171" }}>{error}</p></div>;
  }

  if (!lobby) {
    return <div className="lobby"><p style={{ color: "#aaa" }}>Loading...</p></div>;
  }

  if (!lobby.weekLabel) {
    return (
      <div className="lobby">
        <h1>⚔️ Cube Clash</h1>
        <p className="subtitle">No decks have been set for this week yet. Check back after Friday's post!</p>
      </div>
    );
  }

  const waitingGames = lobby.games.filter((g) => g.status === "waiting" && g.playerCount < 2);
  const activeGames = lobby.games.filter((g) => g.status === "active");

  return (
    <div className="lobby">
      <h1>⚔️ Cube Clash</h1>
      <p className="subtitle">{lobby.weekLabel}</p>

      <input
        className="name-input"
        placeholder="Enter your name to play..."
        value={playerName}
        onChange={(e) => setPlayerName(e.target.value)}
      />

      <div className="deck-cards">
        <div className="deck-card" onClick={() => createGame("A")}>
          <h2>🅰️ Deck A</h2>
          <p>{lobby.deckA.drafter}'s Trophy Deck</p>
          <p className="drafter-tag">{lobby.deckA.name}</p>
        </div>
        <div className="deck-card" onClick={() => createGame("B")}>
          <h2>🅱️ Deck B</h2>
          <p>{lobby.deckB.drafter}'s Trophy Deck</p>
          <p className="drafter-tag">{lobby.deckB.name}</p>
        </div>
      </div>

      {waitingGames.length > 0 && (
        <div className="active-games">
          <h3>⏳ Waiting for opponent</h3>
          {waitingGames.map((g) => (
            <div key={g.gameId} className="game-row">
              <div>
                <div>Game {g.gameId}</div>
                <div className="status">1 player waiting</div>
              </div>
              <button className="join-btn" onClick={() => joinGame(g.gameId, g.playerCount === 0 ? "A" : "B")}>
                Join
              </button>
            </div>
          ))}
        </div>
      )}

      {activeGames.length > 0 && (
        <div className="active-games">
          <h3>⚔️ Active games ({activeGames.length})</h3>
          {activeGames.map((g) => (
            <div key={g.gameId} className="game-row">
              <div>Game {g.gameId}</div>
              <div className="status">In progress</div>
            </div>
          ))}
        </div>
      )}

      <p style={{ color: "#666", fontSize: "0.85rem", marginTop: "16px" }}>
        Click a deck to create a new game — share the page URL with your opponent to join!
      </p>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

function App() {
  return <Lobby />;
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
