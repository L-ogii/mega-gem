// MegaGem static client.
//
// All game logic runs in engine-worker.js (Pyodide + the canonical
// research/megagem package). This file only renders the views that
// megagem.browser.BrowserSession returns and sends back bids/reveals.
// The EV coach (coach.js) is pure JS over those same views and never
// talks to the worker.

import { advise, analyze } from "./coach.js?v=__MEGAGEM_BUILD__";

const COLORS = ["Blue", "Green", "Pink", "Purple", "Yellow"];
const COLOR_HEX = { Blue: "#4f9bff", Green: "#33d68b", Pink: "#ff5fae", Purple: "#a875ff", Yellow: "#ffcc3d" };
const TOTAL_AUCTIONS = 25;

const CHARTS = {
  A: { values: [0, 4, 8, 12, 16, 20], label: "Rising" },
  B: { values: [20, 16, 12, 8, 4, 0], label: "Falling" },
  C: { values: [0, 2, 5, 9, 14, 20], label: "Slow climb" },
  D: { values: [20, 18, 15, 11, 6, 0], label: "Slow fall" },
  E: { values: [0, 4, 10, 18, 6, 0], label: "Peaks at 3" },
};

// Strongest first. Keys match megagem.browser.AI_FACTORIES.
const BOTS = [
  { kind: "evo4", label: "Evo4", tier: "Champion" },
  { kind: "evo3", label: "Evo3", tier: "Very hard" },
  { kind: "evo2", label: "Evo2", tier: "Hard" },
  { kind: "evolved", label: "Evo1", tier: "Tough" },
  { kind: "heuristic", label: "Heuristic", tier: "Medium" },
  { kind: "random", label: "Random", tier: "Very easy" },
];
const BOT_BY_KIND = Object.fromEntries(BOTS.map((b) => [b.kind, b]));
const BOT_NAMES = ["Ruby", "Onyx", "Jade", "Opal", "Topaz", "Garnet"];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
// Gem art: one cut per colour so colours stay distinguishable without hue.
// --------------------------------------------------------------------------

const ngon = (n, r, rot = -Math.PI / 2, cx = 16, cy = 16) =>
  Array.from({ length: n }, (_, i) => [cx + r * Math.cos(rot + (2 * Math.PI * i) / n), cy + r * Math.sin(rot + (2 * Math.PI * i) / n)]);

const GEM_SHAPES = {
  Blue: ngon(5, 14.5),
  Green: [[10, 3], [22, 3], [28, 9], [28, 23], [22, 29], [10, 29], [4, 23], [4, 9]],
  Pink: ngon(10, 14, -Math.PI / 2 + Math.PI / 10),
  Purple: ngon(6, 14.5),
  Yellow: [[16, 3], [29.5, 27], [2.5, 27]],
};

const gemCache = {};
function gem(color, size = "") {
  const key = color + size;
  if (gemCache[key]) return gemCache[key];
  const pts = GEM_SHAPES[color];
  const hex = COLOR_HEX[color];
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const inner = pts.map(([x, y]) => [cx + (x - cx) * 0.5, cy + (y - cy) * 0.5]);
  const f = (arr) => arr.map((p) => p.map((v) => v.toFixed(2)).join(",")).join(" ");
  let facets = "";
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    // Light from the top-left: shade each crown facet by how much its
    // outward direction (centre → edge midpoint) faces the light.
    const nx = (a[0] + b[0]) / 2 - cx, ny = (a[1] + b[1]) / 2 - cy;
    const light = (nx * -0.6 + ny * -0.8) / (Math.hypot(nx, ny) || 1);
    const fill = light > 0 ? "#fff" : "#000";
    const op = Math.min(0.42, Math.abs(light) * 0.4).toFixed(2);
    facets += `<polygon points="${f([a, b, inner[(i + 1) % pts.length], inner[i]])}" fill="${fill}" opacity="${op}"/>`;
  }
  const svg =
    `<svg class="gem ${size}" viewBox="0 0 32 32" role="img" aria-label="${color}"><title>${color}</title>` +
    `<polygon points="${f(pts)}" fill="${hex}"/>${facets}` +
    `<polygon points="${f(inner)}" fill="#fff" opacity="0.18"/>` +
    `<polygon points="${f(pts)}" fill="none" stroke="#fff" stroke-opacity="0.45" stroke-width="0.8" stroke-linejoin="round"/></svg>`;
  return (gemCache[key] = svg);
}

const coin = (n) => `<span class="coin">${n}</span>`;

function gemCounts(counts, size = "sm") {
  const parts = COLORS.filter((c) => counts[c] > 0).map((c) =>
    counts[c] > 1 ? `<span class="gem-stack">${gem(c, size)}×${counts[c]}</span>` : gem(c, size));
  return parts.length ? parts.join("") : '<span class="empty">none</span>';
}

function gemList(colors, size = "") {
  return colors.length ? colors.map((c) => gem(c, size)).join("") : '<span class="empty">none</span>';
}

const countColors = (colors) => colors.reduce((m, c) => ((m[c] = (m[c] || 0) + 1), m), {});

// --------------------------------------------------------------------------
// Engine worker wrapper
// --------------------------------------------------------------------------

class Engine {
  constructor() {
    const pageParams = new URLSearchParams(location.search);
    const workerParams = new URLSearchParams({ v: window.MEGAGEM_BUILD || "dev" });
    if (pageParams.get("pyodide")) workerParams.set("pyodide", pageParams.get("pyodide"));
    this.worker = new Worker(`engine-worker.js?${workerParams}`);
    this.pending = new Map();
    this.nextId = 1;
    this.status = "loading";
    this.onStatus = () => {};
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.onerror = (e) => this._setStatus("error", e.message || "Worker failed to start.");
  }
  _setStatus(status, detail) {
    this.status = status;
    this.detail = detail;
    this.onStatus(status, detail);
  }
  _onMessage(msg) {
    if (msg.type === "progress") return this._setStatus("loading", msg.stage);
    if (msg.type === "ready") return this._setStatus("ready", "Python engine ready");
    if (msg.type === "fatal") return this._setStatus("error", msg.error);
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
  }
  call(cmd, args = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, cmd, args });
    });
  }
}

// --------------------------------------------------------------------------
// Preferences (per-browser convenience only)
// --------------------------------------------------------------------------

const PREFS_KEY = "megagem.prefs.v2";
const defaultPrefs = { mode: "play", players: 4, name: "", chart: "A", explain: false, coach: true, coachColors: true, bots: ["evo4", "evo4", "evo4", "evo4", "evo4"] };

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...defaultPrefs, ...JSON.parse(raw) };
  } catch (_) { /* storage unavailable */ }
  return { ...defaultPrefs };
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) { /* ignore */ }
}

// --------------------------------------------------------------------------
// App state
// --------------------------------------------------------------------------

const engine = new Engine();
const prefs = loadPrefs();
let game = null; // { config, view, token, busy, auto, autoTimer, log, snapshots, advice }
let gameToken = 0;

function showScreen(name) {
  for (const s of ["setup", "game", "end"]) $(`screen-${s}`).hidden = s !== name;
  $("nav-quit").hidden = name !== "game";
  window.scrollTo({ top: 0 });
}

let toastTimer = null;
function hideToast() {
  clearTimeout(toastTimer);
  $("toast").hidden = true;
}
function toast(html, { error = false, ms = 3200 } = {}) {
  const el = $("toast");
  el.innerHTML = html;
  el.classList.toggle("error", error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// --------------------------------------------------------------------------
// Setup screen
// --------------------------------------------------------------------------

function seg(id, value, onChange) {
  const el = $(id);
  for (const b of el.querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.value === String(value)));
    b.onclick = () => onChange(b.dataset.value);
  }
}

function botOptions(selected) {
  return BOTS.map((b) => `<option value="${b.kind}"${b.kind === selected ? " selected" : ""}>${b.label} · ${b.tier}</option>`).join("");
}

function renderSetup() {
  seg("mode-seg", prefs.mode, (v) => { prefs.mode = v; savePrefs(); renderSetup(); });
  seg("players-seg", prefs.players, (v) => { prefs.players = Number(v); savePrefs(); renderSetup(); });
  $("name-field").hidden = prefs.mode !== "play";
  $("coach-field").hidden = prefs.mode !== "play";
  $("setup-name").value = prefs.name;
  $("setup-explain").checked = prefs.explain;
  $("setup-coach").checked = prefs.coach;

  const rows = [];
  let botIdx = 0;
  for (let i = 0; i < prefs.players; i++) {
    if (i === 0 && prefs.mode === "play") {
      rows.push(`<div class="seat you"><span class="seat-no">${i + 1}</span>
        <span class="seat-name">${esc(prefs.name || "You")}<small>Human: that's you</small></span><span></span></div>`);
      continue;
    }
    const kind = prefs.bots[botIdx] || "evo4";
    rows.push(`<div class="seat"><span class="seat-no">${i + 1}</span>
      <span class="seat-name">${BOT_NAMES[botIdx]}<small>Bot seat</small></span>
      <select data-bot="${botIdx}" aria-label="Bot for seat ${i + 1}">${botOptions(kind)}</select></div>`);
    botIdx++;
  }
  $("seat-list").innerHTML = rows.join("");
  for (const sel of $("seat-list").querySelectorAll("select")) {
    sel.onchange = () => { prefs.bots[Number(sel.dataset.bot)] = sel.value; savePrefs(); };
  }

  $("setup-all").innerHTML = `<option value="">Set all bots to…</option>` + BOTS.map((b) => `<option value="${b.kind}">${b.label}</option>`).join("");

  $("chart-picker").innerHTML = Object.entries(CHARTS).map(([key, c]) => {
    const bars = c.values.map((v) => `<i style="height:${Math.max(6, (v / 20) * 100)}%"></i>`).join("");
    return `<button type="button" class="chart-opt" data-chart="${key}" aria-pressed="${key === prefs.chart}" title="Chart ${key}: ${c.values.join(", ")}">
      <b>${key}</b><span class="mini-bars">${bars}</span><small>${c.label}</small></button>`;
  }).join("");
  for (const b of $("chart-picker").querySelectorAll("button")) {
    b.onclick = () => { prefs.chart = b.dataset.chart; savePrefs(); renderSetup(); };
  }
}

function setupConfig() {
  const seats = [];
  let botIdx = 0;
  for (let i = 0; i < prefs.players; i++) {
    if (i === 0 && prefs.mode === "play") {
      seats.push({ kind: "human", name: (prefs.name || "You").slice(0, 20) });
    } else {
      const kind = prefs.bots[botIdx] || "evo4";
      seats.push({ kind, name: BOT_NAMES[botIdx] });
      botIdx++;
    }
  }
  const seedRaw = $("setup-seed").value.trim();
  return { seats, chart: prefs.chart, explain: prefs.explain, seed: seedRaw === "" ? null : Math.abs(parseInt(seedRaw, 10)) || 0 };
}

function wireSetup() {
  $("setup-name").addEventListener("input", (e) => {
    prefs.name = e.target.value;
    savePrefs();
    const you = document.querySelector(".seat.you .seat-name");
    if (you) you.firstChild.textContent = prefs.name || "You";
  });
  $("setup-explain").addEventListener("change", (e) => { prefs.explain = e.target.checked; savePrefs(); });
  $("setup-coach").addEventListener("change", (e) => { prefs.coach = e.target.checked; savePrefs(); });
  $("setup-all").addEventListener("change", (e) => {
    if (!e.target.value) return;
    prefs.bots = prefs.bots.map(() => e.target.value);
    savePrefs();
    renderSetup();
  });
  $("setup-form").addEventListener("submit", (e) => {
    e.preventDefault();
    startGame(setupConfig());
  });
  $("hero-gems").innerHTML = COLORS.map((c) => gem(c, "lg")).join("");
}

function renderEngineStatus(status, detail) {
  const el = $("engine-status");
  el.className = `engine-status ${status}`;
  el.querySelector("span").textContent = detail || "";
  $("setup-start").textContent = status === "ready" ? "Deal the cards" : status === "error" ? "Engine failed to load" : "Deal the cards (loading…)";
  $("setup-start").disabled = status === "error";
}

// --------------------------------------------------------------------------
// Game flow
// --------------------------------------------------------------------------

async function startGame(config) {
  stopAuto();
  const token = ++gameToken;
  game = { config, view: null, token, busy: true, auto: false, autoTimer: null, log: [], snapshots: {}, advice: null };
  hideToast();
  $("g-log").innerHTML = "";
  showScreen("game");
  renderLoadingTable();
  try {
    const view = await engine.call("new", config);
    if (token !== gameToken) return;
    game.config.seed = view.seed; // pin the seed so Rematch replays this exact deal
    handleView(view);
  } catch (err) {
    if (token !== gameToken) return;
    toast(`Couldn't start the game: ${esc(err.message)}`, { error: true, ms: 8000 });
    showScreen("setup");
  }
}

async function act(cmd, args) {
  if (!game || game.busy) return;
  const token = game.token;
  game.busy = true;
  renderAction();
  $("g-coach").classList.add("stale");
  try {
    const view = await engine.call(cmd, args);
    if (token !== gameToken) return;
    handleView(view);
  } catch (err) {
    if (token !== gameToken) return;
    game.busy = false;
    stopAuto();
    renderAction();
    toast(`Engine error: ${esc(err.message)}`, { error: true, ms: 8000 });
  }
}

function handleView(view) {
  game.view = view;
  game.busy = false;
  // The table as seen at bid time, keyed by the round about to be played,
  // so the end-screen analysis can value each lot from every seat.
  if (view.phase === "bid" || view.phase === "ready") game.snapshots[view.state.round_number + 1] = structuredClone(view.state);
  if (view.last_round) {
    game.log.push(view.last_round);
    appendLog(view.last_round, view);
    if (view.human_idx !== null) toast(roundSummary(view.last_round, view), { ms: 4200 });
  }
  renderGame();
  if (view.phase === "game_over") {
    stopAuto();
    setTimeout(() => { if (game && game.view === view) renderEnd(); }, view.human_idx === null ? 600 : 1400);
  } else if (view.phase === "ready" && game.auto) {
    scheduleAuto();
  } else if (view.phase === "bid") {
    requestAnimationFrame(() => { const inp = $("bid-num"); if (inp && window.matchMedia("(pointer:fine)").matches) inp.select(); });
  }
}

function quitGame() {
  if (game && game.view && game.view.phase !== "game_over" && !confirm("Abandon this game?")) return;
  stopAuto();
  gameToken++;
  game = null;
  showScreen("setup");
}

// Spectator autoplay ------------------------------------------------------

function scheduleAuto() {
  clearTimeout(game.autoTimer);
  game.autoTimer = setTimeout(() => act("step"), Number($("sp-speed").value));
}
function stopAuto() {
  if (!game) return;
  game.auto = false;
  clearTimeout(game.autoTimer);
  $("sp-auto").innerHTML = 'Auto-play <span class="kbd">Space</span>';
}
function toggleAuto() {
  if (!game || game.view?.phase !== "ready" && !game.busy) return;
  if (game.auto) return stopAuto();
  game.auto = true;
  $("sp-auto").innerHTML = 'Pause <span class="kbd">Space</span>';
  if (!game.busy) act("step");
}

// --------------------------------------------------------------------------
// Rendering helpers
// --------------------------------------------------------------------------

const chartValue = (chart, n) => CHARTS[chart].values[Math.min(Math.max(n, 0), 5)];

function seatLabel(view, i) {
  const kind = view.seat_kinds[i];
  return kind === "human" ? "You" : (BOT_BY_KIND[kind]?.label || kind);
}

function scoreNow(state, ps) {
  const gems = COLORS.reduce((s, c) => s + (ps.collection[c] || 0) * chartValue(state.value_chart, state.value_display[c] || 0), 0);
  const missions = ps.completed_missions.reduce((s, m) => s + m.coins, 0);
  const loans = ps.loans.reduce((s, x) => s + x, 0);
  const invest = ps.investments.reduce((s, x) => s + x.amount + x.locked, 0);
  return ps.coins + gems + missions - loans + invest;
}

function auctionText(a) {
  if (!a) return "";
  if (a.kind === "treasure") return `Treasure ×${a.gems}`;
  if (a.kind === "loan") return `Loan ${a.amount}`;
  return `Invest ${a.amount}`;
}

function roundSummary(r, view) {
  const name = esc(view.state.players[r.winner_idx].name);
  const you = r.winner_idx === view.human_idx;
  const gems = r.taken_gems.length ? ` and takes ${r.taken_gems.map((c) => gem(c, "sm")).join("")}` : "";
  const missions = r.completed_missions.map((m) => `<br>${esc(view.state.players[m.player_idx].name)} completes <b>${esc(missionText(m.mission.name))}</b> (+${m.mission.coins})`).join("");
  return `<b>Round ${r.round}:</b> ${you ? "You win" : `${name} wins`} ${auctionText(r.auction)} for ${coin(r.winning_bid)}${gems}.${missions}`;
}

// Mission text + a UI-only "how close am I" hint. The engine decides
// completion; this just mirrors the requirement shapes in missions.py.
const missionText = (name) => name.replace(/^[A-Za-z]+:\s*/, "");

function missionReq(name) {
  const text = missionText(name);
  const specific = [...text.matchAll(/(\d+) (Blue|Green|Pink|Purple|Yellow)/g)];
  if (specific.length) return specific.map(([, n, c]) => `${gem(c, "sm")}${Number(n) > 1 ? `×${n}` : ""}`).join('<span class="muted">+</span>');
  return esc(text);
}

function missionNeed(name, collection) {
  const text = missionText(name);
  const counts = COLORS.map((c) => collection[c] || 0);
  let m;
  const specific = [...text.matchAll(/(\d+) (Blue|Green|Pink|Purple|Yellow)/g)];
  if (specific.length) return specific.reduce((s, [, n, c]) => s + Math.max(0, Number(n) - (collection[c] || 0)), 0);
  if ((m = text.match(/^(\d+) different colors/))) return Math.max(0, Number(m[1]) - counts.filter((n) => n > 0).length);
  if ((m = text.match(/^(\d+) pairs/))) return [...counts].sort((a, b) => b - a).slice(0, Number(m[1])).reduce((s, n) => s + Math.max(0, 2 - n), 0);
  if ((m = text.match(/^(\d+) of the same color/))) return Math.max(0, Number(m[1]) - Math.max(...counts));
  return null;
}

// --------------------------------------------------------------------------
// Game screen
// --------------------------------------------------------------------------

function renderLoadingTable() {
  $("g-round").textContent = "Dealing…";
  $("g-progress").style.width = "0%";
  $("g-meta").innerHTML = "";
  $("g-opponents").innerHTML = "";
  $("g-auction").className = "auction";
  $("g-auction").innerHTML = `<div class="waiting"><span class="spinner"></span><span>${esc(engine.status === "ready" ? "Shuffling…" : engine.detail || "Loading the engine…")}</span></div>`;
  $("g-market").innerHTML = "";
  $("g-chart-track").innerHTML = "";
  $("g-missions").innerHTML = "";
  $("g-you").hidden = true;
  $("g-spectate").hidden = true;
  $("g-coach").hidden = true;
  $("g-coach-btn").hidden = true;
  $("g-log-count").textContent = "";
}

function renderGame() {
  const { view } = game;
  const st = view.state;
  const spectator = view.human_idx === null;
  const current = view.phase === "bid" || view.phase === "ready" ? st.round_number + 1 : st.round_number;
  $("g-round").textContent = view.phase === "game_over" ? "Final round played" : `Round ${current} of ${TOTAL_AUCTIONS}`;
  $("g-progress").style.width = `${(st.round_number / TOTAL_AUCTIONS) * 100}%`;
  $("g-meta").innerHTML = [
    `<span class="chip">Chart ${st.value_chart} · ${CHARTS[st.value_chart].label}</span>`,
    `<span class="chip">${st.auction_deck_count} auctions left</span>`,
    `<span class="chip">${st.gem_deck_count} gems in deck</span>`,
    `<span class="chip" title="Enter this seed on the setup screen to replay the same deal">Seed ${view.seed}</span>`,
  ].join("");

  renderSeats();
  renderAuction();
  renderMarket($("g-market"), st, spectator ? null : st.players[view.human_idx]);
  renderChartTrack();
  renderMissions();
  $("g-you").hidden = spectator;
  $("g-spectate").hidden = !spectator;
  if (!spectator) renderYou();
  renderAction();
  renderCoach();
  $("g-log-count").textContent = game.log.length ? `${game.log.length} played` : "";
}

function renderSeats() {
  const { view } = game;
  const st = view.state;
  const last = view.last_round || game.log[game.log.length - 1] || null;
  $("g-opponents").innerHTML = st.players.map((ps, i) => {
    const isYou = i === view.human_idx;
    const winner = last && last.winner_idx === i;
    const kind = view.seat_kinds[i];
    const bot = BOT_BY_KIND[kind];
    const hand = ps.hand
      ? `<div class="gem-row">${gemList(ps.hand, "sm")}</div>`
      : `<span class="hand-backs" title="${ps.hand_size} gems in hand">${"<i></i>".repeat(ps.hand_size)}</span>`;
    const extras = [
      ...ps.loans.map((a) => `<span class="chip loan">Loan −${a}</span>`),
      ...ps.investments.map((x) => `<span class="chip invest">Invest ${x.locked}+${x.amount}</span>`),
      ...ps.completed_missions.map((m) => `<span class="chip mission" title="${esc(m.name)}">★ +${m.coins}</span>`),
    ].join("");
    return `<article class="seat-card${winner ? " winner" : ""}${isYou ? " you" : ""}">
      ${last ? `<span class="last-bid">${winner ? "won · " : ""}bid ${last.bids[i]}</span>` : ""}
      <div class="seat-card-head">
        <div class="who"><b>${esc(ps.name)}</b>${isYou ? '<span class="chip">You</span>' : `<span class="chip kind" title="${esc(bot?.tier || "")}">${esc(bot?.label || kind)}</span>`}</div>
        ${coin(ps.coins)}
      </div>
      <div class="stats"><span>Hand</span>${hand}</div>
      <div class="stats"><span>Collected</span><span class="gem-row">${gemCounts(ps.collection)}</span></div>
      ${extras ? `<div class="stats">${extras}</div>` : ""}
      <div class="score-now" title="Coins + collected gems at today's values + missions + investments − loans (hands not counted)">Worth now: <b>${scoreNow(st, ps)}</b></div>
    </article>`;
  }).join("");
}

function renderAuction() {
  const { view } = game;
  const st = view.state;
  const el = $("g-auction");
  const a = view.auction;
  if (!a) {
    el.className = "auction";
    el.innerHTML = `<div class="auction-kind">Auction deck empty</div><div class="auction-title">Scoring…</div>`;
    return;
  }
  el.className = `auction ${a.kind}`;
  const won = view.phase === "reveal" ? `<span class="chip mission">You won this auction</span>` : "";
  let body = "";
  if (a.kind === "treasure") {
    // In the reveal phase the gems have already moved into your collection.
    const offered = view.phase === "reveal" ? [] : st.revealed_gems;
    const slots = offered.map((c, i) => `<span class="slot${i < a.gems ? "" : " off"}" title="${i < a.gems ? "Goes to the winner" : "Stays face-up"}">${gem(c, "xl")}</span>`).join("");
    const value = offered.slice(0, a.gems).reduce((s, c) => s + chartValue(st.value_chart, st.value_display[c] || 0), 0);
    body = `<div class="auction-title">Treasure ×${a.gems}</div>
      ${view.phase === "reveal" ? "" : `<div class="auction-gems">${slots || '<span class="empty">no gems left</span>'}</div>`}
      <div class="auction-sub">${view.phase === "reveal" ? "The gems are in your collection." : `Winner takes the highlighted gem${a.gems > 1 ? "s" : ""}. Worth ${coin(value)} at today's display.`}</div>`;
  } else if (a.kind === "loan") {
    body = `<div class="auction-title">Loan ${coin(a.amount)}</div>
      <div class="auction-sub">Winner pays their bid, receives ${a.amount} now and repays ${a.amount} at game end. You may bid up to your coins + ${a.amount}.</div>`;
  } else {
    body = `<div class="auction-title">Invest ${coin(a.amount)}</div>
      <div class="auction-sub">Winner's bid is locked away and paid back at game end with a +${a.amount} bonus.</div>`;
  }
  el.innerHTML = `<div class="auction-kind">${a.kind}</div>${won}${body}
    <div class="auction-deck">${st.auction_deck_count - (view.phase === "reveal" ? 0 : 1)} more auction cards after this</div>`;
}

function renderMarket(el, st, me, { final = false } = {}) {
  el.innerHTML = COLORS.map((c) => {
    const n = st.value_display[c] || 0;
    const val = chartValue(st.value_chart, n);
    const nxt = chartValue(st.value_chart, n + 1);
    const dir = nxt > val ? "up" : nxt < val ? "down" : "";
    const pips = Array.from({ length: 5 }, (_, i) => `<i class="${i < n ? "on" : ""}"></i>`).join("");
    const owned = st.players.reduce((s, p) => s + (p.collection[c] || 0), 0);
    const mine = me
      ? `hand ${(me.hand || []).filter((x) => x === c).length}<br>owned ${me.collection[c] || 0}`
      : `collected ${owned}`;
    return `<div class="mcol" style="color:${COLOR_HEX[c]}">
      ${gem(c, "lg")}
      <span class="pips" title="${n} in display">${pips}</span>
      <span class="val" style="color:var(--text)">${val}</span>
      ${final ? "" : `<span class="next ${dir}" title="Value if one more ${c} is revealed">${n >= 5 ? "maxed" : `next → ${nxt}`}</span>`}
      <span class="mine">${mine}</span>
    </div>`;
  }).join("");
}

function renderChartTrack() {
  const st = game.view.state;
  const vals = CHARTS[st.value_chart].values;
  $("g-chart-name").textContent = `· chart ${st.value_chart}`;
  $("g-chart-track").innerHTML =
    `<span class="label">in display</span>${vals.map((_, i) => `<span>${i === 5 ? "5+" : i}</span>`).join("")}` +
    `<span class="label">gem worth</span>${vals.map((v) => `<span style="color:var(--text);font-weight:600">${v}</span>`).join("")}`;
}

function renderMissions() {
  const { view } = game;
  const st = view.state;
  const me = view.human_idx === null ? null : st.players[view.human_idx];
  $("g-missions-left").textContent = `${st.active_missions.length} open`;
  if (!st.active_missions.length) {
    $("g-missions").innerHTML = '<span class="empty">All missions claimed.</span>';
    return;
  }
  $("g-missions").innerHTML = st.active_missions.map((m) => {
    const need = me ? missionNeed(m.name, me.collection) : null;
    const close = need === 1;
    const note = need === null ? "" : `<span class="progress-note">${need === 0 ? "Complete!" : `You need ${need} more gem${need > 1 ? "s" : ""}`}</span>`;
    return `<div class="mission${close ? " close" : ""}" title="${esc(m.name)}">
      <div class="mission-head"><span>${esc(m.category)}</span>${coin(m.coins)}</div>
      <div class="mission-req">${missionReq(m.name)}</div>${note}</div>`;
  }).join("");
}

function renderYou() {
  const { view } = game;
  const me = view.state.players[view.human_idx];
  $("g-you-name").textContent = me.name;
  $("g-you-score").innerHTML = `worth now <b style="color:var(--text)">${scoreNow(view.state, me)}</b>`;
  $("g-you-stats").innerHTML = `${coin(me.coins)}<span class="muted small">coins to bid with</span>`;
  $("g-you-hand").innerHTML = gemList(me.hand || [], "lg");
  $("g-you-collection").innerHTML = gemCounts(me.collection, "");
  const extras = [
    ...me.loans.map((a) => `<span class="chip loan">Loan: repay ${a}</span>`),
    ...me.investments.map((x) => `<span class="chip invest">Invest: ${x.locked} + ${x.amount} back</span>`),
    ...me.completed_missions.map((m) => `<span class="chip mission">★ ${esc(missionText(m.name))} +${m.coins}</span>`),
  ];
  $("g-you-extras").innerHTML = extras.length ? `<h4>Loans, investments, missions</h4><div class="gem-row">${extras.join("")}</div>` : "";
}

function renderAction() {
  const el = $("g-action");
  if (!game || !game.view) return;
  const { view } = game;
  el.classList.remove("live");
  if (view.human_idx === null) {
    $("sp-step").disabled = game.busy || view.phase !== "ready";
    return;
  }
  if (game.busy) {
    el.innerHTML = `<div class="waiting"><span class="spinner"></span>Bots are bidding…</div>`;
    return;
  }
  if (view.phase === "bid") return renderBid(el);
  if (view.phase === "reveal") return renderReveal(el);
  el.innerHTML = `<div class="waiting">Game over: tallying scores…</div>`;
}

function renderBid(el) {
  const { view } = game;
  const st = view.state;
  const a = view.auction;
  const max = view.max_bid;
  const me = st.players[view.human_idx];
  let hint = "";
  if (a.kind === "treasure") {
    const worth = st.revealed_gems.slice(0, a.gems).reduce((s, c) => s + chartValue(st.value_chart, st.value_display[c] || 0), 0);
    hint = `The gem${a.gems > 1 ? "s are" : " is"} worth ${coin(worth)} at today's display. Final value depends on what gets revealed.`;
  } else if (a.kind === "invest") {
    hint = `Whatever you pay comes back at the end, plus ${a.amount}. It just ties up coins.`;
  } else {
    hint = `Your bid is a cost: the ${a.amount} you receive is repaid at the end. Worth it only if you need cash now.`;
  }
  const quick = [...new Set([0, 1, Math.round(max / 4), Math.round(max / 2), max])].filter((v) => v <= max);
  const adv = prefs.coach ? adviceFor(view) : null;
  const coachQuick = adv ? `<button type="button" class="btn sm coach-q" data-q="${adv.suggested}" title="EV coach suggestion">Coach ${adv.suggested}</button>` : "";
  el.classList.add("live");
  el.innerHTML = `<h3>Your sealed bid</h3>
    <p class="muted small" style="margin:0">${hint}</p>
    <div class="bid-amount">
      <input id="bid-num" type="number" min="0" max="${max}" value="0" inputmode="numeric" aria-label="Bid amount">
      <span class="of">of ${max} max${a.kind === "loan" ? ` (${me.coins} + loan)` : ""}</span>
    </div>
    <input id="bid-range" type="range" min="0" max="${max}" value="0" aria-label="Bid slider">
    <div class="quick">${coachQuick}${quick.map((v) => `<button type="button" class="btn sm ghost" data-q="${v}">${v === max ? `All in (${v})` : v}</button>`).join("")}</div>
    <button id="bid-go" type="button" class="btn primary lg block">Bid 0 <span class="kbd">Enter</span></button>`;
  const num = $("bid-num"), range = $("bid-range"), go = $("bid-go");
  const set = (v) => {
    v = Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
    num.value = v; range.value = v;
    go.innerHTML = `Bid ${v} <span class="kbd">Enter</span>`;
  };
  setBid = set;
  num.oninput = () => set(num.value);
  range.oninput = () => set(range.value);
  for (const b of el.querySelectorAll("[data-q]")) b.onclick = () => set(b.dataset.q);
  const submit = () => { set(num.value); act("bid", { amount: Number(num.value) }); };
  go.onclick = submit;
  num.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };
}

function renderReveal(el) {
  const { view } = game;
  const st = view.state;
  const me = st.players[view.human_idx];
  const options = [...new Set(me.hand)];
  el.classList.add("live");
  el.innerHTML = `<h3>You won! Reveal a gem</h3>
    <p class="muted small" style="margin:0">Pick one gem from your hand to add to the Value Display. It changes what every gem of that colour is worth, for you and for everyone else.</p>
    <div class="reveal-options">${options.map((c) => {
      const n = st.value_display[c] || 0;
      const before = chartValue(st.value_chart, n), after = chartValue(st.value_chart, n + 1);
      const owned = me.collection[c] || 0;
      const swing = (after - before) * owned;
      const cls = after > before ? "pos" : after < before ? "neg" : "";
      return `<button type="button" class="reveal-opt" data-color="${c}">${gem(c, "lg")}
        <span><b>${c}</b><br><span class="delta">worth <b>${before}</b> → <b class="${cls}">${after}</b> each · your ${owned} collected: <b class="${cls}">${swing >= 0 ? "+" : ""}${swing}</b></span></span></button>`;
    }).join("")}</div>`;
  for (const b of el.querySelectorAll("[data-color]")) b.onclick = () => act("reveal", { color: b.dataset.color });
}

// --------------------------------------------------------------------------
// EV coach (play mode, bid phase)
// --------------------------------------------------------------------------

const num1 = (x) => (x === null || x === undefined ? "—" : x.toFixed(1));
const signed = (x, digits = 0) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(digits)}`;
const signCls = (x) => (x > 0 ? "pos" : x < 0 ? "neg" : "");
const VERDICTS = { buy: ["Buy", "pos"], thin: ["Thin margin", "warn"], shot: ["Long shot", "info"], pass: ["Pass", "muted"] };

let setBid = null; // renderBid's setter, so the coach can fill the bid box

// One advise() per view. The coach is an add-on: if it throws, log it and
// carry on without it rather than breaking the game.
function adviceFor(view) {
  if (game.advice?.view !== view) {
    let adv = null;
    try { adv = advise(view); } catch (err) { console.error("EV coach failed:", err); }
    game.advice = { view, adv };
  }
  return game.advice.adv;
}

function toggleCoach() {
  prefs.coach = !prefs.coach;
  savePrefs();
  if (!game?.view) return;
  const typed = $("bid-num")?.value; // keep a half-entered bid across the re-render
  renderAction();
  if (typed !== undefined && game.view.phase === "bid" && !game.busy) setBid?.(typed);
  renderCoach();
}

const tile = (label, value, title, cls = "") => `<div class="ctile ${cls}" title="${esc(title)}"><span>${label}</span><b>${value}</b></div>`;
const tieText = (t) => (t === true ? "you win" : t === false ? "they win" : "random");

function renderCoach() {
  const { view } = game;
  const btn = $("g-coach-btn");
  btn.hidden = view.human_idx === null;
  btn.setAttribute("aria-pressed", String(prefs.coach));
  btn.textContent = prefs.coach ? "Coach: on" : "Coach: off";
  const el = $("g-coach");
  el.classList.remove("stale");
  const adv = prefs.coach && view.human_idx !== null && view.phase === "bid" ? adviceFor(view) : null;
  el.hidden = !adv;
  if (!adv) return;

  const [vLabel, vCls] = VERDICTS[adv.verdict];
  const tiles = [];
  if (adv.kind === "treasure") {
    tiles.push(tile("Fair value", num1(adv.fair), "Expected final worth of these gems from your seat, plus any mission this lot completes for you"));
    tiles.push(tile("Break-even", adv.breakEven, "Highest bid that still profits at face value"));
    if (adv.cashValue > 1.05) tiles.push(tile("Worth paying", `≤ ${adv.ceiling}`, "Break-even after charging each coin at its current value"));
  } else if (adv.kind === "invest") {
    tiles.push(tile("A win pays", `+${adv.fair}`, "Your bid comes back at the end, plus the bonus"));
    tiles.push(tile("Spare cash", adv.spare, `Coins above a ~${adv.reserve} reserve for later lots`));
  } else {
    tiles.push(tile("Your coins", adv.coins, "Coins you hold before the loan"));
    tiles.push(tile("Reserve", adv.reserve, "Rough cash the remaining lots call for"));
  }
  tiles.push(tile("Suggested bid", adv.suggested, "The coach's bid", "main"));
  if (adv.winProb !== null && adv.suggested > 0) tiles.push(tile("Win chance", `${Math.round(adv.winProb * 100)}%`, "Estimated from public information"));

  const parts = [`<div class="coach-head">
      <div class="ctiles">${tiles.join("")}</div>
      <div class="coach-call">
        <span class="verdict ${vCls}">${vLabel}</span>
        <p>${esc(adv.reason)}</p>
        <button id="coach-use" type="button" class="btn sm primary">Use suggested bid (${adv.suggested})</button>
      </div>
    </div>`];
  if (adv.cashValue > 1.05) {
    parts.push(`<p class="coach-note">Coins are worth about <b>${adv.cashValue.toFixed(1)}×</b> right now: roughly ${Math.round(adv.futureValue)} coins of value
      is still to be auctioned against ${adv.cashInPlay} coins in play, so the coach charges every coin you pay at that rate.</p>`);
  }
  if (adv.kind === "treasure") parts.push(coachTreasure(adv));
  else if (adv.kind === "invest") parts.push(coachRivals(adv, false));
  parts.push(coachColors(adv));
  $("g-coach-body").innerHTML = parts.join("");

  $("coach-use").onclick = () => {
    setBid?.(adv.suggested);
    $("g-action").scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  $("coach-colors").ontoggle = (e) => { prefs.coachColors = e.target.open; savePrefs(); };
}

function coachTreasure(adv) {
  const byColor = Object.fromEntries(adv.colorRows.map((r) => [r.color, r]));
  const gems = adv.offered.map((c) => `<span class="lot-gem">${gem(c, "sm")}<b>${num1(byColor[c].ev)}</b><span class="muted">now ${byColor[c].valueNow}</span></span>`).join("");
  const missions = adv.missions.map((m) => `<span class="chip mission">★ ${esc(missionText(m.name))} +${m.coins}</span>`).join("");
  const edge = Math.abs(adv.edge) >= 0.5
    ? `<span class="${signCls(adv.edge)}">Your hand moves this lot ${signed(adv.edge, 1)}</span> against the public estimate of ${num1(adv.publicGemsEv)}.`
    : `Public estimate ${num1(adv.publicGemsEv)}: your hand adds nothing here.`;
  const notes = [
    ...adv.setsUp.map((m) => `<li>Sets you up: one gem from <b>${esc(missionText(m.name))}</b> (+${m.coins}).</li>`),
    ...adv.denial.map((d) => `<li>Denial: this lot would complete <b>${esc(missionText(d.name))}</b> (+${d.coins}) for ${esc(d.rival)}.</li>`),
  ];
  return `<div class="coach-lot">
      <div class="gem-row">${gems || '<span class="empty">no gems</span>'}${missions}</div>
      <p class="muted small">EV per gem from your seat, against its value at today's display. ${edge}</p>
      ${notes.length ? `<ul class="coach-notes">${notes.join("")}</ul>` : ""}
    </div>${coachRivals(adv, true)}`;
}

function coachRivals(adv, treasure) {
  const rows = adv.rivals.map((r) => `<tr>
      <td><b>${esc(r.name)}</b></td>
      <td>${coin(r.coins)}</td>
      ${treasure ? `<td>${num1(r.value)}${r.missions.length ? ` <span class="chip mission" title="${esc(r.missions.map((m) => m.name).join(", "))}">★ +${r.missions.reduce((s, m) => s + m.coins, 0)}</span>` : ""}</td>` : ""}
      <td>~${r.likely}</td>
      <td class="${r.youWinTie === true ? "pos" : r.youWinTie === false ? "neg" : ""}">${tieText(r.youWinTie)}</td>
    </tr>`).join("");
  return `<div class="coach-table-wrap"><table class="coach-table">
      <thead><tr><th>Rival</th><th>Cash</th>${treasure ? "<th>Est. value</th>" : ""}<th>Likely bid</th><th>Ties</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="muted small">Rival figures are estimates from public information: each rival also knows its own hand.${adv.firstAuction ? " First auction, so ties are broken at random." : ""}</p>`;
}

function coachColors(adv) {
  const rows = adv.colorRows.map((r) => {
    const bars = r.probs.map((p, d) => `<i style="height:${Math.max(p > 0 ? 8 : 0, Math.round(p * 100))}%" title="${d} in display: ${Math.round(p * 100)}%"></i>`).join("");
    const big = Math.abs(r.edge) >= 1.5 ? " big" : "";
    return `<tr>
      <td>${gem(r.color, "sm")} <span class="hide-sm">${r.color}</span></td>
      <td>${num1(r.expDisplay)} <span class="muted">(${r.known}–${r.maxFinal})</span></td>
      <td><span class="pbars" aria-hidden="true">${bars}</span></td>
      <td><b>${num1(r.ev)}</b></td>
      <td>${r.valueNow}</td>
      <td class="edge ${signCls(Math.round(r.edge * 10))}${big}" title="Per-gem EV from your seat minus the public view's">${Math.abs(r.edge) < 0.05 ? "0" : signed(r.edge, 1)}</td>
    </tr>`;
  }).join("");
  return `<details id="coach-colors" class="coach-colors"${prefs.coachColors ? " open" : ""}>
      <summary>Per-colour expected value</summary>
      <div class="coach-table-wrap"><table class="coach-table colors">
        <thead><tr><th>Colour</th><th title="Expected final display count (guaranteed minimum–maximum)">Final display</th><th title="Chance of each final count, 0 to 6">Odds 0–6</th>
          <th title="Expected end-of-game value of one gem">EV/gem</th><th title="Value at today's display">Now</th><th title="Your EV minus the public view's: where your hand tells you something the table doesn't">Edge</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
    </details>`;
}

function appendLog(r, view) {
  const st = view.state;
  const rationale = r.rationale
    ? `<details><summary>Bot reasoning</summary><div class="rationale">${r.rationale.map((x, i) => x
        ? `<div><b>${esc(st.players[i].name)}</b> <span class="muted small">${esc(x.ai_class)} · bid ${r.bids[i]}</span><pre>${esc(x.lines.join("\n") || "(no detail)")}</pre></div>`
        : "").join("")}</div></details>`
    : "";
  const missions = r.completed_missions.map((m) => `<div>★ ${esc(st.players[m.player_idx].name)}: ${esc(missionText(m.mission.name))} <b>+${m.mission.coins}</b></div>`).join("");
  const div = document.createElement("div");
  div.className = "log-entry fresh";
  div.innerHTML = `<div class="log-head"><span>Round ${r.round} · <b>${auctionText(r.auction)}</b></span><span><b>${esc(st.players[r.winner_idx].name)}</b> wins</span></div>
    <div class="log-bids">${r.bids.map((b, i) => `<span class="chip${i === r.winner_idx ? " win" : ""}" title="${esc(seatLabel(view, i))}">${esc(st.players[i].name)} ${b}</span>`).join("")}</div>
    <div class="gem-row">${r.taken_gems.length ? `<span class="muted small">took</span>${gemList(r.taken_gems, "sm")}` : ""}
      ${r.revealed_gem ? `<span class="muted small">revealed</span>${gem(r.revealed_gem, "sm")}` : ""}</div>
    ${missions}${rationale}`;
  const log = $("g-log");
  log.prepend(div);
}

// --------------------------------------------------------------------------
// End screen
// --------------------------------------------------------------------------

function renderEnd() {
  const { view, config } = game;
  const rows = view.scores.map((s, i) => ({ ...s, i })).sort((a, b) => b.total - a.total);
  const top = rows[0].total;
  const winners = rows.filter((r) => r.total === top);
  const youWon = winners.some((r) => r.i === view.human_idx);
  let title;
  if (view.human_idx === null) title = winners.length > 1 ? "A shared victory" : `${esc(winners[0].name)} wins`;
  else if (youWon) title = winners.length > 1 ? "You tied for the win!" : "You win!";
  else title = `${esc(winners[0].name)} wins`;
  $("end-title").innerHTML = title;
  const myRank = view.human_idx === null ? null : rows.findIndex((r) => r.i === view.human_idx) + 1;
  $("end-sub").textContent = [
    myRank && !youWon ? `You finished #${myRank} of ${rows.length}` : null,
    `Chart ${view.state.value_chart}`,
    `${rows.length} players`,
    `seed ${view.seed}`,
  ].filter(Boolean).join(" · ");
  $("end-gems").innerHTML = COLORS.map((c) => gem(c, "lg")).join("");

  let rank = 0, prev = null;
  $("end-scores").innerHTML = rows.map((r, n) => {
    if (r.total !== prev) { rank = n + 1; prev = r.total; }
    const hand = view.final_hands?.[r.i] || [];
    return `<tr class="${r.total === top ? "first" : ""}${r.i === view.human_idx ? " me" : ""}">
      <td><span class="rank">${rank}</span><b>${esc(r.name)}</b> ${r.i === view.human_idx ? "" : `<span class="chip kind">${esc(seatLabel(view, r.i))}</span>`}
        ${hand.length ? `<div class="gem-row" style="margin-top:4px"><span class="muted small">hand</span>${gemList(hand, "sm")}</div>` : ""}</td>
      <td>${r.coins}</td><td>${r.gem_value}</td><td>${r.mission_value}</td>
      <td class="${r.invest_returns ? "pos" : ""}">${r.invest_returns ? "+" + r.invest_returns : 0}</td>
      <td class="${r.loans_total ? "neg" : ""}">${r.loans_total ? "−" + r.loans_total : 0}</td>
      <td class="total">${r.total}</td></tr>`;
  }).join("");
  renderMarket($("end-market"), view.state, null, { final: true });
  try {
    renderAnalysis();
  } catch (err) {
    console.error("Game analysis failed:", err);
    $("end-analysis").innerHTML = `<p class="empty">Analysis unavailable: ${esc(err.message)}</p>`;
  }
  hideToast();
  showScreen("end");
  $("end-rematch").onclick = () => startGame({ ...config });
  $("end-again").onclick = () => startGame({ ...config, seed: null });
}

// Game analysis ------------------------------------------------------------

const ROUND_VERDICTS = {
  overpaid: ["Overpaid", "neg"], unlucky: ["Unlucky", "warn"], overbid: ["Overbid", "warn"], good: ["Good", "pos"],
  "loan-cost": ["Loan cost", "neg"], missed: ["Missed", "info"], "missed-invest": ["Missed", "info"],
};

function renderAnalysis() {
  const { view } = game;
  const res = analyze(view, game.log, game.snapshots);
  const me = view.human_idx;
  const s = res.summary;
  const parts = [];

  if (s) {
    const lead = s.leader.idx === me ? "the best at the table" : `${esc(s.leader.name)} led with ${signed(s.leader.surplus)}`;
    parts.push(`<p class="an-identity">Your score = <b>${res.start}</b> starting coins <b class="${signCls(s.you.surplus)}">${signed(s.you.surplus)}</b> surplus = <b>${s.you.score}</b>.
      You ranked #${s.surplusRank} on surplus, ${lead}.</p>`);
  } else {
    parts.push(`<p class="an-identity">Every score = <b>${res.start}</b> starting coins + the surplus from the lots that player won.</p>`);
  }
  parts.push(`<p class="muted small">Surplus is what a lot was worth to its winner minus the price. A treasure is worth its gems at the final display
    plus any missions it completed, an invest is worth its bid plus the bonus, and a loan is worth nothing (you repay what you borrowed).</p>`);

  const order = res.players.map((p, i) => ({ ...p, i })).sort((a, b) => b.surplus - a.surplus);
  const off = res.players.filter((p) => p.score !== null && p.predictedScore !== p.score);
  parts.push(`<div class="score-table-wrap"><table class="score-table an-players">
      <thead><tr><th>Player</th><th>Lots won</th><th>Paid</th><th>Treasure</th><th>Loans</th><th>Invest</th><th>Surplus</th><th title="Treasure lots won for more than they turned out to be worth">Overpays</th></tr></thead>
      <tbody>${order.map((p) => `<tr class="${p.i === me ? "me" : ""}">
        <td><b>${esc(p.name)}</b> ${p.i === me ? "" : `<span class="chip kind">${esc(seatLabel(view, p.i))}</span>`}</td>
        <td>${p.lotsWon}</td><td>${p.paid}</td>
        <td class="${signCls(p.treasureSurplus)}">${signed(p.treasureSurplus)}</td>
        <td class="${signCls(p.loanSurplus)}">${signed(p.loanSurplus)}</td>
        <td class="${signCls(p.investSurplus)}">${signed(p.investSurplus)}</td>
        <td class="total ${signCls(p.surplus)}">${signed(p.surplus)}</td>
        <td>${p.overpays}</td></tr>`).join("")}</tbody></table></div>`);
  if (off.length) parts.push(`<p class="neg small">Ledger mismatch for ${off.map((p) => esc(p.name)).join(", ")}: the surplus doesn't add up to the final score.</p>`);

  if (s) {
    const card = (title, rows, chip, empty, text = (r) => r.note) => `<div class="an-card"><h4>${title}</h4>${rows.length
      ? `<ol>${rows.map((r) => `<li>${chip(r)}<span>${esc(text(r))}</span></li>`).join("")}</ol>`
      : `<p class="empty">${empty}</p>`}</div>`;
    const bought = (r) => `R${r.round} ${auctionText(r.auction)}: paid ${r.price} for ${r.auction.kind === "invest" ? `+${r.auction.amount} back` : `a lot worth ${r.gross}`}.`;
    const acc = s.estimateMae === null
      ? '<p class="empty">No treasure lots to compare.</p>'
      : `<p>Over ${s.estimateCount} treasure lots, the fair value from your seat missed what the lot turned out to be worth to you by
          <b>${s.estimateMae.toFixed(1)}</b> coins on average, and ran <b class="${s.estimateBias > 0.5 ? "warn" : s.estimateBias < -0.5 ? "info" : ""}">${Math.abs(s.estimateBias).toFixed(1)} ${s.estimateBias >= 0 ? "high" : "low"}</b>.</p>
         <p class="muted small">That's the luck in the hidden hands: the fair value is an exact expectation, so the miss is what nobody could see at bid time.</p>`;
    parts.push(`<div class="an-grid">
        ${card("Your biggest leaks", s.leaks, (r) => `<span class="chip neg">−${r.loss}</span>`, "No leaks: nothing overpaid or overbid.")}
        ${card("Missed bargains", s.missed, (r) => `<span class="chip info">+${r.gain}</span>`, "No lot you could afford went cheap.")}
        ${card("Best buys", s.best, (r) => `<span class="chip pos">+${r.surplus}</span>`, "No profitable lots won.", bought)}
        <div class="an-card"><h4>Estimate accuracy</h4>${acc}</div>
      </div>`);
  }

  const head = me === null
    ? "<th>Rd</th><th>Lot</th><th>Winner</th><th>Price</th><th>Worth</th><th>Surplus</th><th title=\"The winner's fair value from its own seat at bid time\">Winner's fair</th>"
    : "<th>Rd</th><th>Lot</th><th>Winner</th><th>Price</th><th>Worth</th><th>Surplus</th><th>Your bid</th><th title=\"Fair value from your seat at bid time\">Your fair</th><th>Verdict</th>";
  const rows = res.rounds.map((r) => {
    const fair = r.auction.kind === "treasure" ? (me === null ? r.fair[r.winner] : r.myFair) : null;
    const v = r.verdict ? ROUND_VERDICTS[r.verdict] : null;
    return `<tr class="${r.winner === me ? "me" : ""}" title="${esc(r.note || "")}">
      <td>${r.round}</td>
      <td class="lot">${auctionText(r.auction)} ${r.taken.length ? `<span class="gem-row">${gemList(r.taken, "sm")}</span>` : ""}</td>
      <td>${esc(view.state.players[r.winner].name)}</td>
      <td>${r.price}</td><td>${r.gross}</td>
      <td class="${signCls(r.surplus)}">${signed(r.surplus)}</td>
      ${me === null ? `<td>${num1(fair)}</td>` : `<td>${r.myBid}</td><td>${num1(fair)}</td><td>${v ? `<span class="chip ${v[1]}">${v[0]}</span>` : ""}</td>`}
    </tr>`;
  }).join("");
  parts.push(`<details class="an-rounds"><summary>Round by round</summary>
      <div class="score-table-wrap"><table class="score-table an-round-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>
      ${me === null ? "" : '<p class="muted small">Hover or tap a row for the details behind its verdict.</p>'}
    </details>`);

  $("end-analysis").innerHTML = parts.join("");
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

engine.onStatus = renderEngineStatus;
renderEngineStatus(engine.status, "Starting the Python engine…");
wireSetup();
renderSetup();

$("nav-quit").onclick = quitGame;
$("end-setup").onclick = () => { game = null; showScreen("setup"); };
$("sp-step").onclick = () => { stopAuto(); act("step"); };
$("sp-auto").onclick = toggleAuto;
$("sp-speed").onchange = () => { if (game?.auto && !game.busy) scheduleAuto(); };
$("g-coach-btn").onclick = toggleCoach;

document.addEventListener("keydown", (e) => {
  if (!game || $("screen-game").hidden || e.target.matches("input, select, textarea")) return;
  const phase = game.view?.phase;
  if (phase === "ready" || (game.auto && game.busy)) {
    if (e.key === " ") { e.preventDefault(); toggleAuto(); }
    else if (e.key.toLowerCase() === "n" && phase === "ready") { stopAuto(); act("step"); }
  } else if (phase === "bid" && e.key === "Enter" && !e.target.matches("button")) {
    e.preventDefault();
    $("bid-go")?.click();
  }
});
