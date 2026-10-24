// Tests for web/coach.js. Run with: node --test web/tests/
//
// Includes a small independent JS re-implementation of the MegaGem rules
// (mirroring research/megagem/engine.py) to generate random games with the
// same view shapes BrowserSession produces.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLORS, beliefs, hypergeomPmf, missionSatisfied, missionNeed,
  missionsCompletedBy, tieOrder, advise, analyze, STARTING_COINS,
} from "../coach.js";

const CHARTS = {
  A: [0, 4, 8, 12, 16, 20], B: [20, 16, 12, 8, 4, 0], C: [0, 2, 5, 9, 14, 20],
  D: [20, 18, 15, 11, 6, 0], E: [0, 4, 10, 18, 6, 0],
};
const chartAt = (ch, n) => ch[Math.min(Math.max(n, 0), 5)];

// ---------------------------------------------------------------- rng
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffle = (arr, rnd) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

// ---------------------------------------------------------------- missions
function missionDeck() {
  const d = [{ name: "Shield: 4 different colors", coins: 10, category: "shield" }, { name: "Shield: 2 pairs", coins: 15, category: "shield" },
    { name: "Pendant: 2 of the same color", coins: 5, category: "pendant" }];
  for (const c of COLORS) d.push({ name: `Pendant: 2 ${c}`, coins: 5, category: "pendant" });
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) d.push({ name: `Pendant: 1 ${COLORS[i]} + 1 ${COLORS[j]}`, coins: 5, category: "pendant" });
  d.push({ name: "Crown: 3 of the same color", coins: 10, category: "crown" }, { name: "Crown: 3 different colors", coins: 10, category: "crown" });
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) for (let k = j + 1; k < 5; k++)
    d.push({ name: `Crown: 1 ${COLORS[i]} + 1 ${COLORS[j]} + 1 ${COLORS[k]}`, coins: 10, category: "crown" });
  return d;
}

// ---------------------------------------------------------------- mini engine
function newGame(nPlayers, chartKey, seed) {
  const rnd = mulberry32(seed);
  const gems = shuffle(COLORS.flatMap((c) => Array(6).fill(c)), rnd);
  const auctions = shuffle([
    ...Array(12).fill({ kind: "treasure", gems: 1 }), ...Array(5).fill({ kind: "treasure", gems: 2 }),
    { kind: "loan", amount: 10 }, { kind: "loan", amount: 10 }, { kind: "loan", amount: 20 }, { kind: "loan", amount: 20 },
    { kind: "invest", amount: 5 }, { kind: "invest", amount: 5 }, { kind: "invest", amount: 10 }, { kind: "invest", amount: 10 },
  ], rnd);
  const missions = shuffle(missionDeck(), rnd);
  const handSize = { 3: 5, 4: 4, 5: 3 }[nPlayers];
  const players = Array.from({ length: nPlayers }, (_, i) => ({
    name: `P${i}`, coins: STARTING_COINS[nPlayers], hand: Array.from({ length: handSize }, () => gems.pop()),
    collection: {}, completed_missions: [], loans: [], investments: [],
  }));
  const revealed = [gems.pop(), gems.pop()];
  return { rnd, chartKey, chart: CHARTS[chartKey], gemDeck: gems, auctions, players, revealed,
    display: {}, active: [missions.pop(), missions.pop(), missions.pop(), missions.pop()], last: null, round: 0 };
}

function serialize(g, viewer) {
  return {
    round_number: g.round, value_chart: g.chartKey, chart_values: [...g.chart],
    auction_deck_count: g.auctions.length, gem_deck_count: g.gemDeck.length,
    revealed_gems: [...g.revealed], value_display: { ...g.display },
    active_missions: g.active.map((m) => ({ ...m })), last_winner_idx: g.last,
    players: g.players.map((p, i) => ({
      name: p.name, coins: p.coins, collection: { ...p.collection }, hand_size: p.hand.length,
      completed_missions: [...p.completed_missions], loans: [...p.loans], investments: p.investments.map((x) => ({ ...x })),
      ...(viewer === null || viewer === i ? { hand: [...p.hand] } : {}),
    })),
  };
}

const gameOver = (g) => !g.auctions.length || (!g.gemDeck.length && !g.revealed.length);

function playRound(g, bidFn) {
  g.round++;
  const a = g.auctions.pop();
  const bids = g.players.map((p, i) => {
    const cap = a.kind === "loan" ? p.coins + a.amount : p.coins;
    return Math.max(0, Math.min(cap, Math.floor(bidFn(i, a, cap))));
  });
  const top = Math.max(...bids);
  const cands = bids.map((b, i) => (b === top ? i : -1)).filter((i) => i >= 0);
  let w;
  if (cands.length === 1) w = cands[0];
  else if (g.last === null) w = cands[Math.floor(g.rnd() * cands.length)];
  else { for (let k = 1; k <= g.players.length; k++) { const idx = (g.last + k) % g.players.length; if (cands.includes(idx)) { w = idx; break; } } }
  const ws = g.players[w];
  const taken = [];
  if (a.kind === "treasure") {
    ws.coins -= bids[w];
    for (let k = 0; k < Math.min(a.gems, g.revealed.length); k++) { const c = g.revealed.shift(); ws.collection[c] = (ws.collection[c] || 0) + 1; taken.push(c); }
  } else if (a.kind === "loan") { ws.coins += a.amount - bids[w]; ws.loans.push(a.amount); }
  else { ws.coins -= bids[w]; ws.investments.push({ amount: a.amount, locked: bids[w] }); }
  let revealedGem = null;
  if (ws.hand.length) { const k = Math.floor(g.rnd() * ws.hand.length); revealedGem = ws.hand.splice(k, 1)[0]; g.display[revealedGem] = (g.display[revealedGem] || 0) + 1; }
  while (g.revealed.length < 2 && g.gemDeck.length) g.revealed.push(g.gemDeck.pop());
  const completed = [];
  for (const m of [...g.active]) {
    for (let i = 0; i < g.players.length; i++) {
      if (missionSatisfied(m.name, g.players[i].collection)) {
        g.players[i].completed_missions.push(m); g.active.splice(g.active.indexOf(m), 1);
        completed.push({ player_idx: i, mission: m }); break;
      }
    }
  }
  g.last = w;
  return { round: g.round, auction: a, bids, winner_idx: w, winning_bid: bids[w], taken_gems: taken, revealed_gem: revealedGem, completed_missions: completed };
}

function scoreGame(g) {
  const finalHands = g.players.map((p) => [...p.hand]);
  for (const p of g.players) { for (const c of p.hand) g.display[c] = (g.display[c] || 0) + 1; p.hand = []; }
  const scores = g.players.map((p) => {
    const gemValue = COLORS.reduce((s, c) => s + (p.collection[c] || 0) * chartAt(g.chart, g.display[c] || 0), 0);
    const mission = p.completed_missions.reduce((s, m) => s + m.coins, 0);
    const loans = p.loans.reduce((s, x) => s + x, 0);
    const inv = p.investments.reduce((s, x) => s + x.amount + x.locked, 0);
    return { name: p.name, coins: p.coins, gem_value: gemValue, mission_value: mission, loans_total: loans, invest_returns: inv, total: p.coins + gemValue + mission - loans + inv };
  });
  return { finalHands, scores };
}

// Play a full random game; human seat 0 uses the coach's suggested bid half the time.
function simulate(nPlayers, chartKey, seed, { human = 0 } = {}) {
  const g = newGame(nPlayers, chartKey, seed);
  const log = [], snapshots = {};
  const advice = [];
  while (!gameOver(g)) {
    const view = { phase: "bid", human_idx: human, state: serialize(g, human), auction: g.auctions[g.auctions.length - 1],
      max_bid: null };
    const a = view.auction;
    if (human !== null) view.max_bid = a.kind === "loan" ? g.players[human].coins + a.amount : g.players[human].coins;
    snapshots[g.round + 1] = view.state;
    const adv = human === null ? null : advise(view);
    if (adv) advice.push({ adv, view });
    const r = playRound(g, (i, auc, cap) => (i === human && adv && g.rnd() < 0.5 ? adv.suggested : g.rnd() * Math.min(cap, 15)));
    log.push(r);
  }
  const { finalHands, scores } = scoreGame(g);
  const endView = { phase: "game_over", human_idx: human, state: serialize(g, null), scores, final_hands: finalHands };
  return { g, log, snapshots, endView, advice };
}

// ---------------------------------------------------------------- tests

test("hypergeometric pmf sums to 1 and has the right mean", () => {
  for (const [N, K, n] of [[23, 4, 10], [10, 0, 5], [7, 7, 3], [15, 6, 15]]) {
    let s = 0, m = 0;
    for (let x = 0; x <= n; x++) { const p = hypergeomPmf(N, K, n, x); s += p; m += x * p; }
    assert.ok(Math.abs(s - 1) < 1e-9, `sum ${s}`);
    assert.ok(Math.abs(m - (n * K) / N) < 1e-9, `mean ${m}`);
  }
});

test("mission parsing matches every requirement shape", () => {
  const col = { Blue: 2, Green: 1, Pink: 1 };
  assert.equal(missionSatisfied("Shield: 4 different colors", col), false);
  assert.equal(missionSatisfied("Crown: 3 different colors", col), true);
  assert.equal(missionSatisfied("Shield: 2 pairs", col), false);
  assert.equal(missionSatisfied("Shield: 2 pairs", { ...col, Green: 2 }), true);
  assert.equal(missionSatisfied("Pendant: 2 of the same color", col), true);
  assert.equal(missionSatisfied("Crown: 3 of the same color", col), false);
  assert.equal(missionSatisfied("Pendant: 2 Blue", col), true);
  assert.equal(missionSatisfied("Pendant: 2 Green", col), false);
  assert.equal(missionSatisfied("Pendant: 1 Blue + 1 Yellow", col), false);
  assert.equal(missionSatisfied("Crown: 1 Blue + 1 Green + 1 Pink", col), true);
  assert.equal(missionNeed("Shield: 4 different colors", col), 1);
  assert.equal(missionNeed("Shield: 2 pairs", col), 1);
  assert.equal(missionNeed("Crown: 3 of the same color", col), 1);
  const done = missionsCompletedBy([{ name: "Pendant: 2 Green", coins: 5 }, { name: "Pendant: 2 Blue", coins: 5 }], col, { Green: 1 });
  assert.deepEqual(done.map((m) => m.name), ["Pendant: 2 Green"]); // Blue already satisfied → would have been claimed
});

test("tie order walks left of the last winner", () => {
  assert.equal(tieOrder({ players: [{}, {}, {}, {}], last_winner_idx: null }), null);
  assert.deepEqual(tieOrder({ players: [{}, {}, {}, {}], last_winner_idx: 1 }), [2, 3, 0, 1]);
});

test("beliefs are exact when nothing is hidden", () => {
  const st = {
    chart_values: CHARTS.A, value_display: { Blue: 2 }, revealed_gems: [], gem_deck_count: 0,
    players: [{ hand: ["Green"], hand_size: 1, collection: { Blue: 4, Green: 5 } }, { hand_size: 0, collection: { Pink: 6, Purple: 6, Yellow: 6 } }],
  };
  const b = beliefs(st, 0);
  assert.equal(b.Blue.expDisplay, 2);
  assert.equal(b.Blue.ev, 8);
  assert.equal(b.Green.expDisplay, 1);
  assert.equal(b.Green.ev, 4);
});

test("final display always lands inside the coach's support, and the support is calibrated", () => {
  let checks = 0, logLik = 0;
  for (let seed = 1; seed <= 120; seed++) {
    for (const n of [3, 4, 5]) {
      const { advice, endView } = simulate(n, "ABCDE"[seed % 5], seed * 7 + n);
      const final = endView.state.value_display;
      for (const { view } of advice) {
        const b = beliefs(view.state, view.human_idx);
        for (const c of COLORS) {
          const d = Math.min(final[c] || 0, 6);
          assert.ok(d >= b[c].known && d <= b[c].maxFinal, `colour ${c} final ${d} outside [${b[c].known}, ${b[c].maxFinal}]`);
          assert.ok(b[c].probs[d] > 0, "actual outcome had zero probability");
          logLik += Math.log(b[c].probs[d]);
          checks++;
        }
      }
    }
  }
  assert.ok(checks > 1000);
  assert.ok(Number.isFinite(logLik));
});

test("expected final display is unbiased over many games", () => {
  // At the opening bid, E[final display] from seat 0's view should match the
  // realised average (it's an exact conditional expectation).
  let predicted = 0, actual = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const { advice, endView } = simulate(4, "A", seed);
    const b = beliefs(advice[0].view.state, 0);
    for (const c of COLORS) { predicted += b[c].expDisplay; actual += endView.state.value_display[c] || 0; }
  }
  const rel = Math.abs(predicted - actual) / actual;
  assert.ok(rel < 0.02, `predicted ${predicted} vs actual ${actual}`);
});

test("score = starting coins + total surplus, for every player", () => {
  for (let seed = 1; seed <= 150; seed++) {
    for (const n of [3, 4, 5]) {
      const { log, snapshots, endView } = simulate(n, "ABCDE"[seed % 5], seed * 13 + n);
      const res = analyze(endView, log, snapshots);
      for (const p of res.players) assert.equal(p.predictedScore, p.score, `seed ${seed} n ${n} ${p.name}`);
    }
  }
});

test("analysis runs in spectator mode and without snapshots", () => {
  const { log, endView } = simulate(4, "E", 99, { human: null });
  const res = analyze({ ...endView, human_idx: null }, log, {});
  assert.equal(res.summary, null);
  assert.equal(res.rounds.length, log.length);
});

test("advice is well formed for every auction type", () => {
  const kinds = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    const { advice } = simulate(3 + (seed % 3), "ABCDE"[seed % 5], seed);
    for (const { adv, view } of advice) {
      kinds.add(adv.kind);
      assert.ok(Number.isInteger(adv.suggested) && adv.suggested >= 0, "suggested bid must be a non-negative integer");
      assert.ok(adv.suggested <= view.max_bid, "suggested bid must be legal");
      assert.equal(adv.colorRows.length, 5);
      if (adv.kind === "treasure") {
        assert.ok(adv.fair >= 0);
        assert.ok(adv.breakEven <= Math.max(0, adv.fair));
        assert.ok(["buy", "thin", "shot", "pass"].includes(adv.verdict));
      }
    }
  }
  assert.deepEqual([...kinds].sort(), ["invest", "loan", "treasure"]);
});

test("coach-following seat beats random bidders on average", () => {
  // Sanity check that the advice is directionally sensible, not a strength claim.
  let coachTotal = 0, otherTotal = 0, games = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const g = newGame(4, "ABCDE"[seed % 5], seed);
    while (!gameOver(g)) {
      const view = { phase: "bid", human_idx: 0, state: serialize(g, 0), auction: g.auctions[g.auctions.length - 1] };
      view.max_bid = view.auction.kind === "loan" ? g.players[0].coins + view.auction.amount : g.players[0].coins;
      const adv = advise(view);
      playRound(g, (i, a, cap) => (i === 0 ? adv.suggested : g.rnd() * Math.min(cap, 15)));
    }
    const { scores } = scoreGame(g);
    coachTotal += scores[0].total;
    otherTotal += (scores[1].total + scores[2].total + scores[3].total) / 3;
    games++;
  }
  assert.ok(coachTotal / games > otherTotal / games + 5, `coach ${coachTotal / games} vs random ${otherTotal / games}`);
});
