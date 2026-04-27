const { useState, useEffect, useRef, useCallback } = React;

const socket = io();

const CARD_BACK = "https://cards.scryfall.io/normal/back/0/0/00000000-0000-0000-0000-000000000000.png?1562370455";

// ── Utility ───────────────────────────────────────────────────────────────────
function generateId() {
  return Math.random().toString(36).substring(2, 10);
}

function parseDecklist(text) {
  const cards = [];
  for (const line of text.trim().split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    const match = trimmed.match(/^(\d+)x?\s+(.+)$/);
    if (match) {
      const count = parseInt(match[1]);
      const name = match[2].trim();
      for (let i = 0; i < count; i++) cards.push({ name, imageUrl: null });
    } else {
      cards.push({ name: trimmed, imageUrl: null });
    }
  }
  return cards;
}

function cardsToText(cards) {
  if (!cards || cards.length === 0) return "";
  const counts = {};
  for (const c of cards) counts[c.name] = (counts[c.name] || 0) + 1;
  return Object.entries(counts).map(([name, n]) => `${n} ${name}`).join("\n");
}

async function fetchScryfallImages(cards) {
  const uniqueNames = [...new Set(cards.map(c => c.name))];
  const imageMap = {};
  const chunkSize = 75;
  for (let i = 0; i < uniqueNames.length; i += chunkSize) {
    const chunk = uniqueNames.slice(i, i + chunkSize);
    try {
      const resp = await fetch("https://api.scryfall.com/cards/collection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifiers: chunk.map(name => ({ name })) }),
      });
      const data = await resp.json();
      for (const card of (data.data || [])) {
        const name = card.name;
        const imageUrl = card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || null;
        if (imageUrl) {
          imageMap[name] = imageUrl;
          if (name.includes("//")) imageMap[name.split("//")[0].trim()] = imageUrl;
        }
      }
    } catch (e) { console.warn("Scryfall fetch failed:", e); }
    await new Promise(r => setTimeout(r, 100));
  }
  return cards.map(c => ({ ...c, imageUrl: imageMap[c.name] || imageMap[c.name?.split("//")[0]?.trim()] || null }));
}

// ── Context Menu ──────────────────────────────────────────────────────────────
function ContextMenu({ x, y, items, onClose }) {
  useEffect(() => {
    const h = (e) => {
      // Only close if clicking outside the menu
      if (!e.target.closest(".ctx-menu")) onClose();
    };
    // Use mousedown with a small delay so the menu renders first
    setTimeout(() => window.addEventListener("mousedown", h), 0);
    return () => window.removeEventListener("mousedown", h);
  }, [onClose]);

  return (
    <div className="ctx-menu" onMouseDown={e => e.stopPropagation()} style={{
      position: "fixed", left: Math.min(x, window.innerWidth - 200), top: Math.min(y, window.innerHeight - 300),
      background: "#16213e", border: "1px solid #555", borderRadius: 8, padding: 4,
      zIndex: 9999, minWidth: 190, boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
    }}>
      {items.map((item, i) =>
        item === "---" ? (
          <div key={i} style={{ borderTop: "1px solid #333", margin: "4px 0" }} />
        ) : (
          <div key={item.label}
            onMouseDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              item.action();
              onClose();
            }}
            style={{ padding: "8px 12px", cursor: "pointer", borderRadius: 4, fontSize: 13, color: "#e0e0e0", userSelect: "none" }}
            onMouseEnter={e => e.currentTarget.style.background = "#1a2a50"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}
          >{item.label}</div>
        )
      )}
    </div>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function Modal({ title, onClose, children, wide }) {
  // Fixed-size modal that doesn't resize when preview appears
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000,
    }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: "#16213e", border: "1px solid #444", borderRadius: 12,
        padding: 24, width: wide ? 680 : 400, maxWidth: "92vw",
        height: wide ? 520 : "auto", maxHeight: "85vh",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }} onMouseDown={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexShrink: 0 }}>
          <h3 style={{ color: "#ffd700", margin: 0 }}>{title}</h3>
          <button onMouseDown={onClose} style={{ background: "none", border: "none", color: "#aaa", fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {children}
        </div>
      </div>
    </div>
  );
}

// ── Card Preview (fixed, never causes reflow) ─────────────────────────────────
function CardPreview({ card }) {
  if (!card || !card.imageUrl) return null;
  return (
    <div style={{
      position: "fixed", bottom: 20, right: 230, width: 200,
      zIndex: 8000, pointerEvents: "none",
      filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.9))",
    }}>
      <img src={card.imageUrl} alt={card.name} style={{ width: "100%", borderRadius: 8 }} />
    </div>
  );
}

// ── Zone Viewer Modal ─────────────────────────────────────────────────────────
function ZoneViewer({ title, cards, onAction, zoneKey, onClose, readOnly }) {
  const [preview, setPreview] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);

  const menuItems = (card) => {
    const items = [
      { label: "✋ To hand", action: () => onAction({ type: "ZONE_TO_HAND", instanceId: card.instanceId, fromZone: zoneKey }) },
      { label: "⬆ To battlefield", action: () => onAction({ type: "ZONE_TO_BATTLEFIELD", instanceId: card.instanceId, fromZone: zoneKey }) },
      { label: "📚 To top of library", action: () => onAction({ type: "ZONE_TO_LIBRARY_TOP", instanceId: card.instanceId, fromZone: zoneKey }) },
      { label: "📚 To bottom of library", action: () => onAction({ type: "ZONE_TO_LIBRARY_BOTTOM", instanceId: card.instanceId, fromZone: zoneKey }) },
    ];
    if (zoneKey !== "graveyard") items.push({ label: "💀 To graveyard", action: () => onAction({ type: "ZONE_TO_GRAVEYARD", instanceId: card.instanceId, fromZone: zoneKey }) });
    if (zoneKey !== "exile") items.push({ label: "🚫 To exile", action: () => onAction({ type: "ZONE_TO_EXILE", instanceId: card.instanceId, fromZone: zoneKey }) });
    return items;
  };

  return (
    <Modal title={`${title} (${cards.length})`} onClose={onClose} wide>
      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />}
      <CardPreview card={preview} />
      <div style={{ display: "flex", gap: 16, flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 1, display: "flex", flexWrap: "wrap", gap: 8, overflowY: "auto", alignContent: "flex-start" }}>
          {cards.length === 0 && <p style={{ color: "#666", fontStyle: "italic" }}>Empty</p>}
          {cards.map(card => (
            <div key={card.instanceId}
              style={{ width: 80, height: 112, borderRadius: 4, cursor: readOnly ? "default" : "context-menu", flexShrink: 0 }}
              onMouseEnter={() => setPreview(card)}
              onMouseLeave={() => setPreview(null)}
              onContextMenu={e => {
                e.preventDefault();
                if (!readOnly) setContextMenu({ x: e.clientX, y: e.clientY, items: menuItems(card) });
              }}
            >
              {card.imageUrl
                ? <img src={card.imageUrl} alt={card.name} style={{ width: "100%", height: "100%", borderRadius: 4, objectFit: "cover" }} />
                : <div style={{ width: "100%", height: "100%", background: "#1e3a5f", border: "1px solid #2a5298", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#aaa", padding: 4, textAlign: "center" }}>{card.name}</div>
              }
            </div>
          ))}
        </div>
        {/* Fixed-width preview column — always present, just empty when no card hovered */}
        <div style={{ width: 160, flexShrink: 0 }}>
          {preview && preview.imageUrl && (
            <>
              <img src={preview.imageUrl} alt={preview.name} style={{ width: "100%", borderRadius: 6 }} />
              <p style={{ fontSize: 11, color: "#aaa", marginTop: 4, textAlign: "center" }}>{preview.name}</p>
              {!readOnly && <p style={{ fontSize: 10, color: "#666", textAlign: "center" }}>Right-click to move</p>}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── Library Viewer Modal ──────────────────────────────────────────────────────
function LibraryViewer({ cards, onAction, onClose }) {
  const [topN, setTopN] = useState(Math.min(7, cards.length));
  const [preview, setPreview] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const visible = cards.slice(0, topN);

  const menuItems = (card, idx) => [
    { label: "✋ To hand", action: () => onAction({ type: "LIBRARY_CARD_TO_HAND", index: idx }) },
    { label: "⬆ To battlefield", action: () => onAction({ type: "LIBRARY_CARD_TO_BATTLEFIELD", index: idx }) },
    { label: "⬆ To top of library", action: () => onAction({ type: "LIBRARY_CARD_TO_TOP", index: idx }) },
    { label: "⬇ To bottom", action: () => onAction({ type: "LIBRARY_CARD_TO_BOTTOM", index: idx }) },
    { label: "💀 To graveyard", action: () => onAction({ type: "LIBRARY_CARD_TO_GRAVEYARD", index: idx }) },
  ];

  return (
    <Modal title={`Library — Top ${topN} of ${cards.length}`} onClose={onClose} wide>
      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />}
      <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
        <label style={{ color: "#aaa", fontSize: 13, whiteSpace: "nowrap" }}>Show top:</label>
        <input type="range" min={1} max={Math.min(20, cards.length)} value={topN}
          onChange={e => setTopN(parseInt(e.target.value))} style={{ flex: 1 }} />
        <span style={{ color: "#ffd700", minWidth: 24 }}>{topN}</span>
      </div>
      <div style={{ display: "flex", gap: 16, flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 1, display: "flex", flexWrap: "wrap", gap: 8, overflowY: "auto", alignContent: "flex-start" }}>
          {visible.map((card, idx) => (
            <div key={card.instanceId}
              style={{ width: 80, height: 112, borderRadius: 4, cursor: "context-menu", flexShrink: 0, position: "relative" }}
              onMouseEnter={() => setPreview(card)}
              onMouseLeave={() => setPreview(null)}
              onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, items: menuItems(card, idx) }); }}
            >
              <div style={{ position: "absolute", top: -8, left: -8, background: "#ffd700", color: "#1a1a2e", borderRadius: "50%", width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: "bold", zIndex: 2 }}>{idx + 1}</div>
              {card.imageUrl
                ? <img src={card.imageUrl} alt={card.name} style={{ width: "100%", height: "100%", borderRadius: 4, objectFit: "cover" }} />
                : <div style={{ width: "100%", height: "100%", background: "#1e3a5f", border: "1px solid #2a5298", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#aaa", padding: 4, textAlign: "center" }}>{card.name}</div>
              }
            </div>
          ))}
        </div>
        <div style={{ width: 160, flexShrink: 0 }}>
          {preview && preview.imageUrl && (
            <>
              <img src={preview.imageUrl} alt={preview.name} style={{ width: "100%", borderRadius: 6 }} />
              <p style={{ fontSize: 11, color: "#aaa", marginTop: 4, textAlign: "center" }}>{preview.name}</p>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── Search Library Modal ──────────────────────────────────────────────────────
function SearchLibrary({ cards, onAction, onClose }) {
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const filtered = cards.map((card, realIdx) => ({ card, realIdx }))
    .filter(({ card }) => card.name.toLowerCase().includes(query.toLowerCase()));

  const menuItems = (card, realIdx) => [
    { label: "✋ To hand", action: () => { onAction({ type: "LIBRARY_CARD_TO_HAND", index: realIdx }); onClose(); } },
    { label: "⬆ To battlefield", action: () => { onAction({ type: "LIBRARY_CARD_TO_BATTLEFIELD", index: realIdx }); onClose(); } },
    { label: "⬆ To top of library", action: () => onAction({ type: "LIBRARY_CARD_TO_TOP", index: realIdx }) },
    { label: "⬇ To bottom", action: () => onAction({ type: "LIBRARY_CARD_TO_BOTTOM", index: realIdx }) },
    { label: "💀 To graveyard", action: () => { onAction({ type: "LIBRARY_CARD_TO_GRAVEYARD", index: realIdx }); onClose(); } },
  ];

  return (
    <Modal title={`Search Library (${cards.length} cards)`} onClose={onClose} wide>
      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />}
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by card name..." autoFocus
        style={{ width: "100%", background: "#0d1117", border: "1px solid #444", color: "#e0e0e0", padding: "8px 12px", borderRadius: 6, fontSize: 14, marginBottom: 12, fontFamily: "Georgia, serif", flexShrink: 0 }}
      />
      <div style={{ display: "flex", gap: 16, flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexWrap: "wrap", gap: 8, alignContent: "flex-start" }}>
          {filtered.map(({ card, realIdx }) => (
            <div key={card.instanceId}
              style={{ width: 80, height: 112, borderRadius: 4, cursor: "context-menu", flexShrink: 0 }}
              onMouseEnter={() => setPreview(card)}
              onMouseLeave={() => setPreview(null)}
              onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, items: menuItems(card, realIdx) }); }}
            >
              {card.imageUrl
                ? <img src={card.imageUrl} alt={card.name} style={{ width: "100%", height: "100%", borderRadius: 4, objectFit: "cover" }} />
                : <div style={{ width: "100%", height: "100%", background: "#1e3a5f", border: "1px solid #2a5298", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#aaa", padding: 4, textAlign: "center" }}>{card.name}</div>
              }
            </div>
          ))}
          {filtered.length === 0 && <p style={{ color: "#666", fontStyle: "italic" }}>No cards found</p>}
        </div>
        <div style={{ width: 160, flexShrink: 0 }}>
          {preview && preview.imageUrl && (
            <>
              <img src={preview.imageUrl} alt={preview.name} style={{ width: "100%", borderRadius: 6 }} />
              <p style={{ fontSize: 11, color: "#aaa", marginTop: 4, textAlign: "center" }}>{preview.name}</p>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── Create Token Modal ────────────────────────────────────────────────────────
function CreateToken({ onCreate, onClose }) {
  const [name, setName] = useState("");
  const [pt, setPt] = useState("1/1");
  const [desc, setDesc] = useState("");

  const inputStyle = { width: "100%", background: "#0d1117", border: "1px solid #444", color: "#e0e0e0", padding: "8px 12px", borderRadius: 6, fontSize: 14, fontFamily: "Georgia, serif" };

  return (
    <Modal title="Create Token" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label style={{ fontSize: 12, color: "#aaa", display: "block", marginBottom: 4 }}>Token name *</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Goblin, Treasure, Zombie..." autoFocus style={inputStyle} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: "#aaa", display: "block", marginBottom: 4 }}>Power/Toughness</label>
          <input value={pt} onChange={e => setPt(e.target.value)} placeholder="e.g. 1/1" style={inputStyle} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: "#aaa", display: "block", marginBottom: 4 }}>Type / abilities</label>
          <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="e.g. Artifact, Flying, Haste" style={inputStyle} />
        </div>
        <button
          onMouseDown={() => { if (name.trim()) { onCreate({ name: name.trim(), pt, desc }); onClose(); } }}
          style={{ background: "#ffd700", color: "#1a1a2e", border: "none", padding: "10px 20px", borderRadius: 6, cursor: "pointer", fontWeight: "bold", fontSize: 14, fontFamily: "Georgia, serif", marginTop: 4 }}>
          ✨ Create Token
        </button>
      </div>
    </Modal>
  );
}

// ── Battlefield Card ──────────────────────────────────────────────────────────
function BattlefieldCard({ card, onAction, isMe, onPreview, cardSize }) {
  const [dragging, setDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const cardRef = useRef(null);
  const w = cardSize;
  const h = Math.round(cardSize * 1.4);

  const handleMouseDown = (e) => {
    if (e.button !== 0 || !isMe) return;
    e.preventDefault();
    const rect = cardRef.current.getBoundingClientRect();
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => {
      const parent = cardRef.current?.parentElement?.getBoundingClientRect();
      if (!parent) return;
      onAction({ type: "MOVE_CARD", instanceId: card.instanceId, x: e.clientX - parent.left - dragOffset.current.x, y: e.clientY - parent.top - dragOffset.current.y });
    };
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [dragging, card, onAction]);

  const handleContextMenu = (e) => {
    e.preventDefault();
    if (!isMe) return;
    const items = [
      { label: card.tapped ? "↺ Untap" : "↷ Tap", action: () => onAction({ type: "TAP_CARD", instanceId: card.instanceId }) },
      { label: card.faceUp ? "🔽 Flip face down" : "🔼 Flip face up", action: () => onAction({ type: "FLIP_CARD", instanceId: card.instanceId }) },
      "---",
      { label: "✋ Return to hand", action: () => onAction({ type: "BF_TO_HAND", instanceId: card.instanceId }) },
      { label: "📚 To top of library", action: () => onAction({ type: "BF_TO_LIBRARY_TOP", instanceId: card.instanceId }) },
      { label: "📚 To bottom of library", action: () => onAction({ type: "BF_TO_LIBRARY_BOTTOM", instanceId: card.instanceId }) },
      { label: "💀 To graveyard", action: () => onAction({ type: "MOVE_TO_GRAVEYARD", instanceId: card.instanceId }) },
      { label: "🚫 Exile", action: () => onAction({ type: "MOVE_TO_EXILE", instanceId: card.instanceId }) },
      "---",
      { label: "🔮 Clone this card", action: () => onAction({ type: "CLONE_CARD", instanceId: card.instanceId }) },
      { label: "+ Add counter", action: () => onAction({ type: "ADD_COUNTER", instanceId: card.instanceId }) },
      { label: "− Remove counter", action: () => onAction({ type: "REMOVE_COUNTER", instanceId: card.instanceId }) },
    ];
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  const showFaceUp = card.faceUp && (card.imageUrl || card.isToken);

  return (
    <>
      <div ref={cardRef}
        style={{
          position: "absolute", left: card.x || 0, top: card.y || 0,
          width: w, height: h, borderRadius: 4,
          cursor: dragging ? "grabbing" : (isMe ? "grab" : "default"),
          userSelect: "none",
          transform: card.tapped ? "rotate(90deg)" : "none",
          zIndex: dragging ? 100 : 5,
          outline: card.isToken ? "2px solid #9b59b6" : "none",
        }}
        onMouseDown={handleMouseDown}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => onPreview(card)}
        onMouseLeave={() => onPreview(null)}
      >
        {card.isToken ? (
          <div style={{ width: "100%", height: "100%", background: "linear-gradient(135deg, #2d1b4e, #4a2080)", border: "2px solid #9b59b6", borderRadius: 4, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 4 }}>
            <div style={{ fontSize: Math.max(8, cardSize / 8), color: "#e0d0ff", fontWeight: "bold", textAlign: "center" }}>{card.name}</div>
            {card.pt && <div style={{ fontSize: Math.max(7, cardSize / 9), color: "#c0a0ff", marginTop: 2 }}>{card.pt}</div>}
            {card.desc && <div style={{ fontSize: Math.max(6, cardSize / 10), color: "#a080df", marginTop: 1, textAlign: "center" }}>{card.desc}</div>}
          </div>
        ) : showFaceUp ? (
          <img src={card.imageUrl} alt={card.name} draggable={false} style={{ width: "100%", height: "100%", borderRadius: 4, objectFit: "cover" }} />
        ) : (
          // Face down — show card back
          <img src={CARD_BACK} alt="Card back" draggable={false} style={{ width: "100%", height: "100%", borderRadius: 4, objectFit: "cover" }} />
        )}
        {card.counters > 0 && (
          <div style={{ position: "absolute", bottom: -6, right: -6, background: "#ffd700", color: "#1a1a2e", borderRadius: "50%", width: 18, height: 18, fontSize: 10, fontWeight: "bold", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 11 }}>+{card.counters}</div>
        )}
      </div>
      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />}
    </>
  );
}

// ── Player Area ───────────────────────────────────────────────────────────────
function PlayerArea({ playerState, isMe, onAction, onPreview, label, cardSize }) {
  return (
    <div style={{ flex: 1, position: "relative", borderBottom: "2px solid #333", overflow: "hidden", background: isMe ? "#111827" : "#0d1117" }}>
      <div style={{ position: "absolute", top: 8, left: 12, fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1, zIndex: 10 }}>
        {label} — {playerState.drafter}
      </div>
      {playerState.battlefield.map(card => (
        <BattlefieldCard key={card.instanceId} card={card} onAction={isMe ? onAction : () => {}} isMe={isMe} onPreview={onPreview} cardSize={cardSize} />
      ))}
    </div>
  );
}

// ── Side Panel ────────────────────────────────────────────────────────────────
function SidePanel({ myState, oppState, onAction, chat, playerName, onChat, cardSize, setCardSize }) {
  const [chatInput, setChatInput] = useState("");
  const [modal, setModal] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const chatRef = useRef(null);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [chat]);

  const sendChat = (e) => {
    if (e.key === "Enter" && chatInput.trim()) { onChat(chatInput.trim()); setChatInput(""); }
  };

  const handCardMenu = (card) => [
    { label: "⬆ Play to battlefield", action: () => onAction({ type: "PLAY_CARD", instanceId: card.instanceId, x: 80 + Math.random() * 200, y: 40 + Math.random() * 80 }) },
    { label: card.faceUp ? "🔽 Flip face down" : "🔼 Flip face up", action: () => onAction({ type: "FLIP_CARD", instanceId: card.instanceId }) },
    { label: "💀 Discard", action: () => onAction({ type: "DISCARD_CARD", instanceId: card.instanceId }) },
    { label: "📚 To top of library", action: () => onAction({ type: "HAND_TO_LIBRARY_TOP", instanceId: card.instanceId }) },
    { label: "📚 To bottom of library", action: () => onAction({ type: "HAND_TO_LIBRARY_BOTTOM", instanceId: card.instanceId }) },
  ];

  const btn = (label, action) => (
    <button onMouseDown={action} style={{
      background: "#16213e", border: "1px solid #444", color: "#e0e0e0",
      padding: "5px 8px", borderRadius: 5, cursor: "pointer", fontSize: 11,
      fontFamily: "Georgia, serif", width: "100%", textAlign: "left", marginBottom: 3,
    }}
      onMouseEnter={e => { e.currentTarget.style.background = "#1a2a50"; e.currentTarget.style.borderColor = "#ffd700"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "#16213e"; e.currentTarget.style.borderColor = "#444"; }}
    >{label}</button>
  );

  const [handPreview, setHandPreview] = useState(null);

  return (
    <div style={{ width: 210, background: "#0d1117", borderLeft: "1px solid #333", display: "flex", flexDirection: "column", padding: 10, gap: 8, overflowY: "auto" }}>
      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />}
      {handPreview && <CardPreview card={handPreview} />}

      {modal === "graveyard" && <ZoneViewer title="My Graveyard" cards={myState.graveyard} onAction={onAction} zoneKey="graveyard" onClose={() => setModal(null)} />}
      {modal === "exile" && <ZoneViewer title="My Exile" cards={myState.exile} onAction={onAction} zoneKey="exile" onClose={() => setModal(null)} />}
      {modal === "opp-graveyard" && <ZoneViewer title="Opp Graveyard" cards={oppState.graveyard} onAction={() => {}} zoneKey="graveyard" onClose={() => setModal(null)} readOnly />}
      {modal === "library" && <LibraryViewer cards={myState.library} onAction={onAction} onClose={() => setModal(null)} />}
      {modal === "search" && <SearchLibrary cards={myState.library} onAction={onAction} onClose={() => setModal(null)} />}
      {modal === "token" && <CreateToken onCreate={(t) => onAction({ type: "CREATE_TOKEN", ...t, x: 100, y: 50 })} onClose={() => setModal(null)} />}

      {/* Life */}
      <div>
        <div style={{ fontSize: 9, color: "#666", textTransform: "uppercase", letterSpacing: 1, marginBottom: 3 }}>My Life</div>
        <div style={{ textAlign: "center", fontSize: 26, color: "#ffd700", fontWeight: "bold" }}>{myState.life}</div>
        <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 3 }}>
          <button onMouseDown={() => onAction({ type: "SET_LIFE", life: myState.life + 1 })} style={{ background: "#16213e", border: "1px solid #444", color: "#e0e0e0", width: 30, height: 30, borderRadius: 5, cursor: "pointer", fontSize: 16 }}>+</button>
          <button onMouseDown={() => onAction({ type: "SET_LIFE", life: myState.life - 1 })} style={{ background: "#16213e", border: "1px solid #444", color: "#e0e0e0", width: 30, height: 30, borderRadius: 5, cursor: "pointer", fontSize: 16 }}>−</button>
        </div>
        <div style={{ textAlign: "center", fontSize: 11, color: "#666", marginTop: 3 }}>Opp: <span style={{ color: "#aaa" }}>{oppState.life}</span></div>
      </div>

      {/* Actions */}
      <div>
        <div style={{ fontSize: 9, color: "#666", textTransform: "uppercase", letterSpacing: 1, marginBottom: 3 }}>Actions</div>
        {btn(`📚 Draw (${myState.library.length} left)`, () => onAction({ type: "DRAW_CARD" }))}
        {btn("↺ Untap all", () => onAction({ type: "UNTAP_ALL" }))}
        {btn("🔀 Shuffle library", () => onAction({ type: "SHUFFLE_LIBRARY" }))}
        {btn("🔍 Search library", () => setModal("search"))}
        {btn("👁 View top of library", () => setModal("library"))}
        {btn("✨ Create token", () => setModal("token"))}
      </div>

      {/* Hand */}
      <div>
        <div style={{ fontSize: 9, color: "#666", textTransform: "uppercase", letterSpacing: 1, marginBottom: 3 }}>Hand ({myState.hand.length})</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
          {myState.hand.map(card => (
            <div key={card.instanceId}
              style={{ width: 44, height: 62, borderRadius: 3, cursor: "context-menu", flexShrink: 0 }}
              onMouseEnter={() => setHandPreview(card)}
              onMouseLeave={() => setHandPreview(null)}
              onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, items: handCardMenu(card) }); }}
              onMouseDown={() => onAction({ type: "PLAY_CARD", instanceId: card.instanceId, x: 80 + Math.random() * 200, y: 40 + Math.random() * 80 })}
            >
              {card.imageUrl
                ? <img src={card.imageUrl} alt={card.name} draggable={false} style={{ width: "100%", height: "100%", borderRadius: 3, objectFit: "cover" }} />
                : <div style={{ width: "100%", height: "100%", background: "#1e3a5f", border: "1px solid #2a5298", borderRadius: 3, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 7, color: "#aaa", padding: 2, textAlign: "center" }}>{card.name}</div>
              }
            </div>
          ))}
        </div>
      </div>

      {/* Zones */}
      <div>
        <div style={{ fontSize: 9, color: "#666", textTransform: "uppercase", letterSpacing: 1, marginBottom: 3 }}>Zones</div>
        {[["💀 Graveyard", myState.graveyard.length, "graveyard"], ["🚫 Exile", myState.exile.length, "exile"], ["👁 Opp GY", oppState.graveyard.length, "opp-graveyard"]].map(([label, count, key]) => (
          <div key={key} onMouseDown={() => setModal(key)}
            style={{ background: "#16213e", borderRadius: 5, padding: "5px 8px", fontSize: 11, display: "flex", justifyContent: "space-between", cursor: "pointer", marginBottom: 3, border: "1px solid transparent" }}
            onMouseEnter={e => e.currentTarget.style.borderColor = "#ffd700"}
            onMouseLeave={e => e.currentTarget.style.borderColor = "transparent"}
          >
            <span>{label}</span><span style={{ color: "#ffd700" }}>{count}</span>
          </div>
        ))}
      </div>

      {/* Card size */}
      <div>
        <div style={{ fontSize: 9, color: "#666", textTransform: "uppercase", letterSpacing: 1, marginBottom: 3 }}>Card Size</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="range" min={40} max={120} value={cardSize} onChange={e => setCardSize(parseInt(e.target.value))} style={{ flex: 1 }} />
          <span style={{ fontSize: 10, color: "#aaa", minWidth: 20 }}>{cardSize}</span>
        </div>
      </div>

      {/* Chat */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ fontSize: 9, color: "#666", textTransform: "uppercase", letterSpacing: 1, marginBottom: 3 }}>Chat</div>
        <div ref={chatRef} style={{ flex: 1, overflowY: "auto", background: "#0a0f1a", borderRadius: 5, padding: 6, marginBottom: 5, minHeight: 50, maxHeight: 100 }}>
          {chat.map((msg, i) => (
            <div key={i} style={{ fontSize: 11, marginBottom: 2 }}>
              <span style={{ color: "#ffd700" }}>{msg.name}: </span>{msg.message}
            </div>
          ))}
        </div>
        <input placeholder="Chat..." value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={sendChat}
          style={{ background: "#16213e", border: "1px solid #444", color: "#e0e0e0", padding: "4px 8px", borderRadius: 4, fontSize: 11, width: "100%", fontFamily: "Georgia, serif" }} />
      </div>

      {/* Concede */}
      <button onMouseDown={() => { if (window.confirm("Concede this game?")) onAction({ type: "CONCEDE" }); }}
        style={{ background: "transparent", border: "1px solid #7f1d1d", color: "#ef4444", padding: "5px 8px", borderRadius: 5, cursor: "pointer", fontSize: 11, fontFamily: "Georgia, serif" }}>
        🏳 Concede
      </button>
    </div>
  );
}

// ── Game Board ────────────────────────────────────────────────────────────────
function GameBoard({ gameId, seat, playerName }) {
  const [gameState, setGameState] = useState(null);
  const [gameInfo, setGameInfo] = useState(null);
  const [preview, setPreview] = useState(null);
  const [cardSize, setCardSize] = useState(70);
  const [gameOver, setGameOver] = useState(null);

  useEffect(() => {
    socket.emit("join_game", { gameId, playerName, seat });
    socket.on("game_state", setGameState);
    socket.on("game_info", setGameInfo);
    socket.on("player_left", ({ name }) => alert(`${name} has left the game.`));
    socket.on("game_over", ({ reason }) => setGameOver(reason));
    socket.on("error", ({ message }) => alert(message));
    return () => { socket.off("game_state"); socket.off("game_info"); socket.off("player_left"); socket.off("game_over"); socket.off("error"); };
  }, [gameId, seat, playerName]);

  const onAction = useCallback((action) => {
    socket.emit("game_action", { gameId, action });
  }, [gameId]);

  const onChat = useCallback((message) => {
    socket.emit("game_action", { gameId, action: { type: "CHAT", message } });
  }, [gameId]);

  if (gameOver) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", flexDirection: "column", gap: 16 }}>
      <h1 style={{ color: "#ffd700" }}>⚔️ Game Over</h1>
      <p style={{ color: "#aaa" }}>{gameOver}</p>
      <button onMouseDown={() => window.location.reload()} style={{ background: "#ffd700", color: "#1a1a2e", border: "none", padding: "10px 24px", borderRadius: 8, cursor: "pointer", fontWeight: "bold", fontFamily: "Georgia, serif" }}>Return to Lobby</button>
    </div>
  );

  if (!gameState) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: "#ffd700", fontStyle: "italic" }}>
      ⚔️ Connecting to game...
    </div>
  );

  const myState = seat === "A" ? gameState.playerA : gameState.playerB;
  const oppState = seat === "A" ? gameState.playerB : gameState.playerA;

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {gameInfo?.status === "waiting" && (
          <div style={{ textAlign: "center", padding: 10, color: "#ffd700", fontStyle: "italic", background: "#0d1117", borderBottom: "1px solid #333", fontSize: 12 }}>
            ⏳ Waiting for opponent — share this page URL with them!
          </div>
        )}
        <PlayerArea playerState={oppState} isMe={false} onAction={onAction} onPreview={setPreview} label="Opponent" cardSize={cardSize} />
        <PlayerArea playerState={myState} isMe={true} onAction={onAction} onPreview={setPreview} label="You" cardSize={cardSize} />
      </div>
      <SidePanel myState={myState} oppState={oppState} onAction={onAction} chat={gameState.chat} playerName={playerName} onChat={onChat} cardSize={cardSize} setCardSize={setCardSize} />
      <CardPreview card={preview} />
    </div>
  );
}

// ── Decklist Editor ───────────────────────────────────────────────────────────
function DecklistEditor({ deck, seat, gameId, onReady }) {
  const [text, setText] = useState(() => cardsToText(deck.cards));
  const [loading, setLoading] = useState(false);

  const handleReady = async () => {
    setLoading(true);
    const parsedCards = parseDecklist(text);
    const withImages = await fetchScryfallImages(parsedCards);
    socket.emit("update_deck", { gameId, seat, cards: withImages });
    setLoading(false);
    onReady(withImages);
  };

  return (
    <div style={{ maxWidth: 600, margin: "40px auto", padding: "0 20px" }}>
      <h1 style={{ color: "#ffd700", textAlign: "center", marginBottom: 8 }}>⚔️ Cube Clash</h1>
      <h2 style={{ color: "#e0e0e0", textAlign: "center", marginBottom: 4 }}>
        {seat === "A" ? "🅰️" : "🅱️"} {deck.drafter}'s Deck
      </h2>
      <p style={{ color: "#aaa", textAlign: "center", marginBottom: 20, fontSize: 13 }}>
        Review and edit your decklist before starting. Add missing lands or fix any errors.
      </p>
      <textarea value={text} onChange={e => setText(e.target.value)}
        style={{ width: "100%", height: 400, background: "#16213e", border: "1px solid #444", color: "#e0e0e0", padding: 12, borderRadius: 8, fontSize: 13, fontFamily: "monospace", lineHeight: 1.6, resize: "vertical" }}
      />
      <div style={{ marginTop: 8, color: "#666", fontSize: 12, marginBottom: 16 }}>
        Format: "4 Island", "1 Lightning Bolt" — one card per line
      </div>
      <button onMouseDown={handleReady} disabled={loading}
        style={{ width: "100%", background: loading ? "#444" : "#ffd700", color: "#1a1a2e", border: "none", padding: "14px 20px", borderRadius: 8, cursor: loading ? "default" : "pointer", fontWeight: "bold", fontSize: 16, fontFamily: "Georgia, serif" }}>
        {loading ? "⏳ Loading card images..." : "⚔️ Ready to Play!"}
      </button>
    </div>
  );
}

// ── Lobby ─────────────────────────────────────────────────────────────────────
function Lobby() {
  const [lobby, setLobby] = useState(null);
  const [playerName, setPlayerName] = useState("");
  const [editingDeck, setEditingDeck] = useState(null);
  const [activeGame, setActiveGame] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const load = () => fetch("/api/lobby").then(r => r.json()).then(setLobby).catch(() => setError("Could not connect to server."));
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  const createGame = async (seat) => {
    if (!playerName.trim()) { alert("Please enter your name first!"); return; }
    const resp = await fetch("/api/games", { method: "POST" });
    const { gameId } = await resp.json();
    const deckData = seat === "A" ? lobby.deckA : lobby.deckB;
    setEditingDeck({ deck: deckData, seat, gameId });
  };

  const joinGame = (gameId, seat) => {
    if (!playerName.trim()) { alert("Please enter your name first!"); return; }
    const deckData = seat === "A" ? lobby.deckA : lobby.deckB;
    setEditingDeck({ deck: deckData, seat, gameId });
  };

  const handleReady = () => {
    setActiveGame({ gameId: editingDeck.gameId, seat: editingDeck.seat });
  };

  if (activeGame) return <GameBoard gameId={activeGame.gameId} seat={activeGame.seat} playerName={playerName.trim()} />;
  if (editingDeck) return <DecklistEditor deck={editingDeck.deck} seat={editingDeck.seat} gameId={editingDeck.gameId} onReady={handleReady} />;
  if (error) return <div style={{ textAlign: "center", padding: 40, color: "#f87171" }}>{error}</div>;
  if (!lobby) return <div style={{ textAlign: "center", padding: 40, color: "#aaa" }}>Loading...</div>;

  if (!lobby.weekLabel) return (
    <div style={{ maxWidth: 600, margin: "0 auto", padding: 40, textAlign: "center" }}>
      <h1 style={{ color: "#ffd700", fontSize: "2.5rem", marginBottom: 12 }}>⚔️ Cube Clash</h1>
      <p style={{ color: "#aaa", fontStyle: "italic" }}>No decks have been set for this week yet. Check back after Friday's post!</p>
    </div>
  );

  const waitingGames = lobby.games.filter(g => g.status === "waiting" && g.playerCount < 2);
  const activeGames = lobby.games.filter(g => g.status === "active");

  return (
    <div style={{ maxWidth: 700, margin: "0 auto", padding: "40px 20px", textAlign: "center" }}>
      <h1 style={{ fontSize: "2.5rem", color: "#ffd700", marginBottom: 8, textShadow: "0 0 20px rgba(255,215,0,0.4)" }}>⚔️ Cube Clash</h1>
      <p style={{ color: "#aaa", marginBottom: 32, fontStyle: "italic" }}>{lobby.weekLabel}</p>

      <input placeholder="Enter your name to play..." value={playerName} onChange={e => setPlayerName(e.target.value)}
        style={{ background: "#16213e", border: "1px solid #444", color: "#e0e0e0", padding: "10px 16px", borderRadius: 6, fontSize: 15, fontFamily: "Georgia, serif", marginBottom: 24, width: "100%" }} />

      <div style={{ display: "flex", gap: 20, justifyContent: "center", marginBottom: 32 }}>
        {[["A", lobby.deckA], ["B", lobby.deckB]].map(([seat, deck]) => (
          <div key={seat} onMouseDown={() => createGame(seat)}
            style={{ background: "#16213e", border: "2px solid #ffd700", borderRadius: 12, padding: 24, width: 280, cursor: "pointer" }}
            onMouseEnter={e => { e.currentTarget.style.background = "#1a2a50"; e.currentTarget.style.transform = "translateY(-4px)"; e.currentTarget.style.boxShadow = "0 8px 24px rgba(255,215,0,0.2)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "#16213e"; e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "none"; }}
          >
            <h2 style={{ color: "#ffd700", marginBottom: 8 }}>{seat === "A" ? "🅰️" : "🅱️"} Deck {seat}</h2>
            <p style={{ color: "#e0e0e0" }}>{deck?.drafter}'s Trophy Deck</p>
            <p style={{ color: "#aaa", fontSize: 13, marginTop: 4 }}>{deck?.name}</p>
          </div>
        ))}
      </div>

      {waitingGames.length > 0 && (
        <div style={{ background: "#16213e", borderRadius: 12, padding: 20, marginBottom: 16, textAlign: "left" }}>
          <h3 style={{ color: "#ffd700", marginBottom: 12 }}>⏳ Waiting for opponent</h3>
          {waitingGames.map(g => (
            <div key={g.gameId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 10, background: "#1a1a2e", borderRadius: 8, marginBottom: 8 }}>
              <div><div style={{ fontSize: 14 }}>Game {g.gameId}</div><div style={{ fontSize: 12, color: "#aaa" }}>1 player waiting</div></div>
              <button onMouseDown={() => joinGame(g.gameId, "B")}
                style={{ background: "#ffd700", color: "#1a1a2e", border: "none", padding: "6px 16px", borderRadius: 6, cursor: "pointer", fontWeight: "bold", fontFamily: "Georgia, serif" }}>Join</button>
            </div>
          ))}
        </div>
      )}

      {activeGames.length > 0 && (
        <div style={{ background: "#16213e", borderRadius: 12, padding: 20, marginBottom: 16, textAlign: "left" }}>
          <h3 style={{ color: "#ffd700", marginBottom: 12 }}>⚔️ Active games ({activeGames.length})</h3>
          {activeGames.map(g => (
            <div key={g.gameId} style={{ display: "flex", justifyContent: "space-between", padding: 10, background: "#1a1a2e", borderRadius: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 14 }}>Game {g.gameId}</div>
              <div style={{ fontSize: 12, color: "#aaa" }}>In progress</div>
            </div>
          ))}
        </div>
      )}

      <p style={{ color: "#555", fontSize: 13 }}>Click a deck to create a new game — share the URL with your opponent to join!</p>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<Lobby />);
