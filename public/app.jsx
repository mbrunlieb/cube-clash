const { useState, useEffect, useRef, useCallback } = React;

const socket = io();

const CARD_BACK = "https://cards.scryfall.io/normal/back/0/0/00000000-0000-0000-0000-000000000000.png?1562370455";

// ── Utility ───────────────────────────────────────────────────────────────────
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
  for (const c of cards) {
    if (c && c.name) counts[c.name] = (counts[c.name] || 0) + 1;
  }
  return Object.entries(counts).map(([name, n]) => `${n} ${name}`).join("\n");
}

async function fetchScryfallImages(cards) {
  const uniqueNames = [...new Set(cards.map(c => c.name))];
  const imageMap = {};
  for (let i = 0; i < uniqueNames.length; i += 75) {
    const chunk = uniqueNames.slice(i, i + 75);
    try {
      const resp = await fetch("https://api.scryfall.com/cards/collection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifiers: chunk.map(name => ({ name })) }),
      });
      const data = await resp.json();
      for (const card of (data.data || [])) {
        const url = card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || null;
        if (url) {
          imageMap[card.name] = url;
          if (card.name.includes("//")) imageMap[card.name.split("//")[0].trim()] = url;
        }
      }
    } catch (e) { console.warn("Scryfall:", e); }
    await new Promise(r => setTimeout(r, 110));
  }
  return cards.map(c => ({ ...c, imageUrl: imageMap[c.name] || imageMap[c.name?.split("//")[0]?.trim()] || null }));
}

// ── Reliable Context Menu (overlay approach) ──────────────────────────────────
// A transparent full-screen backdrop closes the menu on outside click.
// Items use onPointerDown to fire before the backdrop's onClick.
function ContextMenu({ x, y, items, onClose }) {
  const menuRef = useRef(null);
  const safeX = Math.min(x, window.innerWidth - 210);
  const safeY = Math.min(y, window.innerHeight - items.length * 36 - 20);

  return (
    <>
      {/* Transparent backdrop — clicking it closes the menu */}
      <div style={{ position: "fixed", inset: 0, zIndex: 8000 }} onClick={onClose} />
      {/* Menu on top of backdrop */}
      <div ref={menuRef} style={{
        position: "fixed", left: safeX, top: safeY,
        background: "#1a2035", border: "1px solid #555", borderRadius: 8,
        padding: 4, zIndex: 8001, minWidth: 195,
        boxShadow: "0 8px 28px rgba(0,0,0,0.7)",
      }}>
        {items.map((item, i) =>
          item === "---"
            ? <div key={i} style={{ borderTop: "1px solid #333", margin: "3px 0" }} />
            : <div key={item.label}
                style={{ padding: "7px 12px", cursor: "pointer", borderRadius: 4, fontSize: 13, color: "#e0e0e0", userSelect: "none" }}
                onMouseEnter={e => e.currentTarget.style.background = "#263052"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                onPointerDown={e => { e.stopPropagation(); item.action(); onClose(); }}
              >{item.label}</div>
        )}
      </div>
    </>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function Modal({ title, onClose, children, wide }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 5000 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: "#16213e", border: "1px solid #444", borderRadius: 12, padding: 24,
        width: wide ? 700 : 420, maxWidth: "94vw",
        height: wide ? 530 : "auto", maxHeight: "88vh",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexShrink: 0 }}>
          <h3 style={{ color: "#ffd700", margin: 0 }}>{title}</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#aaa", fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>{children}</div>
      </div>
    </div>
  );
}

// ── Card Preview (fixed, never causes reflow) ─────────────────────────────────
function CardPreview({ card }) {
  if (!card || !card.imageUrl) return null;
  return (
    <div style={{ position: "fixed", bottom: 100, right: 225, width: 195, zIndex: 7000, pointerEvents: "none", filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.9))" }}>
      <img src={card.imageUrl} alt={card.name} style={{ width: "100%", borderRadius: 8 }} />
    </div>
  );
}

// ── Face-down card appearance ─────────────────────────────────────────────────
function CardBack({ w, h }) {
  return (
    <div style={{
      width: w, height: h, borderRadius: 6,
      background: "linear-gradient(135deg, #1a3a6e 0%, #0d1f3c 50%, #1a3a6e 100%)",
      border: "3px solid #c8a84b",
      boxSizing: "border-box",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        width: "75%", height: "75%", borderRadius: 4,
        border: "2px solid #c8a84b",
        background: "radial-gradient(ellipse at center, #1e4080 0%, #0a1628 100%)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: Math.max(10, w / 5), color: "#c8a84b",
      }}>✦</div>
    </div>
  );
}

// ── Zone/Library Card Grid (shared) ──────────────────────────────────────────
function CardGrid({ cards, onMenuItems, readOnly, extraPanelWidth }) {
  const [preview, setPreview] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const panelW = extraPanelWidth || 165;

  return (
    <div style={{ display: "flex", gap: 14, flex: 1, overflow: "hidden" }}>
      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />}
      <div style={{ flex: 1, display: "flex", flexWrap: "wrap", gap: 7, overflowY: "auto", alignContent: "flex-start" }}>
        {cards.length === 0 && <p style={{ color: "#666", fontStyle: "italic" }}>Empty</p>}
        {cards.map((card, idx) => (
          <div key={card.instanceId || idx}
            style={{ width: 80, height: 112, borderRadius: 4, cursor: readOnly ? "default" : "context-menu", flexShrink: 0 }}
            onMouseEnter={() => setPreview(card)}
            onMouseLeave={() => setPreview(null)}
            onContextMenu={e => { e.preventDefault(); if (!readOnly && onMenuItems) setContextMenu({ x: e.clientX, y: e.clientY, items: onMenuItems(card, idx) }); }}
          >
            {card.imageUrl
              ? <img src={card.imageUrl} alt={card.name} style={{ width: "100%", height: "100%", borderRadius: 4, objectFit: "cover" }} />
              : <div style={{ width: "100%", height: "100%", background: "#1e3a5f", border: "1px solid #2a5298", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#aaa", padding: 4, textAlign: "center" }}>{card.name}</div>
            }
          </div>
        ))}
      </div>
      {/* Fixed-width preview column — layout never shifts */}
      <div style={{ width: panelW, flexShrink: 0 }}>
        {preview && preview.imageUrl && (
          <>
            <img src={preview.imageUrl} alt={preview.name} style={{ width: "100%", borderRadius: 6 }} />
            <p style={{ fontSize: 11, color: "#aaa", marginTop: 4, textAlign: "center" }}>{preview.name}</p>
            {!readOnly && <p style={{ fontSize: 10, color: "#555", textAlign: "center" }}>Right-click to move</p>}
          </>
        )}
      </div>
    </div>
  );
}

// ── Zone Viewer ───────────────────────────────────────────────────────────────
function ZoneViewer({ title, cards, onAction, zoneKey, onClose, readOnly }) {
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
      <CardGrid cards={cards} onMenuItems={readOnly ? null : menuItems} readOnly={readOnly} />
    </Modal>
  );
}

// ── Library Viewer ────────────────────────────────────────────────────────────
function LibraryViewer({ cards, onAction, onClose }) {
  const [topN, setTopN] = useState(Math.min(7, cards.length));
  const visible = cards.slice(0, topN).map((c, i) => ({ ...c, _libIdx: i }));

  const menuItems = (card, idx) => [
    { label: "✋ To hand", action: () => onAction({ type: "LIBRARY_CARD_TO_HAND", index: card._libIdx }) },
    { label: "⬆ To battlefield", action: () => onAction({ type: "LIBRARY_CARD_TO_BATTLEFIELD", index: card._libIdx }) },
    { label: "⬆ To top", action: () => onAction({ type: "LIBRARY_CARD_TO_TOP", index: card._libIdx }) },
    { label: "⬇ To bottom", action: () => onAction({ type: "LIBRARY_CARD_TO_BOTTOM", index: card._libIdx }) },
    { label: "💀 To graveyard", action: () => onAction({ type: "LIBRARY_CARD_TO_GRAVEYARD", index: card._libIdx }) },
  ];

  return (
    <Modal title={`Library — Top ${topN} of ${cards.length}`} onClose={onClose} wide>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexShrink: 0 }}>
        <label style={{ color: "#aaa", fontSize: 13, whiteSpace: "nowrap" }}>Show top:</label>
        <input type="range" min={1} max={Math.min(20, cards.length)} value={topN} onChange={e => setTopN(+e.target.value)} style={{ flex: 1 }} />
        <span style={{ color: "#ffd700", minWidth: 22 }}>{topN}</span>
      </div>
      <CardGrid cards={visible} onMenuItems={menuItems} />
    </Modal>
  );
}

// ── Search Library ────────────────────────────────────────────────────────────
function SearchLibrary({ cards, onAction, onClose }) {
  const [query, setQuery] = useState("");
  const filtered = cards.map((c, i) => ({ ...c, _libIdx: i }))
    .filter(c => c.name.toLowerCase().includes(query.toLowerCase()));

  const menuItems = (card) => [
    { label: "✋ To hand", action: () => { onAction({ type: "LIBRARY_CARD_TO_HAND", index: card._libIdx }); onClose(); } },
    { label: "⬆ To battlefield", action: () => { onAction({ type: "LIBRARY_CARD_TO_BATTLEFIELD", index: card._libIdx }); onClose(); } },
    { label: "⬆ To top", action: () => onAction({ type: "LIBRARY_CARD_TO_TOP", index: card._libIdx }) },
    { label: "⬇ To bottom", action: () => onAction({ type: "LIBRARY_CARD_TO_BOTTOM", index: card._libIdx }) },
    { label: "💀 To graveyard", action: () => { onAction({ type: "LIBRARY_CARD_TO_GRAVEYARD", index: card._libIdx }); onClose(); } },
  ];

  return (
    <Modal title={`Search Library (${cards.length} cards)`} onClose={onClose} wide>
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by card name..." autoFocus
        style={{ width: "100%", background: "#0d1117", border: "1px solid #444", color: "#e0e0e0", padding: "7px 12px", borderRadius: 6, fontSize: 14, marginBottom: 10, fontFamily: "Georgia, serif", flexShrink: 0 }} />
      <CardGrid cards={filtered} onMenuItems={menuItems} />
    </Modal>
  );
}

// ── Create Token ──────────────────────────────────────────────────────────────
function CreateToken({ onCreate, onClose }) {
  const [name, setName] = useState("");
  const [pt, setPt] = useState("1/1");
  const [desc, setDesc] = useState("");
  const inp = { width: "100%", background: "#0d1117", border: "1px solid #444", color: "#e0e0e0", padding: "8px 12px", borderRadius: 6, fontSize: 14, fontFamily: "Georgia, serif" };

  return (
    <Modal title="Create Token" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label style={{ fontSize: 12, color: "#aaa", display: "block", marginBottom: 4 }}>Token name *</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Goblin, Treasure, Zombie..." autoFocus style={inp} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: "#aaa", display: "block", marginBottom: 4 }}>Power/Toughness</label>
          <input value={pt} onChange={e => setPt(e.target.value)} placeholder="e.g. 1/1" style={inp} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: "#aaa", display: "block", marginBottom: 4 }}>Type / abilities</label>
          <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="e.g. Artifact, Flying, Haste" style={inp} />
        </div>
        <button onClick={() => { if (name.trim()) { onCreate({ name: name.trim(), pt, desc }); onClose(); } }}
          style={{ background: "#ffd700", color: "#1a1a2e", border: "none", padding: "10px 20px", borderRadius: 6, cursor: "pointer", fontWeight: "bold", fontSize: 14, fontFamily: "Georgia, serif" }}>
          ✨ Create Token
        </button>
      </div>
    </Modal>
  );
}

// ── Drawing Canvas ────────────────────────────────────────────────────────────
function DrawCanvas({ active, color, onClear, areaRef }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const lastPt = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !areaRef.current) return;
    const resize = () => {
      const rect = areaRef.current.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [areaRef]);

  const getPos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onMouseDown = (e) => {
    if (!active) return;
    drawing.current = true;
    lastPt.current = getPos(e);
  };

  const onMouseMove = (e) => {
    if (!active || !drawing.current) return;
    const ctx = canvasRef.current.getContext("2d");
    const pt = getPos(e);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(lastPt.current.x, lastPt.current.y);
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
    lastPt.current = pt;
  };

  const onMouseUp = () => { drawing.current = false; };

  useEffect(() => {
    if (onClear) {
      const ctx = canvasRef.current?.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }
  }, [onClear]);

  return (
    <canvas ref={canvasRef}
      style={{ position: "absolute", inset: 0, zIndex: active ? 50 : 0, cursor: active ? "crosshair" : "default", pointerEvents: active ? "all" : "none" }}
      onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}
    />
  );
}

// ── Battlefield Card ──────────────────────────────────────────────────────────
function BattlefieldCard({ card, onAction, isMe, onPreview, cardSize, areaWidth, areaHeight }) {
  const [contextMenu, setContextMenu] = useState(null);
  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const moved = useRef(false);
  const cardRef = useRef(null);
  const w = cardSize;
  const h = Math.round(cardSize * 1.4);
  const PANEL_W = 215;

  const clamp = (x, y) => ({
    x: Math.max(0, Math.min(x, (areaWidth || 800) - w - PANEL_W)),
    y: Math.max(0, Math.min(y, (areaHeight || 300) - h)),
  });

  const handlePointerDown = (e) => {
    if (!isMe || e.button !== 0) return;
    e.preventDefault();
    dragging.current = true;
    moved.current = false;
    const rect = cardRef.current.getBoundingClientRect();
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    cardRef.current.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e) => {
    if (!dragging.current) return;
    moved.current = true;
    const parent = cardRef.current?.parentElement?.getBoundingClientRect();
    if (!parent) return;
    const raw = { x: e.clientX - parent.left - dragOffset.current.x, y: e.clientY - parent.top - dragOffset.current.y };
    const { x, y } = clamp(raw.x, raw.y);
    onAction({ type: "MOVE_CARD", instanceId: card.instanceId, x, y });
  };

  const handlePointerUp = (e) => {
    if (!dragging.current) return;
    dragging.current = false;
  };

  const handleDoubleClick = () => {
    if (!isMe) return;
    onAction({ type: "TAP_CARD", instanceId: card.instanceId });
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    if (!isMe) return;
    setContextMenu({ x: e.clientX, y: e.clientY, items: [
      { label: card.tapped ? "↺ Untap" : "↷ Tap", action: () => onAction({ type: "TAP_CARD", instanceId: card.instanceId }) },
      { label: card.faceUp ? "🔽 Face down" : "🔼 Face up", action: () => onAction({ type: "FLIP_CARD", instanceId: card.instanceId }) },
      "---",
      { label: "✋ Return to hand", action: () => onAction({ type: "BF_TO_HAND", instanceId: card.instanceId }) },
      { label: "📚 To top of library", action: () => onAction({ type: "BF_TO_LIBRARY_TOP", instanceId: card.instanceId }) },
      { label: "📚 To bottom of library", action: () => onAction({ type: "BF_TO_LIBRARY_BOTTOM", instanceId: card.instanceId }) },
      { label: "💀 To graveyard", action: () => onAction({ type: "MOVE_TO_GRAVEYARD", instanceId: card.instanceId }) },
      { label: "🚫 Exile", action: () => onAction({ type: "MOVE_TO_EXILE", instanceId: card.instanceId }) },
      "---",
      { label: "🔮 Clone", action: () => onAction({ type: "CLONE_CARD", instanceId: card.instanceId }) },
      { label: "+ Counter", action: () => onAction({ type: "ADD_COUNTER", instanceId: card.instanceId }) },
      { label: "− Counter", action: () => onAction({ type: "REMOVE_COUNTER", instanceId: card.instanceId }) },
    ]});
  };

  return (
    <>
      <div ref={cardRef}
        style={{
          position: "absolute", left: card.x || 0, top: card.y || 0, width: w, height: h,
          borderRadius: 5, userSelect: "none", touchAction: "none",
          transform: card.tapped ? `rotate(90deg)` : "none",
          zIndex: dragging.current ? 100 : 5,
          outline: card.isToken ? "2px solid #9b59b6" : "none",
          cursor: isMe ? "grab" : "default",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => onPreview(card)}
        onMouseLeave={() => onPreview(null)}
      >
        {card.isToken ? (
          <div style={{ width: "100%", height: "100%", background: "linear-gradient(135deg, #2d1b4e, #4a2080)", border: "2px solid #9b59b6", borderRadius: 5, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 4 }}>
            <div style={{ fontSize: Math.max(8, cardSize / 8), color: "#e0d0ff", fontWeight: "bold", textAlign: "center" }}>{card.name}</div>
            {card.pt && <div style={{ fontSize: Math.max(7, cardSize / 9), color: "#c0a0ff", marginTop: 2 }}>{card.pt}</div>}
            {card.desc && <div style={{ fontSize: Math.max(6, cardSize / 10), color: "#a080df", marginTop: 1, textAlign: "center" }}>{card.desc}</div>}
          </div>
        ) : card.faceUp && card.imageUrl ? (
          <img src={card.imageUrl} alt={card.name} draggable={false} style={{ width: "100%", height: "100%", borderRadius: 5, objectFit: "cover" }} />
        ) : (
          <CardBack w={w} h={h} />
        )}
        {card.counters > 0 && (
          <div style={{ position: "absolute", bottom: -7, right: -7, background: "#ffd700", color: "#1a1a2e", borderRadius: "50%", width: 20, height: 20, fontSize: 10, fontWeight: "bold", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 12 }}>+{card.counters}</div>
        )}
      </div>
      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />}
    </>
  );
}

// ── Player Area ───────────────────────────────────────────────────────────────
function PlayerArea({ playerState, isMe, onAction, onPreview, label, cardSize, drawActive, drawColor, clearSignal }) {
  const areaRef = useRef(null);
  const [dims, setDims] = useState({ w: 800, h: 300 });

  useEffect(() => {
    const update = () => {
      if (areaRef.current) {
        const r = areaRef.current.getBoundingClientRect();
        setDims({ w: r.width, h: r.height });
      }
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return (
    <div ref={areaRef} style={{ flex: 1, position: "relative", borderBottom: "2px solid #333", overflow: "hidden", background: isMe ? "#111827" : "#0d1117" }}>
      <div style={{ position: "absolute", top: 8, left: 12, fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1, zIndex: 10 }}>
        {label} — {playerState.drafter}
      </div>
      {playerState.battlefield.map(card => (
        <BattlefieldCard key={card.instanceId} card={card}
          onAction={isMe ? onAction : () => {}} isMe={isMe}
          onPreview={onPreview} cardSize={cardSize}
          areaWidth={dims.w} areaHeight={dims.h}
        />
      ))}
      {isMe && <DrawCanvas active={drawActive} color={drawColor} onClear={clearSignal} areaRef={areaRef} />}
    </div>
  );
}

// ── Hand Ribbon ───────────────────────────────────────────────────────────────
function HandRibbon({ cards, onAction, onPreview }) {
  const [contextMenu, setContextMenu] = useState(null);
  const CARD_W = 60;
  const CARD_H = 84;

  const menuItems = (card) => [
    { label: "⬆ Play to battlefield", action: () => onAction({ type: "PLAY_CARD", instanceId: card.instanceId, x: 100 + Math.random() * 200, y: 40 }) },
    { label: card.faceUp ? "🔽 Flip face down" : "🔼 Flip face up", action: () => onAction({ type: "FLIP_CARD", instanceId: card.instanceId }) },
    { label: "💀 Discard", action: () => onAction({ type: "DISCARD_CARD", instanceId: card.instanceId }) },
    { label: "📚 To top of library", action: () => onAction({ type: "HAND_TO_LIBRARY_TOP", instanceId: card.instanceId }) },
    { label: "📚 To bottom of library", action: () => onAction({ type: "HAND_TO_LIBRARY_BOTTOM", instanceId: card.instanceId }) },
  ];

  return (
    <div style={{ height: CARD_H + 16, background: "#080d18", borderTop: "2px solid #333", display: "flex", alignItems: "center", padding: "4px 12px", gap: 6, overflowX: "auto", flexShrink: 0 }}>
      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />}
      <span style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 1, whiteSpace: "nowrap", marginRight: 4 }}>Hand ({cards.length})</span>
      {cards.map(card => (
        <div key={card.instanceId}
          style={{ width: CARD_W, height: CARD_H, borderRadius: 4, cursor: "pointer", flexShrink: 0, transition: "transform 0.1s" }}
          onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-8px)"; onPreview(card); }}
          onMouseLeave={e => { e.currentTarget.style.transform = "none"; onPreview(null); }}
          onDoubleClick={() => onAction({ type: "PLAY_CARD", instanceId: card.instanceId, x: 100 + Math.random() * 200, y: 40 })}
          onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, items: menuItems(card) }); }}
        >
          {card.imageUrl
            ? <img src={card.imageUrl} alt={card.name} draggable={false} style={{ width: "100%", height: "100%", borderRadius: 4, objectFit: "cover" }} />
            : <div style={{ width: "100%", height: "100%", background: "#1e3a5f", border: "1px solid #2a5298", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 7, color: "#aaa", padding: 3, textAlign: "center" }}>{card.name}</div>
          }
        </div>
      ))}
    </div>
  );
}

// ── Side Panel ────────────────────────────────────────────────────────────────
function SidePanel({ myState, oppState, onAction, chat, playerName, onChat, cardSize, setCardSize, drawActive, setDrawActive, drawColor, setDrawColor, onClear }) {
  const [chatInput, setChatInput] = useState("");
  const [modal, setModal] = useState(null);
  const chatRef = useRef(null);

  useEffect(() => { if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; }, [chat]);

  const sendChat = (e) => { if (e.key === "Enter" && chatInput.trim()) { onChat(chatInput.trim()); setChatInput(""); } };

  const btn = (label, action) => (
    <button onClick={action} style={{ background: "#16213e", border: "1px solid #444", color: "#e0e0e0", padding: "5px 8px", borderRadius: 5, cursor: "pointer", fontSize: 11, fontFamily: "Georgia, serif", width: "100%", textAlign: "left", marginBottom: 3 }}
      onMouseEnter={e => { e.currentTarget.style.background = "#1a2a50"; e.currentTarget.style.borderColor = "#ffd700"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "#16213e"; e.currentTarget.style.borderColor = "#444"; }}
    >{label}</button>
  );

  return (
    <div style={{ width: 210, background: "#0d1117", borderLeft: "1px solid #333", display: "flex", flexDirection: "column", padding: 10, gap: 8, overflowY: "auto" }}>
      {modal === "graveyard" && <ZoneViewer title="My Graveyard" cards={myState.graveyard} onAction={onAction} zoneKey="graveyard" onClose={() => setModal(null)} />}
      {modal === "exile" && <ZoneViewer title="My Exile" cards={myState.exile} onAction={onAction} zoneKey="exile" onClose={() => setModal(null)} />}
      {modal === "opp-graveyard" && <ZoneViewer title="Opp Graveyard" cards={oppState.graveyard} onAction={() => {}} zoneKey="graveyard" onClose={() => setModal(null)} readOnly />}
      {modal === "library" && <LibraryViewer cards={myState.library} onAction={onAction} onClose={() => setModal(null)} />}
      {modal === "search" && <SearchLibrary cards={myState.library} onAction={onAction} onClose={() => setModal(null)} />}
      {modal === "token" && <CreateToken onCreate={(t) => onAction({ type: "CREATE_TOKEN", ...t, x: 100, y: 50 })} onClose={() => setModal(null)} />}

      {/* Life */}
      <div>
        <div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 3 }}>My Life</div>
        <div style={{ textAlign: "center", fontSize: 26, color: "#ffd700", fontWeight: "bold" }}>{myState.life}</div>
        <div style={{ display: "flex", gap: 5, justifyContent: "center", marginTop: 3 }}>
          <button onClick={() => onAction({ type: "SET_LIFE", life: myState.life + 1 })} style={{ background: "#16213e", border: "1px solid #444", color: "#e0e0e0", width: 30, height: 30, borderRadius: 5, cursor: "pointer", fontSize: 16 }}>+</button>
          <button onClick={() => onAction({ type: "SET_LIFE", life: myState.life - 1 })} style={{ background: "#16213e", border: "1px solid #444", color: "#e0e0e0", width: 30, height: 30, borderRadius: 5, cursor: "pointer", fontSize: 16 }}>−</button>
        </div>
        <div style={{ textAlign: "center", fontSize: 11, color: "#555", marginTop: 3 }}>Opp: <span style={{ color: "#aaa" }}>{oppState.life}</span></div>
      </div>

      {/* Actions */}
      <div>
        <div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 3 }}>Actions</div>
        {btn(`📚 Draw (${myState.library.length} left)`, () => onAction({ type: "DRAW_CARD" }))}
        {btn("↺ Untap all", () => onAction({ type: "UNTAP_ALL" }))}
        {btn("🔀 Shuffle library", () => onAction({ type: "SHUFFLE_LIBRARY" }))}
        {btn("🔍 Search library", () => setModal("search"))}
        {btn("👁 View top of library", () => setModal("library"))}
        {btn("✨ Create token", () => setModal("token"))}
      </div>

      {/* Zones */}
      <div>
        <div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 3 }}>Zones</div>
        {[["💀 Graveyard", myState.graveyard.length, "graveyard"], ["🚫 Exile", myState.exile.length, "exile"], ["👁 Opp GY", oppState.graveyard.length, "opp-graveyard"]].map(([label, count, key]) => (
          <div key={key} onClick={() => setModal(key)}
            style={{ background: "#16213e", borderRadius: 5, padding: "5px 8px", fontSize: 11, display: "flex", justifyContent: "space-between", cursor: "pointer", marginBottom: 3, border: "1px solid transparent" }}
            onMouseEnter={e => e.currentTarget.style.borderColor = "#ffd700"}
            onMouseLeave={e => e.currentTarget.style.borderColor = "transparent"}
          ><span>{label}</span><span style={{ color: "#ffd700" }}>{count}</span></div>
        ))}
      </div>

      {/* Card size */}
      <div>
        <div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 3 }}>Card Size</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="range" min={40} max={150} value={cardSize} onChange={e => setCardSize(+e.target.value)} style={{ flex: 1 }} />
          <span style={{ fontSize: 10, color: "#aaa", minWidth: 22 }}>{cardSize}</span>
        </div>
      </div>

      {/* Draw mode */}
      <div>
        <div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 3 }}>Draw on Board</div>
        <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 4 }}>
          <button onClick={() => setDrawActive(!drawActive)}
            style={{ background: drawActive ? "#ffd700" : "#16213e", color: drawActive ? "#1a1a2e" : "#e0e0e0", border: "1px solid #444", padding: "4px 10px", borderRadius: 5, cursor: "pointer", fontSize: 11, fontFamily: "Georgia, serif", flex: 1 }}>
            {drawActive ? "✏️ Drawing ON" : "✏️ Draw mode"}
          </button>
          <button onClick={onClear} style={{ background: "#16213e", border: "1px solid #444", color: "#aaa", padding: "4px 8px", borderRadius: 5, cursor: "pointer", fontSize: 11 }}>Clear</button>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {["#ff4444", "#44ff88", "#4488ff", "#ffdd44", "#ffffff"].map(c => (
            <div key={c} onClick={() => setDrawColor(c)}
              style={{ width: 22, height: 22, borderRadius: "50%", background: c, cursor: "pointer", border: drawColor === c ? "3px solid white" : "2px solid #444" }} />
          ))}
        </div>
      </div>

      {/* Chat */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 3 }}>Chat</div>
        <div ref={chatRef} style={{ flex: 1, overflowY: "auto", background: "#0a0f1a", borderRadius: 5, padding: 6, marginBottom: 5, minHeight: 50, maxHeight: 100 }}>
          {chat.map((msg, i) => <div key={i} style={{ fontSize: 11, marginBottom: 2 }}><span style={{ color: "#ffd700" }}>{msg.name}: </span>{msg.message}</div>)}
        </div>
        <input placeholder="Chat..." value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={sendChat}
          style={{ background: "#16213e", border: "1px solid #444", color: "#e0e0e0", padding: "4px 8px", borderRadius: 4, fontSize: 11, width: "100%", fontFamily: "Georgia, serif" }} />
      </div>

      {/* Concede */}
      <button onClick={() => { if (window.confirm("Concede this game?")) onAction({ type: "CONCEDE" }); }}
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
  const [drawActive, setDrawActive] = useState(false);
  const [drawColor, setDrawColor] = useState("#ff4444");
  const [clearSignal, setClearSignal] = useState(0);

  useEffect(() => {
    socket.emit("join_game", { gameId, playerName, seat });
    socket.on("game_state", setGameState);
    socket.on("game_info", setGameInfo);
    socket.on("player_left", ({ name }) => alert(`${name} has left the game.`));
    socket.on("game_over", ({ reason }) => setGameOver(reason));
    socket.on("error", ({ message }) => alert(message));
    return () => { socket.off("game_state"); socket.off("game_info"); socket.off("player_left"); socket.off("game_over"); socket.off("error"); };
  }, [gameId, seat, playerName]);

  const onAction = useCallback((action) => socket.emit("game_action", { gameId, action }), [gameId]);
  const onChat = useCallback((msg) => socket.emit("game_action", { gameId, action: { type: "CHAT", message: msg } }), [gameId]);

  if (gameOver) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", flexDirection: "column", gap: 16 }}>
      <h1 style={{ color: "#ffd700" }}>⚔️ Game Over</h1>
      <p style={{ color: "#aaa" }}>{gameOver}</p>
      <button onClick={() => window.location.reload()} style={{ background: "#ffd700", color: "#1a1a2e", border: "none", padding: "10px 24px", borderRadius: 8, cursor: "pointer", fontWeight: "bold", fontFamily: "Georgia, serif" }}>Return to Lobby</button>
    </div>
  );

  if (!gameState) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: "#ffd700", fontStyle: "italic" }}>⚔️ Connecting...</div>;

  const myState = seat === "A" ? gameState.playerA : gameState.playerB;
  const oppState = seat === "A" ? gameState.playerB : gameState.playerA;

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {gameInfo?.status === "waiting" && (
          <div style={{ textAlign: "center", padding: 8, color: "#ffd700", fontStyle: "italic", background: "#0d1117", borderBottom: "1px solid #333", fontSize: 12, flexShrink: 0 }}>
            ⏳ Waiting for opponent — share this URL with them!
          </div>
        )}
        <PlayerArea playerState={oppState} isMe={false} onAction={onAction} onPreview={setPreview} label="Opponent" cardSize={cardSize} drawActive={false} />
        <PlayerArea playerState={myState} isMe={true} onAction={onAction} onPreview={setPreview} label="You" cardSize={cardSize} drawActive={drawActive} drawColor={drawColor} clearSignal={clearSignal} />
        <HandRibbon cards={myState.hand} onAction={onAction} onPreview={setPreview} />
      </div>
      <SidePanel myState={myState} oppState={oppState} onAction={onAction} chat={gameState.chat} playerName={playerName} onChat={onChat}
        cardSize={cardSize} setCardSize={setCardSize}
        drawActive={drawActive} setDrawActive={setDrawActive}
        drawColor={drawColor} setDrawColor={setDrawColor}
        onClear={() => setClearSignal(s => s + 1)}
      />
      <CardPreview card={preview} />
    </div>
  );
}

// ── Decklist Editor ───────────────────────────────────────────────────────────
function DecklistEditor({ deck, seat, gameId, onReady }) {
  const initialText = cardsToText(deck.cards);
  const [text, setText] = useState(initialText);
  const [loading, setLoading] = useState(false);

  const handleReady = async () => {
    setLoading(true);
    const parsed = parseDecklist(text);
    const withImages = await fetchScryfallImages(parsed);
    socket.emit("update_deck", { gameId, seat, cards: withImages });
    setLoading(false);
    onReady();
  };

  return (
    <div style={{ maxWidth: 600, margin: "40px auto", padding: "0 20px" }}>
      <h1 style={{ color: "#ffd700", textAlign: "center", marginBottom: 8 }}>⚔️ Cube Clash</h1>
      <h2 style={{ color: "#e0e0e0", textAlign: "center", marginBottom: 4 }}>{seat === "A" ? "🅰️" : "🅱️"} {deck.drafter}'s Deck</h2>
      <p style={{ color: "#aaa", textAlign: "center", marginBottom: 20, fontSize: 13 }}>
        {initialText ? "Review and edit your decklist. Add missing lands or fix any card names." : "Decklist not available — paste your cards below (format: '1 Card Name' per line)."}
      </p>
      <textarea value={text} onChange={e => setText(e.target.value)}
        placeholder={"1 Lightning Bolt\n4 Island\n1 Goblin Guide\n..."}
        style={{ width: "100%", height: 400, background: "#16213e", border: "1px solid #444", color: "#e0e0e0", padding: 12, borderRadius: 8, fontSize: 13, fontFamily: "monospace", lineHeight: 1.6, resize: "vertical" }}
      />
      <p style={{ color: "#555", fontSize: 12, marginTop: 6, marginBottom: 16 }}>Format: "4 Island", "1 Lightning Bolt" — one per line. Double-click a card in hand or battlefield to tap/play.</p>
      <button onClick={handleReady} disabled={loading}
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
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, []);

  const startGame = async (seat) => {
    if (!playerName.trim()) { alert("Please enter your name first!"); return; }
    const resp = await fetch("/api/games", { method: "POST" });
    const { gameId } = await resp.json();
    setEditingDeck({ deck: seat === "A" ? lobby.deckA : lobby.deckB, seat, gameId });
  };

  const joinGame = (gameId, seat) => {
    if (!playerName.trim()) { alert("Please enter your name first!"); return; }
    setEditingDeck({ deck: seat === "A" ? lobby.deckA : lobby.deckB, seat, gameId });
  };

  if (activeGame) return <GameBoard gameId={activeGame.gameId} seat={activeGame.seat} playerName={playerName.trim()} />;
  if (editingDeck) return <DecklistEditor deck={editingDeck.deck} seat={editingDeck.seat} gameId={editingDeck.gameId} onReady={() => setActiveGame({ gameId: editingDeck.gameId, seat: editingDeck.seat })} />;
  if (error) return <div style={{ textAlign: "center", padding: 40, color: "#f87171" }}>{error}</div>;
  if (!lobby) return <div style={{ textAlign: "center", padding: 40, color: "#aaa" }}>Loading...</div>;
  if (!lobby.weekLabel) return (
    <div style={{ maxWidth: 600, margin: "0 auto", padding: 40, textAlign: "center" }}>
      <h1 style={{ color: "#ffd700", fontSize: "2.5rem", marginBottom: 12 }}>⚔️ Cube Clash</h1>
      <p style={{ color: "#aaa", fontStyle: "italic" }}>No decks set for this week. Check back after Friday's post!</p>
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
          <div key={seat} onClick={() => startGame(seat)}
            style={{ background: "#16213e", border: "2px solid #ffd700", borderRadius: 12, padding: 24, width: 280, cursor: "pointer", transition: "all 0.15s" }}
            onMouseEnter={e => { e.currentTarget.style.background = "#1a2a50"; e.currentTarget.style.transform = "translateY(-4px)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "#16213e"; e.currentTarget.style.transform = "none"; }}
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
              <button onClick={() => joinGame(g.gameId, "B")} style={{ background: "#ffd700", color: "#1a1a2e", border: "none", padding: "6px 16px", borderRadius: 6, cursor: "pointer", fontWeight: "bold", fontFamily: "Georgia, serif" }}>Join</button>
            </div>
          ))}
        </div>
      )}
      {activeGames.length > 0 && (
        <div style={{ background: "#16213e", borderRadius: 12, padding: 20, marginBottom: 16, textAlign: "left" }}>
          <h3 style={{ color: "#ffd700", marginBottom: 12 }}>⚔️ Active ({activeGames.length})</h3>
          {activeGames.map(g => <div key={g.gameId} style={{ display: "flex", justifyContent: "space-between", padding: 10, background: "#1a1a2e", borderRadius: 8, marginBottom: 8 }}><div style={{ fontSize: 14 }}>Game {g.gameId}</div><div style={{ fontSize: 12, color: "#aaa" }}>In progress</div></div>)}
        </div>
      )}
      <p style={{ color: "#555", fontSize: 13 }}>Click a deck to create a game — share the URL with your opponent!</p>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<Lobby />);
