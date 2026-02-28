#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    input: "data/nba_event_training_features_v4.csv",
    out: "data/reports/v4_confidence_policy_backtest_2024_2025.json",
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
    slippageBps: 25,
    edgeFloor: -0.03,
    edgeCeil: 0.03,
    bucketA: 75,
    bucketB: 60,
    thresholdMode: "hybrid",
    calibrationRatio: 0.2,
    minCalibEvents: 40,
    autoBucketAMin: 20,
    autoBucketAMax: 90,
    autoBucketBMin: 10,
    autoBucketBMax: 80,
    autoStep: 5,
    minBetsA: 5,
    minBetsAB: 10,
    targetPolicy: "A_B"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--input") args.input = argv[i + 1] || args.input;
    if (t === "--out") args.out = argv[i + 1] || args.out;
    if (t === "--train-start") args.trainStart = argv[i + 1] || args.trainStart;
    if (t === "--train-end") args.trainEnd = argv[i + 1] || args.trainEnd;
    if (t === "--test-start") args.testStart = argv[i + 1] || args.testStart;
    if (t === "--test-end") args.testEnd = argv[i + 1] || args.testEnd;
    if (t === "--iters") args.iters = Number(argv[i + 1]) || args.iters;
    if (t === "--lr") args.lr = Number(argv[i + 1]) || args.lr;
    if (t === "--l2") args.l2 = Number(argv[i + 1]) || args.l2;
    if (t === "--bankroll") args.bankroll = Number(argv[i + 1]) || args.bankroll;
    if (t === "--flat-stake") args.flatStake = Number(argv[i + 1]) || args.flatStake;
    if (t === "--slippage-bps") args.slippageBps = Number(argv[i + 1]) || args.slippageBps;
    if (t === "--edge-floor") args.edgeFloor = Number(argv[i + 1]);
    if (t === "--edge-ceil") args.edgeCeil = Number(argv[i + 1]);
    if (t === "--bucket-a") args.bucketA = Number(argv[i + 1]);
    if (t === "--bucket-b") args.bucketB = Number(argv[i + 1]);
    if (t === "--threshold-mode") args.thresholdMode = String(argv[i + 1] || args.thresholdMode).toLowerCase();
    if (t === "--calibration-ratio") args.calibrationRatio = Number(argv[i + 1]) || args.calibrationRatio;
    if (t === "--min-calib-events") args.minCalibEvents = Number(argv[i + 1]) || args.minCalibEvents;
    if (t === "--auto-bucket-a-min") args.autoBucketAMin = Number(argv[i + 1]) || args.autoBucketAMin;
    if (t === "--auto-bucket-a-max") args.autoBucketAMax = Number(argv[i + 1]) || args.autoBucketAMax;
    if (t === "--auto-bucket-b-min") args.autoBucketBMin = Number(argv[i + 1]) || args.autoBucketBMin;
    if (t === "--auto-bucket-b-max") args.autoBucketBMax = Number(argv[i + 1]) || args.autoBucketBMax;
    if (t === "--auto-step") args.autoStep = Number(argv[i + 1]) || args.autoStep;
    if (t === "--min-bets-a") args.minBetsA = Number(argv[i + 1]) || args.minBetsA;
    if (t === "--min-bets-ab") args.minBetsAB = Number(argv[i + 1]) || args.minBetsAB;
    if (t === "--target-policy") args.targetPolicy = String(argv[i + 1] || args.targetPolicy);
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
        } else inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        out.push(current);
        current = "";
      } else current += ch;
    }
    out.push(current);
    return out;
  }
  const headers = splitCsvLine(lines[0]);
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j += 1) row[headers[j]] = cells[j] ?? "";
    rows.push(row);
  }
  return rows;
}

function toNum(v, fb = null) { const n = Number(v); return Number.isFinite(n) ? n : fb; }
function clipProb(p) { const eps = 1e-6; if (!Number.isFinite(p)) return null; return Math.max(eps, Math.min(1 - eps, p)); }
function logit(p) { const c = clipProb(p); return c === null ? null : Math.log(c / (1 - c)); }
function sigmoid(z) { if (z >= 0) { const ez = Math.exp(-z); return 1 / (1 + ez); } const ez = Math.exp(z); return ez / (1 + ez); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function mean(vals) { if (!vals.length) return 0; return vals.reduce((s, v) => s + v, 0) / vals.length; }
function inRange(ts, start, end) { const s = new Date(`${start}T00:00:00Z`).getTime(); const e = new Date(`${end}T23:59:59Z`).getTime(); return ts >= s && ts <= e; }
function americanToDecimal(a) { if (!Number.isFinite(a) || a === 0) return null; return a > 0 ? (1 + a / 100) : (1 + 100 / Math.abs(a)); }
function withSlippage(dec, bps) { if (!Number.isFinite(dec)) return null; return 1 + Math.max(0, (dec - 1) * (1 - bps / 10000)); }
function ensureDirForFile(f) { fs.mkdirSync(path.dirname(f), { recursive: true }); }

function prepRows(rawRows, featureNames) {
  return rawRows.map((r) => {
    const implied = toNum(r.implied_prob);
    const feats = {};
    for (const f of featureNames) feats[f] = f === "implied_logit" ? logit(implied) : toNum(r[f]);
    return {
      ...r,
      event_id: String(r.event_id || ""),
      startsAtTs: new Date(r.starts_at || 0).getTime(),
      team_name: String(r.team_name || ""),
      implied_prob: implied,
      odds_american_avg: toNum(r.odds_american_avg),
      books_aggregated: toNum(r.books_aggregated, 0),
      missing_market_features: toNum(r.missing_market_features, 0),
      missing_schedule_features: toNum(r.missing_schedule_features, 0),
      missing_form_features: toNum(r.missing_form_features, 0),
      y: toNum(r.team_win),
      features: feats
    };
  }).filter((r) => Number.isFinite(r.startsAtTs) && Number.isFinite(r.implied_prob) && (r.y === 0 || r.y === 1));
}

function buildFeatureStats(trainRows, featureNames) {
  const means = {}, stds = {};
  for (const f of featureNames) {
    const vals = trainRows.map((r) => r.features[f]).filter((v) => Number.isFinite(v));
    const m = vals.length ? mean(vals) : 0;
    const v = vals.length ? vals.reduce((s, x) => s + (x - m) * (x - m), 0) / Math.max(1, vals.length - 1) : 0;
    const sd = Math.sqrt(v);
    means[f] = m;
    stds[f] = sd > 1e-8 ? sd : 1;
  }
  return { means, stds };
}

function featureVector(r, featureNames, stats) {
  const x = [];
  for (const f of featureNames) {
    const v = Number.isFinite(r.features[f]) ? r.features[f] : stats.means[f];
    x.push((v - stats.means[f]) / stats.stds[f]);
  }
  return x;
}

function trainLogit(trainRows, featureNames, args) {
  const stats = buildFeatureStats(trainRows, featureNames);
  const w = new Array(featureNames.length).fill(0);
  let b = 0;
  for (let it = 0; it < args.iters; it += 1) {
    const gw = new Array(featureNames.length).fill(0);
    let gb = 0;
    for (const r of trainRows) {
      const x = featureVector(r, featureNames, stats);
      let z = b;
      for (let j = 0; j < x.length; j += 1) z += w[j] * x[j];
      const p = sigmoid(z);
      const e = p - r.y;
      for (let j = 0; j < x.length; j += 1) gw[j] += e * x[j];
      gb += e;
    }
    const n = trainRows.length || 1;
    for (let j = 0; j < w.length; j += 1) w[j] -= args.lr * (gw[j] / n + args.l2 * w[j]);
    b -= (args.lr * gb) / n;
  }
  return { w, b, stats };
}

function predict(r, model, featureNames) {
  const x = featureVector(r, featureNames, model.stats);
  let z = model.b;
  for (let j = 0; j < x.length; j += 1) z += model.w[j] * x[j];
  return clipProb(sigmoid(z));
}

function confidenceScore(pick, rowsInEvent, args) {
  const edge = pick.p_model - pick.implied_prob;
  const edgeS = clamp((edge - args.edgeFloor) / Math.max(1e-9, (args.edgeCeil - args.edgeFloor)), 0, 1);
  const books = rowsInEvent.reduce((s, r) => s + (r.books_aggregated || 0), 0);
  const qualityS = clamp(books / 8, 0, 1);
  const miss = (pick.missing_form_features || 0) + (pick.missing_schedule_features || 0) + (pick.missing_market_features || 0);
  const dataS = clamp(1 - miss / 3, 0, 1);
  const score = 100 * (0.6 * edgeS + 0.25 * qualityS + 0.15 * dataS);
  return { score, edge };
}

function bucketFromScore(score, bucketA, bucketB) {
  if (score >= bucketA) return "A";
  if (score >= bucketB) return "B";
  return "C";
}

function simulatePolicy(picks, args, policy, bucketA, bucketB) {
  let bankroll = args.bankroll;
  let staked = 0;
  let wins = 0;
  let losses = 0;
  for (const p of picks) {
    const bucket = bucketFromScore(p.confidence_score, bucketA, bucketB);
    let mult = 0;
    if (policy === "A_only") mult = bucket === "A" ? 1 : 0;
    if (policy === "A_B") mult = bucket === "A" ? 1 : (bucket === "B" ? 0.5 : 0);
    if (policy === "all") mult = bucket === "A" ? 1 : (bucket === "B" ? 0.5 : 0.25);
    const stake = Math.min(bankroll, args.flatStake * mult);
    if (stake <= 0) continue;
    const dec = withSlippage(americanToDecimal(p.odds_american_avg), args.slippageBps);
    if (!Number.isFinite(dec)) continue;
    const profit = p.y === 1 ? stake * (dec - 1) : -stake;
    bankroll += profit;
    staked += stake;
    if (p.y === 1) wins += 1; else losses += 1;
  }
  const n = wins + losses;
  return {
    policy,
    bankroll_start: args.bankroll,
    bankroll_end: bankroll,
    accrued_income: bankroll - args.bankroll,
    total_staked: staked,
    roi_on_staked: staked > 0 ? (bankroll - args.bankroll) / staked : 0,
    n_bets: n,
    win_rate: n ? wins / n : 0
  };
}

function buildPicks(predRows, args) {
  const byEvent = new Map();
  for (const r of predRows) {
    if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, []);
    byEvent.get(r.event_id).push(r);
  }
  const picks = [];
  const skippedMalformed = [];
  for (const [eventId, rowsInEvent] of byEvent.entries()) {
    if (rowsInEvent.length !== 2) {
      skippedMalformed.push(eventId);
      continue;
    }
    const top = [...rowsInEvent].sort((a, b) => b.p_model - a.p_model)[0];
    const c = confidenceScore(top, rowsInEvent, args);
    picks.push({
      event_id: eventId,
      starts_at: rowsInEvent[0].starts_at,
      team_name: top.team_name,
      odds_american_avg: top.odds_american_avg,
      y: top.y,
      p_model: top.p_model,
      p_market: top.implied_prob,
      edge: c.edge,
      confidence_score: c.score
    });
  }
  picks.sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  return { picks, skippedMalformed, rawEvents: byEvent.size };
}

function splitTrainForCalibration(trainRows, calibrationRatio) {
  const byEvent = new Map();
  for (const r of trainRows) {
    if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, []);
    byEvent.get(r.event_id).push(r);
  }
  const events = Array.from(byEvent.values())
    .map((rowsInEvent) => ({ event_id: rowsInEvent[0]?.event_id, startsAtTs: rowsInEvent[0]?.startsAtTs || 0, rows: rowsInEvent }))
    .sort((a, b) => a.startsAtTs - b.startsAtTs || String(a.event_id).localeCompare(String(b.event_id)));

  const calibCount = Math.max(1, Math.floor(events.length * calibrationRatio));
  const trainCount = Math.max(1, events.length - calibCount);
  const subtrain = events.slice(0, trainCount).flatMap((e) => e.rows);
  const calib = events.slice(trainCount).flatMap((e) => e.rows);
  return { subtrain, calib, trainEvents: trainCount, calibEvents: events.length - trainCount };
}

function tuneThresholdsHybrid(calibPicks, args) {
  const scores = calibPicks.map((p) => p.confidence_score).filter((v) => Number.isFinite(v));
  if (!scores.length) return null;

  const minScore = Math.floor(Math.min(...scores) / args.autoStep) * args.autoStep;
  const maxScore = Math.ceil(Math.max(...scores) / args.autoStep) * args.autoStep;
  const aMin = Math.max(args.autoBucketAMin, minScore + args.autoStep);
  const aMax = Math.min(args.autoBucketAMax, maxScore);
  const bMinGlobal = Math.max(args.autoBucketBMin, minScore);
  const bMaxGlobal = Math.min(args.autoBucketBMax, maxScore - args.autoStep);

  function search(minBetsRequired) {
    let best = null;
    for (let a = aMin; a <= aMax; a += args.autoStep) {
      for (let b = bMinGlobal; b <= Math.min(bMaxGlobal, a - args.autoStep); b += args.autoStep) {
        const rA = simulatePolicy(calibPicks, args, "A_only", a, b);
        const rAB = simulatePolicy(calibPicks, args, "A_B", a, b);
        const target = args.targetPolicy === "A_only" ? rA : rAB;
        if (target.n_bets < minBetsRequired) continue;
        const objective = target.roi_on_staked * Math.sqrt(Math.max(1, target.n_bets));
        const candidate = { bucketA: a, bucketB: b, objective, target, A_only: rA, A_B: rAB, min_bets_required: minBetsRequired };
        if (!best || candidate.objective > best.objective) best = candidate;
      }
    }
    return best;
  }

  const strictMin = args.targetPolicy === "A_only" ? args.minBetsA : args.minBetsAB;
  const strict = search(strictMin);
  if (strict) return strict;
  return search(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = parseCsv(fs.readFileSync(args.input, "utf8"));
  const rows = prepRows(raw, args.features);
  const train = rows.filter((r) => inRange(r.startsAtTs, args.trainStart, args.trainEnd));
  const test = rows.filter((r) => inRange(r.startsAtTs, args.testStart, args.testEnd));
  if (!train.length || !test.length) throw new Error("No train/test rows for selected dates.");

  let activeBucketA = args.bucketA;
  let activeBucketB = args.bucketB;
  let tuning = { mode: "manual", used_fallback_manual: false };

  if (args.thresholdMode === "hybrid") {
    const split = splitTrainForCalibration(train, args.calibrationRatio);
    if (split.calibEvents >= args.minCalibEvents) {
      const calibModel = trainLogit(split.subtrain, args.features, args);
      const calibPred = split.calib.map((r) => ({ ...r, p_model: predict(r, calibModel, args.features) }));
      const calibBuilt = buildPicks(calibPred, args);
      const tuned = tuneThresholdsHybrid(calibBuilt.picks, args);
      if (tuned) {
        activeBucketA = tuned.bucketA;
        activeBucketB = tuned.bucketB;
        tuning = {
          mode: "hybrid",
          used_fallback_manual: false,
          calibration_events: split.calibEvents,
          subtrain_events: split.trainEvents,
          chosen: tuned
        };
      } else {
        tuning = {
          mode: "hybrid",
          used_fallback_manual: true,
          reason: "No threshold pair met minimum-bet guardrails.",
          calibration_events: split.calibEvents,
          subtrain_events: split.trainEvents
        };
      }
    } else {
      tuning = {
        mode: "hybrid",
        used_fallback_manual: true,
        reason: `Calibration event count too low (${split.calibEvents} < ${args.minCalibEvents}).`,
        calibration_events: split.calibEvents,
        subtrain_events: split.trainEvents
      };
    }
  }

  const model = trainLogit(train, args.features, args);
  const testPred = test.map((r) => ({ ...r, p_model: predict(r, model, args.features) }));
  const built = buildPicks(testPred, args);
  const picks = built.picks;

  const resA = simulatePolicy(picks, args, "A_only", activeBucketA, activeBucketB);
  const resAB = simulatePolicy(picks, args, "A_B", activeBucketA, activeBucketB);
  const resAll = simulatePolicy(picks, args, "all", activeBucketA, activeBucketB);
  const policies = [resA, resAB, resAll].sort((a, b) => b.roi_on_staked - a.roi_on_staked);

  const bucketStats = ["A", "B", "C"].map((b) => {
    const bucketRows = picks.filter((p) => bucketFromScore(p.confidence_score, activeBucketA, activeBucketB) === b);
    return {
      bucket: b,
      n: bucketRows.length,
      avg_confidence: mean(bucketRows.map((p) => p.confidence_score)),
      avg_edge: mean(bucketRows.map((p) => p.edge)),
      hit_rate: bucketRows.length ? mean(bucketRows.map((p) => p.y)) : 0
    };
  });

  const report = {
    created_at: new Date().toISOString(),
    config: {
      input: args.input,
      split: { train_start: args.trainStart, train_end: args.trainEnd, test_start: args.testStart, test_end: args.testEnd },
      model: { features: args.features, iters: args.iters, lr: args.lr, l2: args.l2 },
      confidence: {
        edge_floor: args.edgeFloor,
        edge_ceil: args.edgeCeil,
        threshold_mode: args.thresholdMode,
        bucket_a_manual: args.bucketA,
        bucket_b_manual: args.bucketB,
        bucket_a_active: activeBucketA,
        bucket_b_active: activeBucketB,
        auto_bounds: { a_min: args.autoBucketAMin, a_max: args.autoBucketAMax, b_min: args.autoBucketBMin, b_max: args.autoBucketBMax, step: args.autoStep },
        guardrails: { min_bets_a: args.minBetsA, min_bets_ab: args.minBetsAB, target_policy: args.targetPolicy }
      },
      risk: { bankroll: args.bankroll, flat_stake: args.flatStake, slippage_bps: args.slippageBps }
    },
    threshold_tuning: tuning,
    data_quality: {
      train_rows: train.length,
      test_rows: test.length,
      test_events_raw: built.rawEvents,
      test_events_used: picks.length,
      skipped_malformed_events: built.skippedMalformed.length,
      skipped_malformed_event_ids: built.skippedMalformed
    },
    confidence_buckets: bucketStats,
    policy_results: [resA, resAB, resAll],
    recommendation: {
      best_policy_by_roi: policies[0],
      note: "Prefer policy with best ROI that still has adequate sample size."
    },
    picks: picks.map((p) => ({ ...p, bucket: bucketFromScore(p.confidence_score, activeBucketA, activeBucketB) }))
  };

  ensureDirForFile(args.out);
  fs.writeFileSync(args.out, JSON.stringify(report, null, 2), "utf8");

  console.log("V4 Confidence Policy Backtest Complete");
  console.log("--------------------------------------");
  console.log(`Thresholds active: A>=${activeBucketA} B>=${activeBucketB} (mode=${args.thresholdMode})`);
  console.log(`Picks scored: ${picks.length} | malformed events skipped: ${built.skippedMalformed.length}`);
  console.log(`A_only: income=${resA.accrued_income.toFixed(2)} roi=${resA.roi_on_staked.toFixed(4)} bets=${resA.n_bets}`);
  console.log(`A_B:    income=${resAB.accrued_income.toFixed(2)} roi=${resAB.roi_on_staked.toFixed(4)} bets=${resAB.n_bets}`);
  console.log(`all:    income=${resAll.accrued_income.toFixed(2)} roi=${resAll.roi_on_staked.toFixed(4)} bets=${resAll.n_bets}`);
  console.log(`Recommended policy: ${policies[0].policy}`);
  console.log(`Report: ${args.out}`);
}

main();
