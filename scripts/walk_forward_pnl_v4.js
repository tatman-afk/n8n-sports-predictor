#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    input: "data/nba_event_training_features_v4.csv",
    out: "data/reports/v4_walk_forward_pnl_report.json",
    features: ["implied_logit"],
    iters: 12000,
    lr: 0.0025,
    l2: 0.01,
    edgeMin: -0.02,
    bankroll: 10000,
    flatStake: 100,
    maxStakePct: 0.03,
    slippageBps: 0,
    minTrainSeasons: 2,
    coinSeeds: 200,
    bootstrapSamples: 1000
  };

  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--input") args.input = argv[i + 1] || args.input;
    if (t === "--out") args.out = argv[i + 1] || args.out;
    if (t === "--features") {
      args.features = String(argv[i + 1] || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (t === "--iters") args.iters = Number(argv[i + 1]) || args.iters;
    if (t === "--lr") args.lr = Number(argv[i + 1]) || args.lr;
    if (t === "--l2") args.l2 = Number(argv[i + 1]) || args.l2;
    if (t === "--edge-min") args.edgeMin = Number(argv[i + 1]);
    if (t === "--bankroll") args.bankroll = Number(argv[i + 1]) || args.bankroll;
    if (t === "--flat-stake") args.flatStake = Number(argv[i + 1]) || args.flatStake;
    if (t === "--max-stake-pct") args.maxStakePct = Number(argv[i + 1]) || args.maxStakePct;
    if (t === "--slippage-bps") args.slippageBps = Number(argv[i + 1]) || args.slippageBps;
    if (t === "--min-train-seasons") args.minTrainSeasons = Number(argv[i + 1]) || args.minTrainSeasons;
    if (t === "--coin-seeds") args.coinSeeds = Number(argv[i + 1]) || args.coinSeeds;
    if (t === "--bootstrap-samples") args.bootstrapSamples = Number(argv[i + 1]) || args.bootstrapSamples;
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

function seasonLabel(ts) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const start = m >= 10 ? y : y - 1;
  return `${start}-${start + 1}`;
}

function americanToDecimal(american) {
  if (!Number.isFinite(american) || american === 0) return null;
  if (american > 0) return 1 + (american / 100);
  return 1 + (100 / Math.abs(american));
}

function applySlippage(decimalOdds, bps) {
  if (!Number.isFinite(decimalOdds)) return null;
  const factor = 1 - (bps / 10000);
  const adj = 1 + Math.max(0, (decimalOdds - 1) * factor);
  return Math.max(1.000001, adj);
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function prepareRows(rawRows, featureNames) {
  return rawRows
    .map((r) => {
      const implied = toNum(r.implied_prob);
      const features = {};
      for (const f of featureNames) features[f] = f === "implied_logit" ? logit(implied) : toNum(r[f]);
      const oddsAvg = toNum(r.odds_american_avg);
      return {
        ...r,
        event_id: String(r.event_id || ""),
        team_id: String(r.team_id || ""),
        team_name: String(r.team_name || ""),
        is_home: String(r.is_home || "") === "1" ? 1 : 0,
        startsAtTs: new Date(r.starts_at || 0).getTime(),
        season: null,
        implied_prob: implied,
        odds_american_avg: oddsAvg,
        y: toNum(r.team_win),
        features
      };
    })
    .filter((r) => Number.isFinite(r.startsAtTs) && Number.isFinite(r.implied_prob) && (r.y === 0 || r.y === 1))
    .map((r) => ({ ...r, season: seasonLabel(r.startsAtTs) }));
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
  const x = [];
  for (const f of featureNames) {
    const raw = row.features[f];
    const v = Number.isFinite(raw) ? raw : stats.means[f];
    x.push((v - stats.means[f]) / stats.stds[f]);
  }
  return x;
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

function groupByEvent(rows) {
  const byEvent = new Map();
  for (const row of rows) {
    if (!byEvent.has(row.event_id)) byEvent.set(row.event_id, []);
    byEvent.get(row.event_id).push(row);
  }
  return byEvent;
}

function settleFlat(picks, bankrollStart, flatStake, maxStakePct, slippageBps) {
  let bankroll = bankrollStart;
  let staked = 0;
  let wins = 0;
  let losses = 0;
  let maxPeak = bankroll;
  let maxDrawdown = 0;
  const profits = [];

  for (const pick of picks) {
    const stakeCap = bankroll * maxStakePct;
    const stake = Math.min(flatStake, stakeCap, bankroll);
    if (stake <= 0) break;
    const decRaw = americanToDecimal(pick.odds_american_avg);
    const dec = applySlippage(decRaw, slippageBps);
    if (!Number.isFinite(dec)) continue;

    const won = pick.y === 1;
    const profit = won ? stake * (dec - 1) : -stake;
    bankroll += profit;
    staked += stake;
    profits.push(profit);
    if (won) wins += 1;
    else losses += 1;

    if (bankroll > maxPeak) maxPeak = bankroll;
    const dd = maxPeak > 0 ? (maxPeak - bankroll) / maxPeak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const n = wins + losses;
  return {
    bankroll_start: bankrollStart,
    bankroll_end: bankroll,
    accrued_income: bankroll - bankrollStart,
    total_staked: staked,
    roi_on_staked: staked > 0 ? (bankroll - bankrollStart) / staked : 0,
    n_bets: n,
    wins,
    losses,
    win_rate: n ? wins / n : 0,
    max_drawdown: maxDrawdown,
    profits
  };
}

function bootstrapPnlCi(picks, args) {
  if (!picks.length) return null;
  const profits = picks.map((pick) => {
    const dec = applySlippage(americanToDecimal(pick.odds_american_avg), args.slippageBps);
    if (!Number.isFinite(dec)) return 0;
    const stake = Math.min(args.flatStake, args.bankroll * args.maxStakePct);
    return pick.y === 1 ? stake * (dec - 1) : -stake;
  });

  const totals = [];
  const rois = [];
  for (let i = 0; i < args.bootstrapSamples; i += 1) {
    let total = 0;
    let staked = 0;
    for (let j = 0; j < profits.length; j += 1) {
      const idx = Math.floor(Math.random() * profits.length);
      total += profits[idx];
      staked += Math.min(args.flatStake, args.bankroll * args.maxStakePct);
    }
    totals.push(total);
    rois.push(staked > 0 ? total / staked : 0);
  }
  return {
    samples: args.bootstrapSamples,
    pnl_ci_95_low: percentile(totals, 0.025),
    pnl_ci_95_high: percentile(totals, 0.975),
    roi_ci_95_low: percentile(rois, 0.025),
    roi_ci_95_high: percentile(rois, 0.975)
  };
}

function pickFavorite(rowsInEvent) {
  return [...rowsInEvent].sort((a, b) => b.implied_prob - a.implied_prob)[0];
}

function pickUnderdog(rowsInEvent) {
  return [...rowsInEvent].sort((a, b) => a.implied_prob - b.implied_prob)[0];
}

function pickMarketTopProb(rowsInEvent) {
  return pickFavorite(rowsInEvent);
}

function runWindow(trainRows, testRows, args) {
  const model = trainLogit(trainRows, args.features, args);
  const testPred = testRows.map((r) => ({ ...r, p_model: predictProb(r, model, args.features) }));
  const byEvent = groupByEvent(testPred);

  const malformedEventIds = [];
  const cleanEvents = [];
  for (const [eventId, rowsInEvent] of byEvent.entries()) {
    if (rowsInEvent.length !== 2) {
      malformedEventIds.push(eventId);
      continue;
    }
    cleanEvents.push(rowsInEvent);
  }
  cleanEvents.sort((a, b) => a[0].startsAtTs - b[0].startsAtTs || String(a[0].event_id).localeCompare(String(b[0].event_id)));

  const modelPicks = [];
  const modelEventSet = new Set();
  for (const rowsInEvent of cleanEvents) {
    const topModel = [...rowsInEvent].sort((a, b) => b.p_model - a.p_model)[0];
    const edge = topModel.p_model - topModel.implied_prob;
    if (edge >= args.edgeMin) {
      modelPicks.push(topModel);
      modelEventSet.add(topModel.event_id);
    }
  }

  const favoritePicks = [];
  const underdogPicks = [];
  const marketTopPicks = [];
  for (const rowsInEvent of cleanEvents) {
    const eventId = rowsInEvent[0].event_id;
    if (!modelEventSet.has(eventId)) continue;
    favoritePicks.push(pickFavorite(rowsInEvent));
    underdogPicks.push(pickUnderdog(rowsInEvent));
    marketTopPicks.push(pickMarketTopProb(rowsInEvent));
  }

  const modelPnl = settleFlat(modelPicks, args.bankroll, args.flatStake, args.maxStakePct, args.slippageBps);
  const favoritePnl = settleFlat(favoritePicks, args.bankroll, args.flatStake, args.maxStakePct, args.slippageBps);
  const underdogPnl = settleFlat(underdogPicks, args.bankroll, args.flatStake, args.maxStakePct, args.slippageBps);
  const marketTopPnl = settleFlat(marketTopPicks, args.bankroll, args.flatStake, args.maxStakePct, args.slippageBps);

  const coinRuns = [];
  for (let s = 0; s < args.coinSeeds; s += 1) {
    const rand = seededRng(s + 1);
    const coinPicks = [];
    for (const rowsInEvent of cleanEvents) {
      if (!modelEventSet.has(rowsInEvent[0].event_id)) continue;
      const idx = Math.floor(rand() * rowsInEvent.length);
      coinPicks.push(rowsInEvent[idx]);
    }
    const coinPnl = settleFlat(coinPicks, args.bankroll, args.flatStake, args.maxStakePct, args.slippageBps);
    coinRuns.push({
      seed: s + 1,
      accrued_income: coinPnl.accrued_income,
      roi_on_staked: coinPnl.roi_on_staked
    });
  }

  const modelVsCoinDeltas = coinRuns.map((r) => modelPnl.accrued_income - r.accrued_income);
  const beatRate = coinRuns.length ? coinRuns.filter((r) => modelPnl.accrued_income > r.accrued_income).length / coinRuns.length : null;

  return {
    model: {
      ...modelPnl,
      bootstrap_ci: bootstrapPnlCi(modelPicks, args)
    },
    baselines: {
      favorite: favoritePnl,
      underdog: underdogPnl,
      market_top_prob: marketTopPnl,
      coin_monte_carlo: {
        runs: coinRuns.length,
        mean_income: mean(coinRuns.map((r) => r.accrued_income)),
        p05_income: percentile(coinRuns.map((r) => r.accrued_income), 0.05),
        p50_income: percentile(coinRuns.map((r) => r.accrued_income), 0.5),
        p95_income: percentile(coinRuns.map((r) => r.accrued_income), 0.95),
        mean_roi: mean(coinRuns.map((r) => r.roi_on_staked)),
        model_beats_coin_rate: beatRate,
        model_minus_coin_income_mean: mean(modelVsCoinDeltas),
        model_minus_coin_income_p05: percentile(modelVsCoinDeltas, 0.05),
        model_minus_coin_income_p95: percentile(modelVsCoinDeltas, 0.95)
      }
    },
    quality: {
      test_rows: testPred.length,
      test_events_raw: byEvent.size,
      test_events_used: cleanEvents.length,
      malformed_test_events: malformedEventIds.length,
      malformed_test_event_ids: malformedEventIds
    },
    model_bet_count: modelPicks.length,
    model_bet_rate_vs_events: cleanEvents.length ? modelPicks.length / cleanEvents.length : 0
  };
}

function summarizeWindows(windows) {
  const modelIncomes = windows.map((w) => w.metrics.model.accrued_income);
  const modelRois = windows.map((w) => w.metrics.model.roi_on_staked);
  const beatCoinRates = windows.map((w) => w.metrics.baselines.coin_monte_carlo.model_beats_coin_rate).filter((v) => Number.isFinite(v));
  const betRates = windows.map((w) => w.metrics.model_bet_rate_vs_events);
  return {
    n_windows: windows.length,
    model_income_mean: mean(modelIncomes),
    model_income_std: std(modelIncomes),
    model_roi_mean: mean(modelRois),
    model_roi_std: std(modelRois),
    model_beats_coin_rate_mean: beatCoinRates.length ? mean(beatCoinRates) : null,
    model_bet_rate_mean: mean(betRates),
    model_bet_rate_std: std(betRates)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.input)) throw new Error(`Input not found: ${args.input}`);

  const raw = parseCsv(fs.readFileSync(args.input, "utf8"));
  const rows = prepareRows(raw, args.features);
  if (!rows.length) throw new Error("No rows parsed from input.");

  const seasons = Array.from(new Set(rows.map((r) => r.season))).sort((a, b) => String(a).localeCompare(String(b)));
  if (seasons.length < args.minTrainSeasons + 1) {
    throw new Error(`Need at least ${args.minTrainSeasons + 1} seasons for walk-forward; found ${seasons.length}.`);
  }

  const windows = [];
  for (let i = args.minTrainSeasons; i < seasons.length; i += 1) {
    const testSeason = seasons[i];
    const trainSeasons = seasons.slice(0, i);
    const trainRows = rows.filter((r) => trainSeasons.includes(r.season));
    const testRows = rows.filter((r) => r.season === testSeason);
    if (!trainRows.length || !testRows.length) continue;

    const metrics = runWindow(trainRows, testRows, args);
    windows.push({
      test_season: testSeason,
      train_seasons: trainSeasons,
      train_rows: trainRows.length,
      test_rows: testRows.length,
      metrics
    });
  }

  const report = {
    created_at: new Date().toISOString(),
    config: {
      input: args.input,
      model: { features: args.features, iters: args.iters, lr: args.lr, l2: args.l2 },
      betting: {
        edge_min: args.edgeMin,
        bankroll: args.bankroll,
        flat_stake: args.flatStake,
        max_stake_pct: args.maxStakePct,
        slippage_bps: args.slippageBps
      },
      evaluation: {
        min_train_seasons: args.minTrainSeasons,
        coin_seeds: args.coinSeeds,
        bootstrap_samples: args.bootstrapSamples
      }
    },
    data_quality: {
      total_rows: rows.length,
      seasons,
      rows_missing_odds_american_avg: rows.filter((r) => !Number.isFinite(r.odds_american_avg)).length
    },
    walk_forward_windows: windows,
    summary: summarizeWindows(windows)
  };

  ensureDirForFile(args.out);
  fs.writeFileSync(args.out, JSON.stringify(report, null, 2), "utf8");

  console.log("V4 Walk-Forward PnL Complete");
  console.log("----------------------------");
  console.log(`Windows: ${windows.length}`);
  for (const w of windows) {
    const m = w.metrics.model;
    const c = w.metrics.baselines.coin_monte_carlo;
    console.log(`${w.test_season} | bets=${m.n_bets} | income=${m.accrued_income.toFixed(2)} | roi=${m.roi_on_staked.toFixed(4)} | beat_coin_rate=${(100 * (c.model_beats_coin_rate || 0)).toFixed(1)}%`);
  }
  console.log(`Report: ${args.out}`);
}

main();
