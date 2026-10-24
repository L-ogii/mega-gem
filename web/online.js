// Online play over WebRTC, via PeerJS.
//
// The host's browser runs the one real game; players only send their moves
// and render the views the host sends them, so nobody ever receives
// anything they couldn't see at a real table. PeerJS's free public broker
// only introduces the browsers to each other; game messages then travel
// directly between them. This module is just rooms and JSON messages; the
// game protocol lives in app.js.

const PEERJS_URL = "https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js";
const ID_PREFIX = "megagem-v1-";
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I
export const CODE_LENGTH = 5;
const CONNECT_TIMEOUT_MS = 12000;

let peerJs = null;
function loadPeerJs() {
  if (window.Peer) return Promise.resolve(window.Peer);
  peerJs ??= new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement("script"), { src: PEERJS_URL, async: true });
    s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error("The online-play library didn't load.")));
    s.onerror = () => {
      peerJs = null;
      s.remove();
      reject(new Error("Couldn't load the online-play library. Check your connection."));
    };
    document.head.append(s);
  });
  return peerJs;
}

export const cleanCode = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LENGTH);

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

function friendly(err) {
  switch (err?.type) {
    case "peer-unavailable": return "No game with that code is open. Check the code with the host.";
    case "network":
    case "server-error":
    case "socket-error":
    case "socket-closed": return "Couldn't reach the matchmaking server. Check your connection and try again.";
    case "browser-incompatible": return "This browser can't make peer-to-peer connections.";
    default: return err?.message || String(err);
  }
}

function openPeer(Peer, id) {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, { debug: 1 }) : new Peer({ debug: 1 });
    const fail = (err) => { clearTimeout(timer); peer.destroy(); reject(err); };
    const timer = setTimeout(() => fail({ type: "network" }), CONNECT_TIMEOUT_MS);
    peer.once("open", () => { clearTimeout(timer); peer.off("error", fail); resolve(peer); });
    peer.on("error", fail);
  });
}

/**
 * Open a room under a fresh code. Resolves to
 * { code, send(id, msg), broadcast(msg), drop(id), close() }.
 * Handlers: onJoin(id), onMessage(id, msg), onLeave(id), onError(text).
 */
export async function hostRoom(handlers) {
  const Peer = await loadPeerJs();
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = newCode();
    try {
      return roomFor(await openPeer(Peer, ID_PREFIX + code), code, handlers);
    } catch (err) {
      if (err?.type !== "unavailable-id") throw new Error(friendly(err));
    }
  }
  throw new Error("Couldn't find a free room code. Try again.");
}

function roomFor(peer, code, h) {
  const conns = new Map(); // id → DataConnection
  let next = 0;
  peer.on("connection", (conn) => {
    const id = `p${++next}`;
    conn.on("open", () => { conns.set(id, conn); h.onJoin?.(id); });
    conn.on("data", (msg) => { if (conns.get(id) === conn && msg && typeof msg === "object") h.onMessage?.(id, msg); });
    const gone = () => { if (conns.get(id) === conn) { conns.delete(id); h.onLeave?.(id); } };
    conn.on("close", gone);
    conn.on("error", gone);
  });
  // Losing the broker only stops new joins; reconnect so the code keeps working.
  peer.on("disconnected", () => { if (!peer.destroyed) peer.reconnect(); });
  peer.on("error", (err) => h.onError?.(friendly(err)));
  return {
    code,
    send: (id, msg) => { const c = conns.get(id); if (c?.open) c.send(msg); },
    broadcast: (msg) => { for (const c of conns.values()) if (c.open) c.send(msg); },
    drop: (id) => { const c = conns.get(id); conns.delete(id); c?.close(); },
    close: () => { for (const c of conns.values()) c.close(); conns.clear(); peer.destroy(); },
  };
}

/**
 * Join the room with this code. Resolves to { send(msg), close() }.
 * Handlers: onMessage(msg), onClose(text), onError(text).
 */
export async function joinRoom(code, h) {
  const Peer = await loadPeerJs();
  let peer;
  try { peer = await openPeer(Peer, null); } catch (err) { throw new Error(friendly(err)); }
  const conn = await new Promise((resolve, reject) => {
    const c = peer.connect(ID_PREFIX + cleanCode(code), { reliable: true, serialization: "json" });
    const fail = (err) => { clearTimeout(timer); peer.off("error", fail); peer.destroy(); reject(new Error(friendly(err))); };
    const timer = setTimeout(() => fail({ type: "peer-unavailable" }), CONNECT_TIMEOUT_MS);
    c.once("open", () => { clearTimeout(timer); peer.off("error", fail); resolve(c); });
    peer.on("error", fail);
  });
  let closed = false;
  const end = (why) => { if (closed) return; closed = true; peer.destroy(); h.onClose?.(why); };
  conn.on("data", (msg) => { if (msg && typeof msg === "object") h.onMessage?.(msg); });
  conn.on("close", () => end("The connection to the host closed."));
  conn.on("error", () => end("The connection to the host failed."));
  peer.on("error", (err) => { if (!closed) h.onError?.(friendly(err)); });
  return {
    send: (msg) => { if (conn.open) conn.send(msg); },
    close: () => { closed = true; conn.close(); peer.destroy(); },
  };
}
