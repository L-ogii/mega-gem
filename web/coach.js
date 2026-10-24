// MegaGem EV coach: fair values and suggested bids during play, and a
// surplus breakdown after the game.
//
// Pure functions over the JSON views megagem.browser.BrowserSession
// returns. Nothing here talks to the engine worker, and `advise` only
// reads public state plus the viewer's own hand.
//
// The model rests on one fact: the Value Display only ever receives gems
// from hands, and every hand card is revealed by the end, so a colour's
// final display count is fixed at the deal. From one seat's view the
// unseen cards of a colour are split between rivals' hidden hand slots
// and the face-down deck, which is a hypergeometric split.

export const COLORS = ["Blue", "Green", "Pink", "Purple", "Yellow"];
export const STARTING_COINS = { 3: 35, 4: 25, 5: 20 };

const PER_COLOR = 6;
// Rivals' likely bid as a share of the lot's public value. HeuristicAI uses
// 0.75, but the site's evo bots bid lower: their top bid is typically ~0.55×
// a lot's public EV. 0.6 tracks them better.
const RIVAL_DISCOUNT = 0.6;
const RIVAL_RESERVE_FRACTION = 0.2; // HeuristicAI._reserve_for_future
const GEM_SLOTS_PER_AUCTION = 22 / 25; // 12×1 + 5×2 treasure gems across 25 auction cards
const RESERVE_FRACTION = 0.7;
const RIVAL_SD_MIN = 2; // rivals know their own hands, so their bids spread wider than one public estimate
const RIVAL_SD_FRAC = 0.5;
// Chance a rival doesn't really contest a lot (short of cash, or it's worth
// less to them) and bids anywhere below its likely bid.
const RIVAL_LOWBALL = 0.4;
const CASH_VALUE_MAX = 2;
const MISSION_SHARE = 0.5; // open-mission coins expected to be claimed, for valuing cash
const LOAN_LIQUIDITY_SHARE = 1;
const LOAN_BID_MAX = 6;
// Below this win chance a bid is a lottery ticket, not advice: say pass.
const MIN_WIN_CHANCE = 0.05;

const chartAt = (values, n) => values[Math.min(Math.max(n, 0), 5)];
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const countColors = (colors) => colors.reduce((m, c) => ((m[c] = (m[c] || 0) + 1), m), {});
const fmt = (x) => String(Math.round(x * 10) / 10);
const pct = (p) => `${Math.round(p * 100)}%`;

export function lotText(a) {
  if (a.kind === "treasure") return `Treasure ×${a.gems}`;
  if (a.kind === "loan") return `Loan ${a.amount}`;
  return `Invest ${a.amount}`;
}

// --------------------------------------------------------------------------
// Probability
// --------------------------------------------------------------------------

function choose(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** P(X = x) for X ~ Hypergeometric(population N, K successes, n draws). */
export function hypergeomPmf(N, K, n, x) {
  const total = choose(N, n);
  return total ? (choose(K, x) * choose(N - K, n - x)) / total : 0;
}

// --------------------------------------------------------------------------
// Missions: mirrors the requirement shapes in research/megagem/missions.py
// --------------------------------------------------------------------------

const parsed = new Map();
function parseMission(name) {
  if (parsed.has(name)) return parsed.get(name);
  const text = name.replace(/^[A-Za-z]+:\s*/, "");
  const specific = [...text.matchAll(/(\d+) (Blue|Green|Pink|Purple|Yellow)/g)];
  let m, req = null;
  if (specific.length) req = { kind: "colors", need: Object.fromEntries(specific.map(([, k, c]) => [c, Number(k)])) };
  else if ((m = text.match(/^(\d+) different colors$/))) req = { kind: "distinct", n: Number(m[1]) };
  else if ((m = text.match(/^(\d+) pairs$/))) req = { kind: "pairs", n: Number(m[1]) };
  else if ((m = text.match(/^(\d+) of the same color$/))) req = { kind: "same", n: Number(m[1]) };
  parsed.set(name, req);
  return req;
}

/** Fewest extra gems that would satisfy the mission (0 = satisfied, null = unknown shape). */
export function missionNeed(name, collection) {
  const req = parseMission(name);
  if (!req) return null;
  const counts = COLORS.map((c) => collection[c] || 0);
  if (req.kind === "colors") return sum(Object.entries(req.need).map(([c, k]) => Math.max(0, k - (collection[c] || 0))));
  if (req.kind === "distinct") return Math.max(0, req.n - counts.filter((k) => k > 0).length);
  if (req.kind === "pairs") return sum([...counts].sort((a, b) => b - a).slice(0, req.n).map((k) => Math.max(0, 2 - k)));
  return Math.max(0, req.n - Math.max(...counts));
}

export const missionSatisfied = (name, collection) => missionNeed(name, collection) === 0;

/**
 * Missions a collection would newly complete after gaining `gained`
 * (a colour → count map or a list of colours). Every open mission is
 * unsatisfied by every player (the engine claims it the round it is met),
 * so this is exactly what engine._check_missions would award the winner.
 */
export function missionsCompletedBy(missions, collection, gained) {
  const add = Array.isArray(gained) ? countColors(gained) : gained;
  const after = { ...collection };
  for (const [c, k] of Object.entries(add)) after[c] = (after[c] || 0) + k;
  return missions.filter((m) => !missionSatisfied(m.name, collection) && missionSatisfied(m.name, after));
}

// --------------------------------------------------------------------------
// Beliefs about the final display
// --------------------------------------------------------------------------

/** Seat priority on tied bids: starts left of the last winner. null = random (first auction). */
export function tieOrder(state) {
  const n = state.players.length, last = state.last_winner_idx;
  if (last === null || last === undefined) return null;
  return Array.from({ length: n }, (_, k) => (last + 1 + k) % n);
}

/**
 * Per colour: the final display distribution from `viewerIdx`'s seat
 * (their own hand is known, every other hand is hidden). `viewerIdx =
 * null` is the public view with every hand hidden.
 *
 * Returns { [color]: {known, unseen, maxFinal, expDisplay, probs[0..6], ev, valueNow} },
 * where `known` is the guaranteed minimum and `ev` is E[chart value], not
 * the chart value of E[display].
 */
export function beliefs(state, viewerIdx = null) {
  const chart = state.chart_values;
  const display = state.value_display || {};
  const seen = {}, known = {};
  for (const c of COLORS) seen[c] = known[c] = display[c] || 0;
  for (const c of state.revealed_gems) seen[c]++;
  let hidden = 0;
  state.players.forEach((p, i) => {
    for (const c of COLORS) seen[c] += (p.collection && p.collection[c]) || 0;
    if (i === viewerIdx && Array.isArray(p.hand)) for (const c of p.hand) { seen[c]++; known[c]++; }
    else hidden += p.hand_size ?? (p.hand ? p.hand.length : 0);
  });
  const unseen = Object.fromEntries(COLORS.map((c) => [c, Math.max(0, PER_COLOR - seen[c])]));
  const N = sum(Object.values(unseen));
  const n = Math.min(hidden, N);
  const out = {};
  for (const c of COLORS) {
    const K = unseen[c];
    const probs = Array(PER_COLOR + 1).fill(0);
    for (let x = 0; x <= Math.min(K, n); x++) probs[Math.min(known[c] + x, PER_COLOR)] += hypergeomPmf(N, K, n, x);
    out[c] = {
      known: known[c],
      unseen: K,
      maxFinal: Math.min(known[c] + Math.min(K, n), PER_COLOR),
      expDisplay: sum(probs.map((p, d) => p * d)),
      probs,
      ev: sum(probs.map((p, d) => (p ? p * chartAt(chart, d) : 0))),
      valueNow: chartAt(chart, display[c] || 0),
    };
  }
  return out;
}

// Gems still to be auctioned after this lot (skipping `skip` from the
// front of the row), and their average EV under beliefs `b`.
function futureGems(state, b, skip = 0) {
  const nextAuctions = Math.max(0, state.auction_deck_count - 1);
  const row = state.revealed_gems.slice(skip);
  const count = Math.min(state.gem_deck_count + row.length, nextAuctions * GEM_SLOTS_PER_AUCTION);
  const unseen = sum(COLORS.map((c) => b[c].unseen));
  const deckShare = unseen ? state.gem_deck_count / unseen : 0;
  const onRow = countColors(row);
  const weight = COLORS.map((c) => (onRow[c] || 0) + b[c].unseen * deckShare);
  const total = sum(weight);
  return { count, avgEv: total ? sum(COLORS.map((c, i) => weight[i] * b[c].ev)) / total : 0 };
}

/**
 * Coins worth keeping for later treasure lots: expected gems this seat
 * will buy × average gem EV × 0.7. Rough on purpose.
 */
function cashReserve(state, b) {
  const { count, avgEv } = futureGems(state, b);
  return Math.round((count / state.players.length) * avgEv * RESERVE_FRACTION);
}

/**
 * What a coin in hand is worth in future lot value: the value still to
 * be auctioned over the coins in play, clamped to [1, CASH_VALUE_MAX].
 * There is usually far more value on offer than cash to buy it, so a
 * coin kept now buys more than a coin's worth later, and the coach
 * charges every coin you pay at this rate.
 */
function cashValue(state, pub, skip) {
  const { count, avgEv } = futureGems(state, pub, skip);
  const futureValue = count * avgEv + MISSION_SHARE * sum(state.active_missions.map((m) => m.coins));
  const cashInPlay = sum(state.players.map((p) => p.coins));
  return { lambda: Math.min(CASH_VALUE_MAX, Math.max(1, futureValue / Math.max(1, cashInPlay))), futureValue, cashInPlay };
}

// --------------------------------------------------------------------------
// Rival bids (an estimate: rivals also know their own hands)
// --------------------------------------------------------------------------

// Coins a rival holds back for later lots, as HeuristicAI does: half the
// gems left × the average gem value × 0.2, from the public view.
function rivalReserve(state, pub) {
  const supply = state.gem_deck_count + state.revealed_gems.length;
  const avgEv = sum(COLORS.map((c) => pub[c].ev)) / COLORS.length;
  return Math.floor(Math.floor(supply / 2) * avgEv * RIVAL_RESERVE_FRACTION);
}

// A rival's bid: a discrete bell around the likely bid, mixed with a flat
// lowball below it, so the suggestion trades win chance against margin
// instead of trusting a point estimate. Against the site's bots this keeps
// the shown win chance roughly calibrated in the 30–60% range.
function bidPmf(mu, cap) {
  if (cap <= 0) return [1];
  const sd = Math.max(RIVAL_SD_MIN, RIVAL_SD_FRAC * mu);
  const w = Array.from({ length: cap + 1 }, (_, k) => Math.exp(-((k - mu) ** 2) / (2 * sd * sd)));
  const t = sum(w);
  const low = Math.max(0, Math.min(cap, Math.round(mu)));
  return w.map((x, k) => ((1 - RIVAL_LOWBALL) * x) / t + (k <= low ? RIVAL_LOWBALL / (low + 1) : 0));
}

function winProb(bid, rivals) {
  let p = 1;
  for (const r of rivals) {
    const pmf = r.pmf;
    let below = 0;
    for (let k = 0; k < Math.min(bid, pmf.length); k++) below += pmf[k];
    const at = pmf[bid] || 0;
    p *= below + (r.youWinTie === true ? at : r.youWinTie === null ? at / 2 : 0);
  }
  return p;
}

function tieRelation(order, me, other) {
  if (!order) return null;
  return order.indexOf(me) < order.indexOf(other);
}

const neededToBeat = (rivals) => Math.max(0, ...rivals.map((r) => r.likely + (r.youWinTie === true ? 0 : 1)));
const topRival = (rivals) => rivals.reduce((best, r) => (!best || r.likely + !r.youWinTie > best.likely + !best.youWinTie ? r : best), null);
const tieNote = (r) => (r.youWinTie === true ? "you win ties" : r.youWinTie === false ? `${r.name} wins ties` : "ties are random");
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/**
 * Use the bots' own bids instead of the model above. `sim` comes from
 * BrowserSession.rival_bids: each sample is every rival's real bid on one
 * random deal of the cards you can't see. Sets each rival's likely bid
 * (median) and 10–90% range, and returns the win chance for a bid straight
 * from the joint samples, or null when `sim` is missing or stale.
 */
function sampledWinChance(sim, rivals, round) {
  if (!sim || sim.round !== round || !sim.samples?.length) return null;
  const col = new Map(sim.seats.map((seat, k) => [seat, k]));
  if (!rivals.every((r) => col.has(r.idx))) return null;
  for (const r of rivals) {
    const xs = sim.samples.map((s) => s[col.get(r.idx)]).sort((a, b) => a - b);
    r.likely = quantile(xs, 0.5);
    r.low = quantile(xs, 0.1);
    r.high = quantile(xs, 0.9);
  }
  return (bid) => {
    let wins = 0;
    for (const s of sim.samples) {
      let tied = 0, lost = false;
      for (const r of rivals) {
        const x = s[col.get(r.idx)];
        if (x > bid || (x === bid && r.youWinTie === false)) { lost = true; break; }
        if (x === bid && r.youWinTie === null) tied++;
      }
      if (!lost) wins += 1 / (tied + 1);
    }
    return wins / sim.samples.length;
  };
}

// --------------------------------------------------------------------------
// Live advice
// --------------------------------------------------------------------------

/**
 * Advice for the human's current bid, or null outside a human bid.
 * Reads only public state and the viewer's own hand. `sim` is optional:
 * the bots' sampled bids (see sampledWinChance); without it, rivals are
 * modelled.
 */
export function advise(view, sim = null) {
  if (!view || view.human_idx === null || view.human_idx === undefined || !view.auction) return null;
  if (view.phase && view.phase !== "bid") return null;
  const st = view.state, a = view.auction, me = view.human_idx;
  const you = st.players[me];
  const cap = view.max_bid ?? (a.kind === "loan" ? you.coins + a.amount : you.coins);
  const mine = beliefs(st, me), pub = beliefs(st, null);
  const ties = tieOrder(st);
  const colorRows = COLORS.map((c) => ({ color: c, ...mine[c], publicEv: pub[c].ev, edge: mine[c].ev - pub[c].ev }));
  const reserve = cashReserve(st, mine);
  const cash = cashValue(st, pub, a.kind === "treasure" ? Math.min(a.gems, st.revealed_gems.length) : 0);
  const base = {
    kind: a.kind, auction: a, colorRows, ties, firstAuction: ties === null, coins: you.coins, maxBid: cap,
    reserve, spare: Math.max(0, you.coins - reserve),
    cashValue: cash.lambda, futureValue: cash.futureValue, cashInPlay: cash.cashInPlay,
  };
  if (a.kind === "treasure") return { ...base, ...adviseTreasure(st, a, me, cap, mine, pub, ties, cash.lambda, sim) };
  if (a.kind === "invest") return { ...base, ...adviseInvest(st, a, me, cap, pub, ties, cash.lambda, base.spare, sim) };
  return { ...base, ...adviseLoan(st, a, me, cap, ties, cash.lambda, reserve, sim) };
}

function adviseTreasure(st, a, me, cap, mine, pub, ties, lambda, sim) {
  const you = st.players[me];
  const offered = st.revealed_gems.slice(0, a.gems);
  const gained = countColors(offered);
  const gemsEv = sum(offered.map((c) => mine[c].ev));
  const publicGemsEv = sum(offered.map((c) => pub[c].ev));
  const missions = missionsCompletedBy(st.active_missions, you.collection, gained);
  const missionValue = sum(missions.map((m) => m.coins));
  const fair = Math.round((gemsEv + missionValue) * 1e9) / 1e9; // keep floor() clear of float noise
  const breakEven = Math.max(0, Math.floor(fair));
  const ceiling = Math.max(0, Math.floor(fair / lambda));

  const after = { ...you.collection };
  for (const [c, k] of Object.entries(gained)) after[c] = (after[c] || 0) + k;
  const setsUp = st.active_missions
    .filter((m) => !missions.includes(m) && missionNeed(m.name, after) === 1 && missionNeed(m.name, you.collection) > 1)
    .map((m) => ({ name: m.name, coins: m.coins }));

  const held = rivalReserve(st, pub);
  const rivals = st.players.flatMap((p, i) => {
    if (i === me) return [];
    const ms = missionsCompletedBy(st.active_missions, p.collection, gained);
    const value = publicGemsEv + sum(ms.map((m) => m.coins));
    const likely = Math.max(0, Math.min(p.coins - held, Math.floor(value * RIVAL_DISCOUNT)));
    return [{
      idx: i, name: p.name, coins: p.coins, value,
      ceiling: Math.max(0, Math.min(p.coins, Math.floor(value))),
      likely, youWinTie: tieRelation(ties, me, i),
      missions: ms.map((m) => ({ name: m.name, coins: m.coins })),
      pmf: bidPmf(likely, p.coins),
    }];
  });
  const denial = rivals.flatMap((r) => r.missions.map((m) => ({ rival: r.name, ...m })));
  const sampled = sampledWinChance(sim, rivals, st.round_number + 1);
  const chance = sampled ?? ((b) => winProb(b, rivals));
  const needed = neededToBeat(rivals);
  const top = topRival(rivals);

  // Maximise expected surplus with every coin paid charged at `lambda`.
  let best = { bid: 0, e: -Infinity, p: 0 };
  for (let b = 0; b <= Math.min(cap, breakEven); b++) {
    const p = chance(b);
    const e = (fair - lambda * b) * p;
    if (e > best.e + 1e-9) best = { bid: b, e, p };
  }

  let suggested = best.bid, verdict, reason;
  const net = fair - lambda * best.bid;
  const short = cap < ceiling; // your cash, not the lot's value, is the limit
  const vsTop = `${top.name}'s ${sampled ? "" : "est. "}~${top.likely} (${tieNote(top)})`;
  if (!offered.length) {
    suggested = 0; verdict = "pass";
    reason = "No gems are left on the row, so this lot is worth nothing. Bid 0.";
  } else if (fair < 1 || best.bid === 0 || best.e < 0.25 || best.p < MIN_WIN_CHANCE) {
    suggested = 0; verdict = "pass";
    reason = fair < 1
      ? `Worth only ~${fmt(fair)} to you. Bid 0.`
      : short && cap < needed
        ? `Worth ~${fmt(fair)} to you, but you can only bid ${cap}, well under ${vsTop}. Bid 0 and keep your coins for a lot you can win.`
        : `Rivals likely bid more than the ~${ceiling} it's worth paying: ${vsTop}. Bid 0 and keep your coins.`;
  } else if (best.p >= 0.5) {
    verdict = net >= Math.max(2, 0.2 * fair) ? "buy" : "thin";
    reason = `${short && suggested === cap ? `All in at ${suggested}` : `Bid ${suggested}`}: about ${pct(best.p)} to beat ${vsTop}. `
      + (verdict === "buy"
        ? `Worth ~${fmt(fair)} to you, so a win nets ~${fmt(fair - suggested)}.`
        : `Thin: worth ~${fmt(fair)} to you, and the coins are worth more than face value right now.`);
  } else {
    verdict = "shot";
    reason = short && suggested === cap
      ? `You can only bid ${cap}, so it's a long shot: ${pct(best.p)} to beat ${vsTop}. Nets ~${fmt(fair - suggested)} if it lands.`
      : `Bid ${suggested} as a cheap shot: ${pct(best.p)} to win against ${vsTop}. Nets ~${fmt(fair - suggested)} if it lands; bidding more costs more than the extra win chance is worth.`;
  }

  const p = suggested === best.bid ? best.p : chance(suggested);
  return {
    offered, gemsEv, missions: missions.map((m) => ({ name: m.name, coins: m.coins })), missionValue,
    publicGemsEv, edge: gemsEv - publicGemsEv, fair, breakEven, ceiling,
    rivals: rivals.map(({ pmf, ...r }) => r), rivalSource: sampled ? "bots" : "model", needed, setsUp, denial,
    suggested, verdict, reason, winProb: p, expSurplus: (fair - suggested) * p,
  };
}

function adviseInvest(st, a, me, cap, pub, ties, lambda, spare, sim) {
  // Without the bots' sampled bids, rivals are modelled like HeuristicAI:
  // bid surplus cash, with a token 1.
  const held = rivalReserve(st, pub);
  const rivals = st.players.flatMap((p, i) => {
    if (i === me) return [];
    const likely = p.coins > 0 ? Math.min(p.coins, Math.max(1, p.coins - held)) : 0;
    return [{ idx: i, name: p.name, coins: p.coins, likely, youWinTie: tieRelation(ties, me, i), pmf: bidPmf(likely, p.coins) }];
  });
  const sampled = sampledWinChance(sim, rivals, st.round_number + 1);
  const chance = sampled ?? ((b) => winProb(b, rivals));
  const needed = neededToBeat(rivals);
  const top = topRival(rivals);

  // The bid comes back, so a win is +amount at any price. The cost is the
  // buying power of the locked coins until the end: (lambda − 1) each, and
  // double for coins dug out of your reserve, since the last coins you
  // hold are the ones that buy your next lot.
  let best = { bid: 0, score: -Infinity, p: 0 };
  for (let b = 0; b <= cap; b++) {
    const p = chance(b);
    const score = p * (a.amount - (lambda - 1) * (b + Math.max(0, b - spare))) - 0.01 * b;
    if (score > best.score + 1e-9) best = { bid: b, score, p };
  }
  if (best.p < MIN_WIN_CHANCE) best = { bid: 0, p: chance(0) };
  const suggested = best.bid;
  const verdict = suggested === 0 ? "pass" : best.p >= 0.5 ? "buy" : "shot";
  const lead = `Invest pays back your bid plus ${a.amount}, so a win is +${a.amount} at any price; the cost is cash locked until the end.`;
  const reason = cap === 0
    ? `${lead} You have no coins to lock, so bid 0.`
    : suggested === 0
      ? `${lead} Beating ${top.name}'s ${sampled ? "" : "est. "}~${top.likely} would lock more buying power than the +${a.amount} is worth. Bid 0.`
      : `${lead} Bid ${suggested}: about ${pct(best.p)} to beat ${top.name}'s ${sampled ? "" : "est. "}~${top.likely} (${tieNote(top)}).`;
  return {
    fair: a.amount, breakEven: cap, needed,
    rivals: rivals.map(({ pmf, ...r }) => r), rivalSource: sampled ? "bots" : "model",
    suggested, verdict, reason, winProb: best.p, expSurplus: a.amount * best.p,
  };
}

function adviseLoan(st, a, me, cap, ties, lambda, reserve, sim) {
  const coins = cap - a.amount;
  const shortfall = Math.max(0, reserve - coins);
  const gemsLeft = st.gem_deck_count + st.revealed_gems.length;
  // Borrowed coins are only worth something when you're short of cash:
  // each one then buys about (lambda − 1) of surplus on later lots.
  const liquidity = shortfall && gemsLeft >= 2 ? LOAN_LIQUIDITY_SHARE * (lambda - 1) * Math.min(shortfall, a.amount) : 0;
  const rivals = st.players.flatMap((p, i) => (i === me ? [] : [{ idx: i, name: p.name, coins: p.coins, likely: 0, youWinTie: tieRelation(ties, me, i) }]));
  const chance = sampledWinChance(sim, rivals, st.round_number + 1);
  // With the bots' real bids, best-respond: the cheapest bid that wins the
  // cash for less than it's worth. Without them, a small capped bid.
  let suggested = Math.min(cap, LOAN_BID_MAX, Math.floor(liquidity)), p = null;
  if (chance) {
    let best = { bid: 0, e: -Infinity, p: 0 };
    for (let b = 0; b <= Math.min(cap, Math.floor(liquidity)); b++) {
      const q = chance(b), e = (liquidity - b) * q;
      if (e > best.e + 1e-9) best = { bid: b, e, p: q };
    }
    suggested = best.p < MIN_WIN_CHANCE ? 0 : best.bid;
    p = chance(suggested);
  }
  const top = topRival(rivals);
  const lead = `A loan's bid is a pure cost: you get ${a.amount} now and repay ${a.amount} at the end.`;
  const reason = suggested === 0
    ? `${lead} ${shortfall === 0 ? "You have enough cash for the lots ahead" : gemsLeft < 2 ? "Too few gems are left to spend it on" : "The extra cash isn't worth what rivals will bid for it"}, so bid 0. If nobody bids, a 0 can still win it for free.`
    : `${lead} You're ~${shortfall} short of the ~${reserve} the remaining lots call for, so ${a.amount} extra coins are worth ~${fmt(liquidity)} to you. `
      + (chance ? `Bid ${suggested}: about ${pct(p)} to beat ${top.name}'s ~${top.likely} (${tieNote(top)}).` : `A small bid of ${suggested} buys it. Whatever you bid is lost.`);
  return {
    fair: 0, breakEven: 0, liquidity, suggested, verdict: suggested === 0 ? "pass" : "thin",
    rivals: chance ? rivals : [], rivalSource: chance ? "bots" : "model", winProb: p, expSurplus: -suggested, reason,
  };
}

// --------------------------------------------------------------------------
// Post-game analysis
// --------------------------------------------------------------------------

/**
 * Where every seat won or lost surplus. Uses the identity
 *   final score = starting coins + Σ (gross − price) over lots won,
 * where gross is treasure: final gem values + missions completed that
 * round; loan: 0; invest: bid + amount.
 *
 * `snapshots` maps round → `view.state` at bid time. Without them the
 * ledger still works, only the per-seat fair values are missing. Each
 * round also carries `hands`: every seat's real hand as that round began.
 */
export function analyze(endView, log, snapshots = {}) {
  const st = endView.state;
  const n = st.players.length;
  const start = STARTING_COINS[n];
  const chart = st.chart_values;
  const finalDisplay = { ...st.value_display };
  const finalValue = (c) => chartAt(chart, finalDisplay[c] || 0);
  const human = endView.human_idx ?? null;
  const names = st.players.map((p) => p.name);

  // Hands at the start of each round: final hand + every gem revealed from then on.
  const handAt = {};
  let hands = (endView.final_hands || st.players.map((p) => p.hand || [])).map((h) => [...h]);
  for (let k = log.length - 1; k >= 0; k--) {
    const r = log[k];
    if (r.revealed_gem) hands = hands.map((h, i) => (i === r.winner_idx ? [...h, r.revealed_gem] : h));
    handAt[r.round] = hands;
  }

  // Public ledger replayed forward. Missions are never replenished, so the
  // opening four = still open at the end + every one completed.
  let active = [...st.active_missions, ...log.flatMap((r) => r.completed_missions.map((m) => m.mission))];
  const coins = Array(n).fill(start);
  const cols = Array.from({ length: n }, () => ({}));
  let lastWinner = null;

  const players = names.map((name) => ({
    name, lotsWon: 0, surplus: 0, treasureSurplus: 0, loanSurplus: 0, investSurplus: 0, paid: 0, gotGross: 0, overpays: 0,
  }));
  const rounds = [];

  for (const r of log) {
    const a = r.auction, w = r.winner_idx, price = r.winning_bid;
    const snap = (snapshots && snapshots[r.round]) || null;
    const order = lastWinner === null ? null : Array.from({ length: n }, (_, k) => (lastWinner + 1 + k) % n);
    const missionCoins = Array(n).fill(0);
    for (const m of r.completed_missions) missionCoins[m.player_idx] += m.mission.coins;

    const gemsGross = sum(r.taken_gems.map(finalValue));
    const gross = a.kind === "treasure" ? gemsGross + missionCoins[w] : a.kind === "loan" ? 0 : price + a.amount;
    const surplus = gross - price;
    const fair = names.map((_, i) => seatFair(snap, i, a, handAt[r.round]?.[i]));

    const pw = players[w];
    pw.lotsWon++; pw.paid += price; pw.gotGross += gross; pw.surplus += surplus;
    pw[a.kind === "treasure" ? "treasureSurplus" : a.kind === "loan" ? "loanSurplus" : "investSurplus"] += surplus;
    if (a.kind === "treasure" && surplus < 0) pw.overpays++;
    missionCoins.forEach((m, i) => { // only the winner can complete one; kept exact regardless
      if (i !== w && m) { players[i].surplus += m; players[i].treasureSurplus += m; }
    });

    const row = {
      round: r.round, auction: a, lot: lotText(a), taken: r.taken_gems, winner: w, winnerName: names[w],
      price, bids: r.bids, gross, surplus, fair, myBid: null, myFair: null, hands: handAt[r.round],
    };

    if (human !== null) {
      row.myBid = r.bids[human];
      row.myFair = fair[human];
      const toWin = Math.max(0, ...r.bids.map((b, j) => (j === human ? -Infinity : b + (order && order.indexOf(human) < order.indexOf(j) ? 0 : 1))));
      if (a.kind === "treasure") {
        row.myGross = w === human
          ? gross
          : gemsGross + sum(missionsCompletedBy(active, cols[human], r.taken_gems).map((m) => m.coins));
      }
      judge(row, { human, toWin, coinsBefore: coins[human], snap, a });
    }
    rounds.push(row);

    // Advance the ledger.
    if (a.kind === "treasure") { coins[w] -= price; for (const c of r.taken_gems) cols[w][c] = (cols[w][c] || 0) + 1; }
    else if (a.kind === "loan") coins[w] += a.amount - price;
    else coins[w] -= price;
    const done = new Set(r.completed_missions.map((m) => m.mission.name));
    active = active.filter((m) => !done.has(m.name));
    lastWinner = w;
  }

  const scores = endView.scores || [];
  for (const [i, p] of players.entries()) {
    p.predictedScore = start + p.surplus;
    p.score = scores[i]?.total ?? null;
  }

  return { start, rounds, players, summary: human === null ? null : summarize(rounds, players, human, start), finalDisplay };
}

function seatFair(snap, i, a, hand) {
  if (a.kind === "loan") return 0;
  if (a.kind === "invest") return a.amount;
  if (!snap) return null;
  const own = hand ?? snap.players[i].hand;
  const players = snap.players.map((p, j) => (j === i && own ? { ...p, hand: own } : p));
  const b = beliefs({ ...snap, players }, i);
  const offered = snap.revealed_gems.slice(0, a.gems);
  const missions = missionsCompletedBy(snap.active_missions, snap.players[i].collection, offered);
  return sum(offered.map((c) => b[c].ev)) + sum(missions.map((m) => m.coins));
}

function judge(row, { human, toWin, coinsBefore, snap, a }) {
  const tag = `R${row.round} ${row.lot}`;
  const est = row.myFair === null ? "" : `; your estimate was ${fmt(row.myFair)}`;
  if (row.winner === human) {
    if (a.kind === "loan") {
      row.verdict = row.price > 0 ? "loan-cost" : "good";
      row.loss = row.price;
      row.note = row.price > 0
        ? `${tag}: paid ${row.price} for a loan, a straight −${row.price}. Worth it only if the cash won you a lot you'd otherwise have missed.`
        : `${tag}: took the loan for free.`;
    } else if (a.kind === "invest") {
      row.verdict = "good";
      row.note = `${tag}: +${a.amount} for locking ${row.price}.`;
    } else {
      const left = row.price - toWin;
      if (row.surplus < 0) {
        row.verdict = row.myFair === null || row.price > row.myFair ? "overpaid" : "unlucky";
        row.loss = -row.surplus;
        row.note = row.verdict === "overpaid"
          ? `${tag}: paid ${row.price} for a lot worth ${row.gross}${est}, so the bid was above it.`
          : `${tag}: paid ${row.price}, within your estimate of ${fmt(row.myFair)}, but it ended up worth ${row.gross}.`;
      } else if (left > 2) {
        row.verdict = "overbid";
        row.loss = left;
        row.note = `${tag}: won at ${row.price} but ${toWin} would have done, leaving ${left} on the table.`;
      } else {
        row.verdict = "good";
        row.note = `${tag}: paid ${row.price} for ${row.gross} (+${row.surplus}).`;
      }
    }
    return;
  }
  if (toWin > coinsBefore) return;
  if (a.kind === "treasure") {
    const gain = row.myGross - toWin;
    if (gain >= 3) {
      row.verdict = "missed";
      row.gain = gain;
      row.note = `${tag}: ${row.winnerName} took it for ${row.price}. It was worth ${row.myGross} to you, so bidding ${toWin} would have netted +${gain}.`;
    }
  } else if (a.kind === "invest") {
    const reserve = snap ? cashReserve(snap, beliefs(snap, human)) : 0;
    if (toWin <= coinsBefore - reserve) {
      row.verdict = "missed-invest";
      row.gain = a.amount;
      row.note = `${tag}: ${row.winnerName} won it for ${row.price}. Bidding ${toWin} was a free +${a.amount} you could afford.`;
    }
  }
}

function summarize(rounds, players, human, start) {
  const you = players[human];
  const top = (xs, key) => xs.sort((x, y) => y[key] - x[key]).slice(0, 3);
  const leaks = top(rounds.filter((r) => r.loss > 0), "loss");
  const missed = top(rounds.filter((r) => r.gain > 0), "gain");
  const best = top(rounds.filter((r) => r.winner === human && r.surplus > 0), "surplus");
  const errs = rounds.filter((r) => r.auction.kind === "treasure" && r.myFair !== null && r.myGross !== undefined).map((r) => r.myFair - r.myGross);
  const leader = players.reduce((b, p, i) => (!b || p.surplus > b.surplus ? { name: p.name, surplus: p.surplus, idx: i } : b), null);
  return {
    start, you, leaks, missed, best,
    estimateMae: errs.length ? sum(errs.map(Math.abs)) / errs.length : null,
    estimateBias: errs.length ? sum(errs) / errs.length : null,
    estimateCount: errs.length,
    surplusRank: 1 + players.filter((p) => p.surplus > you.surplus).length,
    leader,
  };
}
