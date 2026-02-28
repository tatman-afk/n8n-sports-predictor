#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

const TRACK_CONFIGS = {
  a: {
    id: "track_a_anchor",
    desc: "Market-logit anchor (minimal transform of implied probability) for max stability.",
    iters: 12000,
    lr: 0.0025,
    l2: 0.01,
    features: [
      "implied_logit"
    ]
  },
  b: {
    id: "track_b_regularized",
    desc: "Anchor variant with slightly higher regularization for robustness checks.",
    iters: 10000,
    lr: 0.003,
    l2: 0.015,
    features: [
      "implied_logit"
    ]
  },
  c: {
    id: "track_c_optional_nonlinear",
    desc: "Optional residual add-on (kept constrained; use only if A/B already pass).",
    iters: 10000,
    lr: 0.003,
    l2: 0.01,
    features: [
      "implied_logit",
      "rest_days_diff",
      "rolling_win_rate_diff_10",
      "market_dispersion_total"
    ]
  }
};

function parseArgs(argv) {
  const args = {
    input: "data/nba_event_training_features_v4.csv",
    out: "data/nba_feature_model_v4_metrics.json",
    track: "a",
    bootstrapSamples: 1000,
    rollingWindows: 8,
    minTrainEvents: 120,
    minTestEvents: 30,
    eventAgg: "mean",
    strictBrierAnd: false,
    iters: null,
    lr: null,
    l2: null,
    features: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--input") args.input = argv[i + 1] || args.input;
    if (token === "--out") args.out = argv[i + 1] || args.out;
    if (token === "--track") args.track = String(argv[i + 1] || args.track).toLowerCase();
    if (token === "--bootstrap-samples") args.bootstrapSamples = Number(argv[i + 1]) || args.bootstrapSamples;
    if (token === "--rolling-windows") args.rollingWindows = Number(argv[i + 1]) || args.rollingWindows;
    if (token === "--min-train-events") args.minTrainEvents = Number(argv[i + 1]) || args.minTrainEvents;
    if (token === "--min-test-events") args.minTestEvents = Number(argv[i + 1]) || args.minTestEvents;
    if (token === "--event-agg") args.eventAgg = String(argv[i + 1] || args.eventAgg).toLowerCase();
    if (token === "--strict-brier-and") args.strictBrierAnd = true;
    if (token === "--iters") args.iters = Number(argv[i + 1]) || null;
    if (token === "--lr") args.lr = Number(argv[i + 1]) || null;
    if (token === "--l2") args.l2 = Number(argv[i + 1]) || null;
    if (token === "--features") {
      args.features = String(argv[i + 1] || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  return args;
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function fmt(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "n/a";
  return Number(v).toFixed(6);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const track = TRACK_CONFIGS[args.track];
  if (!track) {
    throw new Error(`Invalid --track value: ${args.track}. Use one of: ${Object.keys(TRACK_CONFIGS).join(", ")}`);
  }
  if (!fs.existsSync(args.input)) {
    throw new Error(`Input file not found: ${args.input}. Run build_nba_event_features_v4.js first.`);
  }

  const selectedFeatures = args.features && args.features.length ? args.features : track.features;
  const selectedIters = args.iters || track.iters;
  const selectedLr = args.lr || track.lr;
  const selectedL2 = args.l2 || track.l2;

  ensureDirForFile(args.out);
  const runnerArgs = [
    "scripts/ml_event_feature_model.js",
    "--input", args.input,
    "--out", args.out,
    "--iters", String(selectedIters),
    "--lr", String(selectedLr),
    "--l2", String(selectedL2),
    "--bootstrap-samples", String(args.bootstrapSamples),
    "--rolling-windows", String(args.rollingWindows),
    "--min-train-events", String(args.minTrainEvents),
    "--min-test-events", String(args.minTestEvents),
    "--event-agg", args.eventAgg,
    "--features", selectedFeatures.join(",")
  ];

  const res = spawnSync("node", runnerArgs, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20
  });
  if (res.status !== 0) {
    const msg = (res.stderr || res.stdout || "v4 model runner failed").trim();
    throw new Error(msg);
  }

  const report = JSON.parse(fs.readFileSync(args.out, "utf8"));
  report.v4 = {
    track: track.id,
    track_key: args.track,
    description: track.desc,
    selected_features: selectedFeatures,
    selected_hyperparams: {
      iters: selectedIters,
      lr: selectedLr,
      l2: selectedL2
    }
  };
  fs.writeFileSync(args.out, JSON.stringify(report, null, 2));

  const test = report?.event_level?.metrics?.test || {};
  const ci = report?.event_level?.bootstrap_ci_test?.platt_vs_market || {};

  console.log("NBA Event Feature Model V4 Complete");
  console.log("-----------------------------------");
  console.log(`Input: ${args.input}`);
  console.log(`Output: ${args.out}`);
  console.log(`Track: ${track.id}`);
  console.log(`Features: ${selectedFeatures.length}`);
  console.log(`Event logloss model=${fmt(test.platt_scaled?.logloss)} market=${fmt(test.market_implied?.logloss)}`);
  console.log(`Event brier   model=${fmt(test.platt_scaled?.brier)} market=${fmt(test.market_implied?.brier)}`);
  console.log(`Logloss CI upper=${fmt(ci.logloss?.ci_95_high)} | Brier CI upper=${fmt(ci.brier?.ci_95_high)} | Brier p_better=${fmt(ci.brier?.p_model_better)}`);
}

main();
