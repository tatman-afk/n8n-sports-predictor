#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    input: "data/nba_event_training_features_v4.csv",
    out: "data/reports/v4_model_vs_coin_monte_carlo_2024_2025.json",
    trainStart: "2021-10-01",
    trainEnd: "2024-06-30",
    testStart: "2024-10-01",
    testEnd: "2025-06-30",
    iters: 12000,
    lr: 0.0025,
    l2: 0.01,
    features: ["implied_logit"],
    bankroll: 10000,
    flatStake: 100,
    modelEdgeMin: -0.02,
    coinBetProb: 1,
    coinFollowsModel: true,
    seeds: 200,
    startSeed: 1
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--input") args.input = argv[i + 1] || args.input;
    if (token === "--out") args.out = argv[i + 1] || args.out;
    if (token === "--train-start") args.trainStart = argv[i + 1] || args.trainStart;
    if (token === "--train-end") args.trainEnd = argv[i + 1] || args.trainEnd;
    if (token === "--test-start") args.testStart = argv[i + 1] || args.testStart;
    if (token === "--test-end") args.testEnd = argv[i + 1] || args.testEnd;
    if (token === "--iters") args.iters = Number(argv[i + 1]) || args.iters;
    if (token === "--lr") args.lr = Number(argv[i + 1]) || args.lr;
    if (token === "--l2") args.l2 = Number(argv[i + 1]) || args.l2;
    if (token === "--bankroll") args.bankroll = Number(argv[i + 1]) || args.bankroll;
    if (token === "--flat-stake") args.flatStake = Number(argv[i + 1]) || args.flatStake;
    if (token === "--model-edge-min") args.modelEdgeMin = Number(argv[i + 1]);
    if (token === "--coin-bet-prob") args.coinBetProb = Number(argv[i + 1]);
    if (token === "--coin-follows-model") args.coinFollowsModel = true;
    if (token === "--coin-independent") args.coinFollowsModel = false;
    if (token === "--seeds") args.seeds = Number(argv[i + 1]) || args.seeds;
    if (token === "--start-seed") args.startSeed = Number(argv[i + 1]) || args.startSeed;
  }

  return args;
}

function parseCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return rows;

  function splitCsvLine(line) {
    const out = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      const next = line[i + 1];
      if (ch === '"') {
        if (inQuotes && next === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        out.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    out.push(current);
    return out;
  }

  const headers = splitCsvLine(lines[0]);
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const obj = {};
    for (let j = 0; j < headers.length; j += 1) obj[headers[j]] = cells[j] ?? "";
    rows.push(obj);
  }
  return rows;
}

function toNum(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clipProb(p) {
  const eps = 1e-6;
  if (!Number.isFinite(p)) return null;
  if (p < eps) return eps;
  if (p > 1 - eps) return 1 - eps;
  return p;
}

function logit(p) {
  const c = clipProb(p);
  if (c === null) return null;
  return Math.log(c / (1 - c));
}

function sigmoid(z) {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

function mean(vals) {
  if (!vals.length) return 0;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function std(vals) {
  if (vals.length < 2) return 0;
  const m = mean(vals);
  return Math.sqrt(vals.reduce((s, v) => s + (v - m) * (v - m), 0) / (vals.length - 1));
}

function percentile(vals, q) {
  if (!vals.length) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const t = idx - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

function inDateRange(ts, startIso, endIso) {
  const start = new Date(`${startIso}T00:00:00Z`).getTime();
  const end = new Date(`${endIso}T23:59:59Z`).getTime();
  return ts >= start && ts <= end;
}

function groupEvents(rows) {
  const byEvent = new Map();
  for (const row of rows) {
    if (!byEvent.has(row.event_id)) byEvent.set(row.event_id, []);
    byEvent.get(row.event_id).push(row);
  }
  return byEvent;
}

function buildFeatureStats(trainRows, featureNames) {
  const means = {};
  const stds = {};
  for (const f of featureNames) {
    const vals = trainRows.map((r) => r.features[f]).filter((v) => Number.isFinite(v));
    const m = vals.length ? mean(vals) : 0;
    const variance = vals.length
      ? vals.reduce((acc, v) => acc + (v - m) * (v - m), 0) / Math.max(1, vals.length - 1)
      : 0;
    const s = Math.sqrt(variance);
    means[f] = Number.isFinite(m) ? m : 0;
    stds[f] = Number.isFinite(s) && s > 1e-8 ? s : 1;
  }
  return { means, stds };
}

function featureVector(row, featureNames, stats) {
  const out = [];
  for (const f of featureNames) {
    const raw = row.features[f];
    const v = Number.isFinite(raw) ? raw : stats.means[f];
    out.push((v - stats.means[f]) / stats.stds[f]);
  }
  return out;
}

function trainLogit(trainRows, featureNames, args) {
  const stats = buildFeatureStats(trainRows, featureNames);
  const nFeat = featureNames.length;
  const w = new Array(nFeat).fill(0);
  let b = 0;
  for (let iter = 0; iter < args.iters; iter += 1) {
    const gradW = new Array(nFeat).fill(0);
    let gradB = 0;
    for (const row of trainRows) {
      const x = featureVector(row, featureNames, stats);
      let z = b;
      for (let j = 0; j < nFeat; j += 1) z += w[j] * x[j];
      const p = sigmoid(z);
      const err = p - row.y;
      for (let j = 0; j < nFeat; j += 1) gradW[j] += err * x[j];
      gradB += err;
    }
    const n = trainRows.length || 1;
    for (let j = 0; j < nFeat; j += 1) w[j] -= args.lr * (gradW[j] / n + args.l2 * w[j]);
    b -= (args.lr * gradB) / n;
  }
  return { w, b, stats };
}

function predictProb(row, model, featureNames) {
  const x = featureVector(row, featureNames, model.stats);
  let z = model.b;
  for (let j = 0; j < featureNames.length; j += 1) z += model.w[j] * x[j];
  return clipProb(sigmoid(z));
}

function seededRng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function settleFlat(picks, bankrollStart, flatStake) {
  let bankroll = bankrollStart;
  let wins = 0;
  let losses = 0;
  let staked = 0;
  for (const pick of picks) {
    const stake = Math.min(flatStake, bankroll);
    if (stake <= 0) break;
    staked += stake;
    const dec = 1 / clipProb(pick.implied_prob);
    const won = pick.y === 1;
    bankroll += won ? (stake * (dec - 1)) : -stake;
    if (won) wins += 1;
    else losses += 1;
  }
  return {
    bankroll_start: bankrollStart,
    bankroll_end: bankroll,
    accrued_income: bankroll - bankrollStart,
    total_staked: staked,
    roi_on_staked: staked > 0 ? (bankroll - bankrollStart) / staked : 0,
    n_bets: wins + losses,
    wins,
    losses,
    win_rate: wins + losses ? wins / (wins + losses) : 0
  };
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.input)) throw new Error(`Input not found: ${args.input}`);
  if (!(args.coinBetProb >= 0 && args.coinBetProb <= 1)) throw new Error("coinBetProb must be in [0,1].");
  if (!(args.seeds > 0)) throw new Error("seeds must be > 0.");

  const trainEndTs = new Date(`${args.trainEnd}T23:59:59Z`).getTime();
  const testStartTs = new Date(`${args.testStart}T00:00:00Z`).getTime();
  if (!(trainEndTs < testStartTs)) throw new Error("Leakage guard failed: trainEnd must be < testStart.");

  const rawRows = parseCsv(fs.readFileSync(args.input, "utf8"));
  const rows = rawRows
    .map((r) => {
      const implied = toNum(r.implied_prob);
      return {
        ...r,
        event_id: String(r.event_id || ""),
        startsAtTs: new Date(r.starts_at || 0).getTime(),
        implied_prob: implied,
        y: toNum(r.team_win),
        features: { implied_logit: logit(implied) }
      };
    })
    .filter((r) => Number.isFinite(r.startsAtTs) && Number.isFinite(r.implied_prob) && (r.y === 0 || r.y === 1));

  const trainRows = rows.filter((r) => inDateRange(r.startsAtTs, args.trainStart, args.trainEnd));
  const testRows = rows.filter((r) => inDateRange(r.startsAtTs, args.testStart, args.testEnd));
  if (!trainRows.length || !testRows.length) throw new Error("No rows for train/test split.");

  const trainEvents = new Set(trainRows.map((r) => r.event_id));
  const testEvents = new Set(testRows.map((r) => r.event_id));
  let overlap = 0;
  for (const id of trainEvents) if (testEvents.has(id)) overlap += 1;
  if (overlap > 0) throw new Error(`Leakage guard failed: ${overlap} overlapping event_ids.`);

  const model = trainLogit(trainRows, args.features, args);
  for (const row of testRows) row.p_model = predictProb(row, model, args.features);

  const byEvent = groupEvents(testRows);
  const malformedIds = [];
  const events = Array.from(byEvent.values())
    .map((rowsInEvent) => ({
      event_id: rowsInEvent[0]?.event_id,
      startsAtTs: rowsInEvent[0]?.startsAtTs || 0,
      rows: rowsInEvent
    }))
    .filter((e) => e.event_id)
    .filter((e) => {
      const ok = e.rows.length === 2;
      if (!ok) malformedIds.push(e.event_id);
      return ok;
    })
    .sort((a, b) => a.startsAtTs - b.startsAtTs || String(a.event_id).localeCompare(String(b.event_id)));

  const modelPicks = [];
  const modelBetEventIds = new Set();
  for (const e of events) {
    const sorted = [...e.rows].sort((a, b) => b.p_model - a.p_model);
    const pick = sorted[0];
    if ((pick.p_model - pick.implied_prob) >= args.modelEdgeMin) {
      modelPicks.push(pick);
      modelBetEventIds.add(e.event_id);
    }
  }
  const modelPnl = settleFlat(modelPicks, args.bankroll, args.flatStake);

  const seedRuns = [];
  let beatCount = 0;
  let tieCount = 0;
  for (let s = 0; s < args.seeds; s += 1) {
    const seed = args.startSeed + s;
    const rand = seededRng(seed);
    const coinPicks = [];
    for (const e of events) {
      const eligible = args.coinFollowsModel ? modelBetEventIds.has(e.event_id) : true;
      if (!eligible) continue;
      if (rand() > args.coinBetProb) continue;
      const idx = Math.floor(rand() * e.rows.length);
      coinPicks.push(e.rows[Math.max(0, Math.min(e.rows.length - 1, idx))]);
    }
    const coinPnl = settleFlat(coinPicks, args.bankroll, args.flatStake);
    const deltaIncome = modelPnl.accrued_income - coinPnl.accrued_income;
    const deltaRoi = modelPnl.roi_on_staked - coinPnl.roi_on_staked;
    if (deltaIncome > 0) beatCount += 1;
    if (Math.abs(deltaIncome) < 1e-9) tieCount += 1;
    seedRuns.push({
      seed,
      coin_n_bets: coinPnl.n_bets,
      coin_accrued_income: coinPnl.accrued_income,
      coin_roi_on_staked: coinPnl.roi_on_staked,
      delta_model_minus_coin_accrued_income: deltaIncome,
      delta_model_minus_coin_roi: deltaRoi
    });
  }

  const deltas = seedRuns.map((r) => r.delta_model_minus_coin_accrued_income);
  const rois = seedRuns.map((r) => r.delta_model_minus_coin_roi);
  const out = {
    created_at: new Date().toISOString(),
    config: {
      input: args.input,
      train_start: args.trainStart,
      train_end: args.trainEnd,
      test_start: args.testStart,
      test_end: args.testEnd,
      model: { features: args.features, iters: args.iters, lr: args.lr, l2: args.l2, model_edge_min: args.modelEdgeMin },
      coin: { bet_prob: args.coinBetProb, follows_model: args.coinFollowsModel },
      bankroll: args.bankroll,
      flat_stake: args.flatStake,
      monte_carlo: { seeds: args.seeds, start_seed: args.startSeed }
    },
    split_audit: {
      train_rows: trainRows.length,
      test_rows: testRows.length,
      train_events: trainEvents.size,
      test_events_raw: testEvents.size,
      test_events_used: events.length,
      malformed_test_events_skipped: malformedIds.length,
      malformed_test_event_ids: malformedIds,
      overlap_events: overlap
    },
    model_baseline_run: modelPnl,
    monte_carlo_summary: {
      n_runs: seedRuns.length,
      model_beats_coin_rate: beatCount / seedRuns.length,
      model_ties_coin_rate: tieCount / seedRuns.length,
      delta_income_mean: mean(deltas),
      delta_income_std: std(deltas),
      delta_income_p05: percentile(deltas, 0.05),
      delta_income_p50: percentile(deltas, 0.5),
      delta_income_p95: percentile(deltas, 0.95),
      delta_roi_mean: mean(rois),
      delta_roi_p05: percentile(rois, 0.05),
      delta_roi_p50: percentile(rois, 0.5),
      delta_roi_p95: percentile(rois, 0.95)
    },
    seed_runs: seedRuns
  };

  ensureDirForFile(args.out);
  fs.writeFileSync(args.out, JSON.stringify(out, null, 2));

  console.log("V4 Model vs Coin Monte Carlo Complete");
  console.log("-------------------------------------");
  console.log(`Runs: ${seedRuns.length} | Seeds: ${args.startSeed}..${args.startSeed + args.seeds - 1}`);
  console.log(`Model baseline bets=${modelPnl.n_bets} accrued_income=${modelPnl.accrued_income.toFixed(2)} roi=${modelPnl.roi_on_staked.toFixed(6)}`);
  console.log(`Beat rate: ${(100 * out.monte_carlo_summary.model_beats_coin_rate).toFixed(2)}% | tie rate: ${(100 * out.monte_carlo_summary.model_ties_coin_rate).toFixed(2)}%`);
  console.log(`Delta income mean=${out.monte_carlo_summary.delta_income_mean.toFixed(2)} p05=${out.monte_carlo_summary.delta_income_p05.toFixed(2)} p50=${out.monte_carlo_summary.delta_income_p50.toFixed(2)} p95=${out.monte_carlo_summary.delta_income_p95.toFixed(2)}`);
  console.log(`Report: ${args.out}`);
}

main();
