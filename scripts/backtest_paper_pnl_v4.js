#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    input: "data/nba_event_training_features_v4.csv",
    out: "data/reports/v4_paper_backtest_2024_2025.json",
    predictionsOut: "data/reports/v4_paper_backtest_2024_2025_predictions.csv",
    trainStart: "2021-10-01",
    trainEnd: "2024-06-30",
    testStart: "2024-10-01",
    testEnd: "2025-06-30",
    iters: 12000,
    lr: 0.0025,
    l2: 0.01,
    features: ["implied_logit"],
    selectionMode: "edge",
    edgeMin: 0.015,
    maxBetsPerEvent: 1,
    bankroll: 10000,
    flatStake: 100,
    kellyFraction: 0.25,
    kellyCap: 0.03
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--input") args.input = argv[i + 1] || args.input;
    if (token === "--out") args.out = argv[i + 1] || args.out;
    if (token === "--predictions-out") args.predictionsOut = argv[i + 1] || args.predictionsOut;
    if (token === "--train-start") args.trainStart = argv[i + 1] || args.trainStart;
    if (token === "--train-end") args.trainEnd = argv[i + 1] || args.trainEnd;
    if (token === "--test-start") args.testStart = argv[i + 1] || args.testStart;
    if (token === "--test-end") args.testEnd = argv[i + 1] || args.testEnd;
    if (token === "--iters") args.iters = Number(argv[i + 1]) || args.iters;
    if (token === "--lr") args.lr = Number(argv[i + 1]) || args.lr;
    if (token === "--l2") args.l2 = Number(argv[i + 1]) || args.l2;
    if (token === "--features") {
      args.features = String(argv[i + 1] || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (token === "--selection-mode") args.selectionMode = String(argv[i + 1] || args.selectionMode).toLowerCase();
    if (token === "--edge-min") args.edgeMin = Number(argv[i + 1]);
    if (token === "--max-bets-per-event") args.maxBetsPerEvent = Number(argv[i + 1]) || args.maxBetsPerEvent;
    if (token === "--bankroll") args.bankroll = Number(argv[i + 1]) || args.bankroll;
    if (token === "--flat-stake") args.flatStake = Number(argv[i + 1]) || args.flatStake;
    if (token === "--kelly-fraction") args.kellyFraction = Number(argv[i + 1]) || args.kellyFraction;
    if (token === "--kelly-cap") args.kellyCap = Number(argv[i + 1]) || args.kellyCap;
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

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (!/[",\n]/.test(str)) return str;
  return `"${str.replaceAll('"', '""')}"`;
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

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function fmt(v) {
  if (!Number.isFinite(v)) return "n/a";
  return v.toFixed(6);
}

function prepareRows(rawRows, featureNames) {
  return rawRows
    .map((r) => {
      const startsAtTs = new Date(r.starts_at || 0).getTime();
      const implied = toNum(r.implied_prob);
      const y = toNum(r.team_win);
      const features = {};
      for (const f of featureNames) {
        if (f === "implied_logit") features[f] = logit(implied);
        else features[f] = toNum(r[f]);
      }
      return {
        ...r,
        event_id: String(r.event_id || ""),
        team_id: String(r.team_id || ""),
        team_name: String(r.team_name || ""),
        startsAtTs,
        implied_prob: implied,
        y,
        features
      };
    })
    .filter((r) => Number.isFinite(r.startsAtTs) && Number.isFinite(r.implied_prob) && (r.y === 0 || r.y === 1));
}

function inDateRange(ts, startIso, endIso) {
  const start = new Date(`${startIso}T00:00:00Z`).getTime();
  const end = new Date(`${endIso}T23:59:59Z`).getTime();
  return ts >= start && ts <= end;
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
    for (let j = 0; j < nFeat; j += 1) {
      w[j] -= args.lr * (gradW[j] / n + args.l2 * w[j]);
    }
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

function selectBets(testRows, selectionMode, edgeMin, maxBetsPerEvent) {
  const byEvent = new Map();
  for (const row of testRows) {
    const pModel = row.p_model;
    const pMarket = row.implied_prob;
    const edge = pModel - pMarket;
    const decimalOdds = clipProb(pMarket) ? 1 / clipProb(pMarket) : null;
    const candidate = {
      ...row,
      p_market: pMarket,
      edge,
      decimal_odds: decimalOdds,
      bet_flag: Number.isFinite(decimalOdds) ? 1 : 0
    };
    if (!byEvent.has(candidate.event_id)) byEvent.set(candidate.event_id, []);
    byEvent.get(candidate.event_id).push(candidate);
  }

  const selected = [];
  for (const rows of byEvent.values()) {
    rows.sort((a, b) => b.edge - a.edge);
    if (selectionMode === "top_pick") {
      selected.push(...rows.slice(0, Math.max(1, maxBetsPerEvent)));
    } else {
      const picks = rows.filter((r) => r.edge >= edgeMin && r.bet_flag === 1).slice(0, Math.max(0, maxBetsPerEvent));
      selected.push(...picks);
    }
  }

  selected.sort((a, b) => a.startsAtTs - b.startsAtTs || a.event_id.localeCompare(b.event_id));
  return selected;
}

function simulateFlat(bets, bankrollStart, flatStake) {
  let bankroll = bankrollStart;
  let wins = 0;
  let losses = 0;
  let staked = 0;
  const ledger = [];

  for (const bet of bets) {
    const stake = Math.min(flatStake, bankroll);
    if (stake <= 0) break;
    staked += stake;

    const won = bet.y === 1;
    const profit = won ? stake * (bet.decimal_odds - 1) : -stake;
    bankroll += profit;
    if (won) wins += 1;
    else losses += 1;

    ledger.push({
      ...bet,
      stake,
      won: won ? 1 : 0,
      profit,
      bankroll_after: bankroll
    });
  }

  return {
    strategy: "flat",
    bankroll_start: bankrollStart,
    bankroll_end: bankroll,
    accrued_income: bankroll - bankrollStart,
    total_staked: staked,
    roi_on_staked: staked > 0 ? (bankroll - bankrollStart) / staked : 0,
    n_bets: ledger.length,
    wins,
    losses,
    win_rate: ledger.length ? wins / ledger.length : 0,
    avg_edge: ledger.length ? mean(ledger.map((r) => r.edge)) : 0,
    ledger
  };
}

function simulateKelly(bets, bankrollStart, kellyFraction, kellyCap) {
  let bankroll = bankrollStart;
  let wins = 0;
  let losses = 0;
  let staked = 0;
  const ledger = [];

  for (const bet of bets) {
    const b = bet.decimal_odds - 1;
    if (!Number.isFinite(b) || b <= 0) continue;
    const p = bet.p_model;
    const q = 1 - p;
    const rawKelly = (b * p - q) / b;
    const frac = Math.max(0, Math.min(kellyCap, rawKelly * kellyFraction));
    if (frac <= 0) continue;

    const stake = Math.min(bankroll, bankroll * frac);
    if (stake <= 0) break;

    staked += stake;
    const won = bet.y === 1;
    const profit = won ? stake * (bet.decimal_odds - 1) : -stake;
    bankroll += profit;
    if (won) wins += 1;
    else losses += 1;

    ledger.push({
      ...bet,
      stake,
      won: won ? 1 : 0,
      profit,
      bankroll_after: bankroll
    });
  }

  return {
    strategy: "fractional_kelly",
    bankroll_start: bankrollStart,
    bankroll_end: bankroll,
    accrued_income: bankroll - bankrollStart,
    total_staked: staked,
    roi_on_staked: staked > 0 ? (bankroll - bankrollStart) / staked : 0,
    n_bets: ledger.length,
    wins,
    losses,
    win_rate: ledger.length ? wins / ledger.length : 0,
    avg_edge: ledger.length ? mean(ledger.map((r) => r.edge)) : 0,
    kelly_fraction: kellyFraction,
    kelly_cap: kellyCap,
    ledger
  };
}

function extractPredictionRows(testRows, selectedBetsMap, flatLedgerMap, kellyLedgerMap) {
  const out = [];
  const sorted = [...testRows].sort((a, b) => a.startsAtTs - b.startsAtTs || a.event_id.localeCompare(b.event_id));
  for (const row of sorted) {
    const key = `${row.event_id}:${row.team_id}`;
    const chosen = selectedBetsMap.get(key);
    const flat = flatLedgerMap.get(key);
    const kelly = kellyLedgerMap.get(key);
    out.push({
      event_id: row.event_id,
      starts_at: row.starts_at,
      team_id: row.team_id,
      team_name: row.team_name,
      p_model: row.p_model,
      p_market: row.implied_prob,
      edge: row.p_model - row.implied_prob,
      team_win: row.y,
      selected_bet: chosen ? 1 : 0,
      flat_stake: flat ? flat.stake : 0,
      flat_profit: flat ? flat.profit : 0,
      flat_bankroll_after: flat ? flat.bankroll_after : null,
      kelly_stake: kelly ? kelly.stake : 0,
      kelly_profit: kelly ? kelly.profit : 0,
      kelly_bankroll_after: kelly ? kelly.bankroll_after : null
    });
  }
  return out;
}

function writePredictionsCsv(rows, outPath) {
  const header = [
    "event_id",
    "starts_at",
    "team_id",
    "team_name",
    "p_model",
    "p_market",
    "edge",
    "team_win",
    "selected_bet",
    "flat_stake",
    "flat_profit",
    "flat_bankroll_after",
    "kelly_stake",
    "kelly_profit",
    "kelly_bankroll_after"
  ];

  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((h) => csvEscape(row[h])).join(","));
  }
  ensureDirForFile(outPath);
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.input)) throw new Error(`Input not found: ${args.input}`);

  const raw = parseCsv(fs.readFileSync(args.input, "utf8"));
  if (!raw.length) throw new Error("Input CSV has no rows.");

  const rows = prepareRows(raw, args.features);
  const trainRows = rows.filter((r) => inDateRange(r.startsAtTs, args.trainStart, args.trainEnd));
  const testRows = rows.filter((r) => inDateRange(r.startsAtTs, args.testStart, args.testEnd));

  if (!trainRows.length) throw new Error("No train rows found in selected date range.");
  if (!testRows.length) throw new Error("No test rows found in selected date range.");

  const model = trainLogit(trainRows, args.features, args);
  for (const row of testRows) row.p_model = predictProb(row, model, args.features);

  if (!["edge", "top_pick"].includes(args.selectionMode)) {
    throw new Error(`Invalid --selection-mode: ${args.selectionMode}. Use edge or top_pick.`);
  }
  const selectedBets = selectBets(testRows, args.selectionMode, args.edgeMin, args.maxBetsPerEvent);
  const flat = simulateFlat(selectedBets, args.bankroll, args.flatStake);
  const kelly = simulateKelly(selectedBets, args.bankroll, args.kellyFraction, args.kellyCap);

  const selectedBetsMap = new Map(selectedBets.map((b) => [`${b.event_id}:${b.team_id}`, b]));
  const flatLedgerMap = new Map(flat.ledger.map((b) => [`${b.event_id}:${b.team_id}`, b]));
  const kellyLedgerMap = new Map(kelly.ledger.map((b) => [`${b.event_id}:${b.team_id}`, b]));
  const predictionRows = extractPredictionRows(testRows, selectedBetsMap, flatLedgerMap, kellyLedgerMap);
  writePredictionsCsv(predictionRows, args.predictionsOut);

  const stakeExamples = [50, 100, 250, 500].map((stake) => {
    const sim = simulateFlat(selectedBets, args.bankroll, stake);
    return {
      flat_stake: stake,
      bankroll_start: sim.bankroll_start,
      bankroll_end: sim.bankroll_end,
      accrued_income: sim.accrued_income,
      total_staked: sim.total_staked,
      roi_on_staked: sim.roi_on_staked,
      n_bets: sim.n_bets
    };
  });

  const out = {
    created_at: new Date().toISOString(),
    config: {
      input: args.input,
      train_start: args.trainStart,
      train_end: args.trainEnd,
      test_start: args.testStart,
      test_end: args.testEnd,
      model: {
        features: args.features,
        iters: args.iters,
        lr: args.lr,
        l2: args.l2
      },
      betting: {
        edge_min: args.edgeMin,
        selection_mode: args.selectionMode,
        max_bets_per_event: args.maxBetsPerEvent,
        bankroll_start: args.bankroll,
        flat_stake_default: args.flatStake,
        kelly_fraction: args.kellyFraction,
        kelly_cap: args.kellyCap
      }
    },
    dataset: {
      train_rows: trainRows.length,
      test_rows: testRows.length,
      test_events: new Set(testRows.map((r) => r.event_id)).size,
      selected_bets: selectedBets.length
    },
    pnl: {
      flat_default: {
        strategy: flat.strategy,
        bankroll_start: flat.bankroll_start,
        bankroll_end: flat.bankroll_end,
        accrued_income: flat.accrued_income,
        total_staked: flat.total_staked,
        roi_on_staked: flat.roi_on_staked,
        n_bets: flat.n_bets,
        wins: flat.wins,
        losses: flat.losses,
        win_rate: flat.win_rate,
        avg_edge: flat.avg_edge
      },
      fractional_kelly: {
        strategy: kelly.strategy,
        bankroll_start: kelly.bankroll_start,
        bankroll_end: kelly.bankroll_end,
        accrued_income: kelly.accrued_income,
        total_staked: kelly.total_staked,
        roi_on_staked: kelly.roi_on_staked,
        n_bets: kelly.n_bets,
        wins: kelly.wins,
        losses: kelly.losses,
        win_rate: kelly.win_rate,
        avg_edge: kelly.avg_edge,
        kelly_fraction: kelly.kelly_fraction,
        kelly_cap: kelly.kelly_cap
      },
      flat_stake_examples: stakeExamples
    },
    artifacts: {
      predictions_csv: args.predictionsOut,
      report_json: args.out
    }
  };

  ensureDirForFile(args.out);
  fs.writeFileSync(args.out, JSON.stringify(out, null, 2), "utf8");

  console.log("V4 Paper PnL Backtest Complete");
  console.log("------------------------------");
  console.log(`Train: ${args.trainStart} -> ${args.trainEnd} rows=${trainRows.length}`);
  console.log(`Test:  ${args.testStart} -> ${args.testEnd} rows=${testRows.length}`);
  console.log(`Bets selected: ${selectedBets.length}`);
  console.log(`Flat (${args.flatStake}) accrued_income=${fmt(flat.accrued_income)} roi=${fmt(flat.roi_on_staked)}`);
  console.log(`Kelly accrued_income=${fmt(kelly.accrued_income)} roi=${fmt(kelly.roi_on_staked)}`);
  console.log(`Predictions cache: ${args.predictionsOut}`);
  console.log(`Report: ${args.out}`);
}

main();
