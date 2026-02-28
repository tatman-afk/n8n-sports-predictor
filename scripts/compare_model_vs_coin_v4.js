#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    input: "data/nba_event_training_features_v4.csv",
    out: "data/reports/v4_model_vs_coin_2024_2025.json",
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
    seed: 42,
    modelEdgeMin: 0,
    coinBetProb: 1,
    coinFollowsModel: true,
    liveLog: true,
    logEvery: 1,
    strictEventShape: false
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
    if (token === "--seed") args.seed = Number(argv[i + 1]) || args.seed;
    if (token === "--model-edge-min") args.modelEdgeMin = Number(argv[i + 1]);
    if (token === "--coin-bet-prob") args.coinBetProb = Number(argv[i + 1]);
    if (token === "--live-log") args.liveLog = true;
    if (token === "--no-live-log") args.liveLog = false;
    if (token === "--log-every") args.logEvery = Number(argv[i + 1]) || args.logEvery;
    if (token === "--strict-event-shape") args.strictEventShape = true;
    if (token === "--coin-follows-model") args.coinFollowsModel = true;
    if (token === "--coin-independent") args.coinFollowsModel = false;
  }
  return args;
}

function assertFiniteNumber(v, name) {
  if (!Number.isFinite(v)) throw new Error(`${name} must be a finite number.`);
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

function inDateRange(ts, startIso, endIso) {
  const start = new Date(`${startIso}T00:00:00Z`).getTime();
  const end = new Date(`${endIso}T23:59:59Z`).getTime();
  return ts >= start && ts <= end;
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function buildSplitAudit(rows, trainStart, trainEnd, testStart, testEnd) {
  const trainRows = rows.filter((r) => inDateRange(r.startsAtTs, trainStart, trainEnd));
  const testRows = rows.filter((r) => inDateRange(r.startsAtTs, testStart, testEnd));
  const trainEvents = new Set(trainRows.map((r) => r.event_id));
  const testEvents = new Set(testRows.map((r) => r.event_id));
  let overlapEvents = 0;
  for (const id of trainEvents) if (testEvents.has(id)) overlapEvents += 1;

  const byEvent = groupEvents(testRows);
  let malformedTestEvents = 0;
  for (const rowsInEvent of byEvent.values()) {
    if (rowsInEvent.length !== 2) malformedTestEvents += 1;
  }

  return {
    train_rows: trainRows.length,
    test_rows: testRows.length,
    train_events: trainEvents.size,
    test_events: testEvents.size,
    overlap_events: overlapEvents,
    malformed_test_events: malformedTestEvents,
    train_min_starts_at: trainRows.length ? new Date(Math.min(...trainRows.map((r) => r.startsAtTs))).toISOString() : null,
    train_max_starts_at: trainRows.length ? new Date(Math.max(...trainRows.map((r) => r.startsAtTs))).toISOString() : null,
    test_min_starts_at: testRows.length ? new Date(Math.min(...testRows.map((r) => r.startsAtTs))).toISOString() : null,
    test_max_starts_at: testRows.length ? new Date(Math.max(...testRows.map((r) => r.startsAtTs))).toISOString() : null
  };
}

function prepareRows(rawRows, featureNames) {
  return rawRows
    .map((r) => {
      const implied = toNum(r.implied_prob);
      const features = {};
      for (const f of featureNames) features[f] = f === "implied_logit" ? logit(implied) : toNum(r[f]);
      return {
        ...r,
        event_id: String(r.event_id || ""),
        team_id: String(r.team_id || ""),
        team_name: String(r.team_name || ""),
        startsAtTs: new Date(r.starts_at || 0).getTime(),
        implied_prob: implied,
        y: toNum(r.team_win),
        features
      };
    })
    .filter((r) => Number.isFinite(r.startsAtTs) && Number.isFinite(r.implied_prob) && (r.y === 0 || r.y === 1));
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

function groupEvents(rows) {
  const byEvent = new Map();
  for (const row of rows) {
    if (!byEvent.has(row.event_id)) byEvent.set(row.event_id, []);
    byEvent.get(row.event_id).push(row);
  }
  return byEvent;
}

function pickModel(rowsInEvent) {
  const sorted = [...rowsInEvent].sort((a, b) => b.p_model - a.p_model);
  return sorted[0];
}

function pickCoin(rowsInEvent, rand) {
  const idx = Math.floor(rand() * rowsInEvent.length);
  return rowsInEvent[Math.max(0, Math.min(rowsInEvent.length - 1, idx))];
}

function colorize(s, code, enabled) {
  if (!enabled) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}

function money(v) {
  const sign = v >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function pct(v) {
  return `${(v * 100).toFixed(2)}%`;
}

function eventLabel(rowsInEvent) {
  const home = rowsInEvent.find((r) => String(r.is_home) === "1" || r.is_home === 1);
  const away = rowsInEvent.find((r) => String(r.is_home) === "0" || r.is_home === 0);
  if (away && home) return `${away.team_name} @ ${home.team_name}`;
  const names = Array.from(new Set(rowsInEvent.map((r) => r.team_name))).filter(Boolean);
  return names.join(" vs ");
}

function settleBet(state, pick, stake) {
  if (!pick) {
    return {
      action: "SKIP",
      stake: 0,
      won: null,
      profit: 0,
      bankroll_after: state.bankroll
    };
  }
  const effectiveStake = Math.min(stake, state.bankroll);
  if (effectiveStake <= 0) {
    return {
      action: "SKIP",
      stake: 0,
      won: null,
      profit: 0,
      bankroll_after: state.bankroll
    };
  }
  const decimalOdds = 1 / clipProb(pick.implied_prob);
  const won = pick.y === 1;
  const profit = won ? effectiveStake * (decimalOdds - 1) : -effectiveStake;
  state.bankroll += profit;
  state.total_staked += effectiveStake;
  if (won) state.wins += 1;
  else state.losses += 1;
  state.n_bets += 1;
  return {
    action: "BET",
    stake: effectiveStake,
    won,
    profit,
    bankroll_after: state.bankroll
  };
}

function summarizeState(state, bankrollStart) {
  return {
    bankroll_start: bankrollStart,
    bankroll_end: state.bankroll,
    accrued_income: state.bankroll - bankrollStart,
    total_staked: state.total_staked,
    roi_on_staked: state.total_staked > 0 ? (state.bankroll - bankrollStart) / state.total_staked : 0,
    n_bets: state.n_bets,
    wins: state.wins,
    losses: state.losses,
    win_rate: state.n_bets > 0 ? state.wins / state.n_bets : 0
  };
}

function printLiveEventLog(index, total, event, liveColor) {
  const idx = String(index).padStart(3, "0");
  const date = new Date(event.startsAtTs).toISOString().slice(0, 10);
  const header = `#${idx}/${total} ${date} | ${event.matchup} | event_id=${event.event_id}`;
  console.log(colorize(header, "1;37", liveColor));

  function lineFor(name, leg) {
    if (leg.action === "SKIP") {
      return `  ${name}: SKIP | bankroll=${money(leg.bankroll_after)}`;
    }
    const result = leg.won ? colorize("WIN", "1;32", liveColor) : colorize("LOSS", "1;31", liveColor);
    const profitColor = leg.profit >= 0 ? "32" : "31";
    return [
      `  ${name}: BET ${leg.pick?.team_name || "unknown"}`,
      `edge=${(leg.edge * 100).toFixed(2)}%`,
      `stake=$${leg.stake.toFixed(2)}`,
      `profit=${colorize(money(leg.profit), profitColor, liveColor)}`,
      `result=${result}`,
      `bankroll=${money(leg.bankroll_after)}`
    ].join(" | ");
  }

  console.log(lineFor("MODEL", event.model));
  console.log(lineFor("COIN ", event.coin));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.input)) throw new Error(`Input not found: ${args.input}`);
  assertFiniteNumber(args.modelEdgeMin, "modelEdgeMin");
  assertFiniteNumber(args.coinBetProb, "coinBetProb");
  if (args.coinBetProb < 0 || args.coinBetProb > 1) throw new Error("coinBetProb must be between 0 and 1.");
  if (args.flatStake <= 0) throw new Error("flatStake must be > 0.");
  if (args.bankroll <= 0) throw new Error("bankroll must be > 0.");

  const trainStartTs = new Date(`${args.trainStart}T00:00:00Z`).getTime();
  const trainEndTs = new Date(`${args.trainEnd}T23:59:59Z`).getTime();
  const testStartTs = new Date(`${args.testStart}T00:00:00Z`).getTime();
  const testEndTs = new Date(`${args.testEnd}T23:59:59Z`).getTime();
  if (![trainStartTs, trainEndTs, testStartTs, testEndTs].every((v) => Number.isFinite(v))) {
    throw new Error("Invalid train/test date inputs.");
  }
  if (!(trainStartTs <= trainEndTs && testStartTs <= testEndTs)) {
    throw new Error("Train/test date ranges are invalid.");
  }
  if (!(trainEndTs < testStartTs)) {
    throw new Error("Leakage guard failed: trainEnd must be strictly before testStart.");
  }

  const raw = parseCsv(fs.readFileSync(args.input, "utf8"));
  const rows = prepareRows(raw, args.features);
  const splitAudit = buildSplitAudit(rows, args.trainStart, args.trainEnd, args.testStart, args.testEnd);
  if (splitAudit.overlap_events > 0) {
    throw new Error(`Leakage guard failed: found ${splitAudit.overlap_events} overlapping event_ids across train/test.`);
  }
  if (args.strictEventShape && splitAudit.malformed_test_events > 0) {
    throw new Error(`Data integrity guard failed: found ${splitAudit.malformed_test_events} test events without exactly 2 sides.`);
  }
  const trainRows = rows.filter((r) => inDateRange(r.startsAtTs, args.trainStart, args.trainEnd));
  const testRows = rows.filter((r) => inDateRange(r.startsAtTs, args.testStart, args.testEnd));
  if (!trainRows.length || !testRows.length) throw new Error("No rows for train/test split.");

  const model = trainLogit(trainRows, args.features, args);
  for (const row of testRows) row.p_model = predictProb(row, model, args.features);

  const byEvent = groupEvents(testRows);
  const malformedEventIds = [];
  const events = Array.from(byEvent.values())
    .map((rowsInEvent) => ({
      event_id: rowsInEvent[0]?.event_id,
      startsAtTs: rowsInEvent[0]?.startsAtTs || 0,
      rowsInEvent
    }))
    .filter((e) => e.event_id)
    .filter((e) => {
      const ok = (e.rowsInEvent || []).length === 2;
      if (!ok) malformedEventIds.push(e.event_id);
      return ok;
    })
    .sort((a, b) => a.startsAtTs - b.startsAtTs || String(a.event_id).localeCompare(String(b.event_id)));

  const modelState = { bankroll: args.bankroll, total_staked: 0, n_bets: 0, wins: 0, losses: 0 };
  const coinState = { bankroll: args.bankroll, total_staked: 0, n_bets: 0, wins: 0, losses: 0 };
  const eventLedger = [];
  const rand = seededRng(args.seed);
  const liveColor = process.stdout.isTTY;

  for (let i = 0; i < events.length; i += 1) {
    const entry = events[i];
    const rowsInEvent = entry.rowsInEvent || [];
    if (!rowsInEvent.length) continue;
    const modelPick = pickModel(rowsInEvent);
    const edge = modelPick.p_model - modelPick.implied_prob;
    const modelWillBet = edge >= args.modelEdgeMin;

    const coinEligible = args.coinFollowsModel ? modelWillBet : true;
    const coinWillBet = coinEligible && (rand() <= args.coinBetProb);
    const coinPick = coinWillBet ? pickCoin(rowsInEvent, rand) : null;
    const coinEdge = coinPick ? (coinPick.p_model - coinPick.implied_prob) : null;

    const modelLeg = settleBet(modelState, modelWillBet ? modelPick : null, args.flatStake);
    const coinLeg = settleBet(coinState, coinPick, args.flatStake);

    modelLeg.pick = modelWillBet ? modelPick : null;
    modelLeg.edge = modelWillBet ? edge : 0;
    coinLeg.pick = coinPick;
    coinLeg.edge = coinPick ? coinEdge : 0;

    const eventOut = {
      event_id: entry.event_id,
      startsAtTs: entry.startsAtTs,
      matchup: eventLabel(rowsInEvent),
      model: modelLeg,
      coin: coinLeg
    };
    eventLedger.push(eventOut);

    if (args.liveLog && ((i + 1) % Math.max(1, args.logEvery) === 0 || i === events.length - 1)) {
      printLiveEventLog(i + 1, events.length, eventOut, liveColor);
    }
  }

  const modelPnl = summarizeState(modelState, args.bankroll);
  const coinPnl = summarizeState(coinState, args.bankroll);

  const out = {
    created_at: new Date().toISOString(),
    config: {
      input: args.input,
      train_start: args.trainStart,
      train_end: args.trainEnd,
      test_start: args.testStart,
      test_end: args.testEnd,
      model: { features: args.features, iters: args.iters, lr: args.lr, l2: args.l2 },
      bankroll_start: args.bankroll,
      flat_stake: args.flatStake,
      coin_seed: args.seed,
      model_edge_min: args.modelEdgeMin,
      coin_bet_prob: args.coinBetProb,
      coin_follows_model: args.coinFollowsModel,
      live_log: args.liveLog,
      log_every: args.logEvery,
      strict_event_shape: args.strictEventShape
    },
    dataset: {
      train_rows: trainRows.length,
      test_rows: testRows.length,
      test_events: events.length,
      skipped_malformed_events: malformedEventIds.length,
      skipped_malformed_event_ids: malformedEventIds
    },
    split_audit: splitAudit,
    bettors: {
      model_bettor: {
        strategy: "top_pick_by_model_probability",
        ...modelPnl
      },
      coin_bettor: {
        strategy: "uniform_random_pick_per_event",
        ...coinPnl
      }
    },
    delta_model_minus_coin: {
      accrued_income: modelPnl.accrued_income - coinPnl.accrued_income,
      roi_on_staked: modelPnl.roi_on_staked - coinPnl.roi_on_staked,
      win_rate: modelPnl.win_rate - coinPnl.win_rate,
      income_per_bet: (modelPnl.n_bets ? modelPnl.accrued_income / modelPnl.n_bets : 0) - (coinPnl.n_bets ? coinPnl.accrued_income / coinPnl.n_bets : 0)
    },
    event_ledger: eventLedger
  };

  ensureDirForFile(args.out);
  fs.writeFileSync(args.out, JSON.stringify(out, null, 2), "utf8");

  console.log("V4 Model vs Coin Complete");
  console.log("-------------------------");
  console.log(`Events: ${events.length}`);
  console.log(`Model bettor: bets=${modelPnl.n_bets} accrued_income=${modelPnl.accrued_income.toFixed(2)} roi=${modelPnl.roi_on_staked.toFixed(6)}`);
  console.log(`Coin bettor:  bets=${coinPnl.n_bets} accrued_income=${coinPnl.accrued_income.toFixed(2)} roi=${coinPnl.roi_on_staked.toFixed(6)}`);
  console.log(`Delta (model-coin) accrued_income=${(modelPnl.accrued_income - coinPnl.accrued_income).toFixed(2)}`);
  console.log(`Report: ${args.out}`);
}

main();
