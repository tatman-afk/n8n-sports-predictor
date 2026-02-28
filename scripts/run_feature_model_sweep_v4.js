#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "data", "sweeps_v4");

const CONFIGS = [
  {
    id: "v4_a_anchor_l2_001_lr_003_i8000",
    track: "a",
    iters: 8000,
    lr: 0.003,
    l2: 0.01
  },
  {
    id: "v4_a_anchor_l2_001_lr_0025_i12000",
    track: "a",
    iters: 12000,
    lr: 0.0025,
    l2: 0.01
  },
  {
    id: "v4_b_anchor_l2_0015_lr_003_i10000",
    track: "b",
    iters: 10000,
    lr: 0.003,
    l2: 0.015
  },
  {
    id: "v4_c_residual_probe",
    track: "c",
    iters: 10000,
    lr: 0.003,
    l2: 0.01
  }
];

function parseArgs(argv) {
  const args = {
    input: "data/nba_event_training_features_v4.csv",
    bootstrapSamples: 600,
    rollingWindows: 8
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--input") args.input = argv[i + 1] || args.input;
    if (token === "--bootstrap-samples") args.bootstrapSamples = Number(argv[i + 1]) || args.bootstrapSamples;
    if (token === "--rolling-windows") args.rollingWindows = Number(argv[i + 1]) || args.rollingWindows;
  }
  return args;
}

function runNode(args) {
  return spawnSync("node", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20
  });
}

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_e) {
    return null;
  }
}

function fmt(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "n/a";
  return Number(v).toFixed(6);
}

function sortResults(rows) {
  return rows.sort((a, b) => {
    const aPass = a.gate_pass ? 1 : 0;
    const bPass = b.gate_pass ? 1 : 0;
    if (bPass !== aPass) return bPass - aPass;

    const aDelta = (a.event_model_logloss ?? 99) - (a.event_market_logloss ?? 0);
    const bDelta = (b.event_model_logloss ?? 99) - (b.event_market_logloss ?? 0);
    if (aDelta !== bDelta) return aDelta - bDelta;

    const aCi = Number.isFinite(a.logloss_ci_high) ? a.logloss_ci_high : 99;
    const bCi = Number.isFinite(b.logloss_ci_high) ? b.logloss_ci_high : 99;
    if (aCi !== bCi) return aCi - bCi;

    const aP = Number.isFinite(a.brier_p_better) ? a.brier_p_better : -1;
    const bP = Number.isFinite(b.brier_p_better) ? b.brier_p_better : -1;
    if (aP !== bP) return bP - aP;

    const aStd = Number.isFinite(a.rolling_logloss_std) ? a.rolling_logloss_std : 99;
    const bStd = Number.isFinite(b.rolling_logloss_std) ? b.rolling_logloss_std : 99;
    return aStd - bStd;
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureOutDir();

  if (!fs.existsSync(path.join(ROOT, args.input))) {
    throw new Error(`Input file not found: ${args.input}. Build v4 features first.`);
  }

  const rows = [];
  for (const cfg of CONFIGS) {
    const outFile = path.join(OUT_DIR, `nba_feature_model_${cfg.id}.json`);
    console.log(`\n=== Running ${cfg.id} ===`);

    const modelArgs = [
      "scripts/ml_event_feature_model_v4.js",
      "--input", args.input,
      "--out", outFile,
      "--track", cfg.track,
      "--iters", String(cfg.iters),
      "--lr", String(cfg.lr),
      "--l2", String(cfg.l2),
      "--bootstrap-samples", String(args.bootstrapSamples),
      "--rolling-windows", String(args.rollingWindows)
    ];

    const modelRes = runNode(modelArgs);
    if (modelRes.status !== 0) {
      rows.push({
        id: cfg.id,
        track: cfg.track,
        status: "model_failed",
        error: (modelRes.stderr || modelRes.stdout || "").slice(-500),
        cfg
      });
      console.error(`Model run failed for ${cfg.id}`);
      continue;
    }

    const gateArgs = [
      "scripts/ml_acceptance_gate.js",
      "--input", outFile,
      "--logloss-ci-upper-max", "0",
      "--brier-ci-upper-max", "0.0001",
      "--brier-p-better-min", "0.97"
    ];
    const gateRes = runNode(gateArgs);

    const j = safeReadJson(outFile);
    const test = j?.event_level?.metrics?.test || {};
    const ci = j?.event_level?.bootstrap_ci_test?.platt_vs_market || {};
    const rolling = j?.event_level?.rolling_windows?.stability?.platt_vs_market_logloss || {};

    rows.push({
      id: cfg.id,
      track: cfg.track,
      out_file: path.relative(ROOT, outFile),
      gate_pass: gateRes.status === 0,
      event_market_logloss: test.market_implied?.logloss ?? null,
      event_model_logloss: test.platt_scaled?.logloss ?? null,
      event_market_brier: test.market_implied?.brier ?? null,
      event_model_brier: test.platt_scaled?.brier ?? null,
      logloss_ci_high: ci.logloss?.ci_95_high ?? null,
      brier_ci_high: ci.brier?.ci_95_high ?? null,
      brier_p_better: ci.brier?.p_model_better ?? null,
      rolling_logloss_std: rolling.std ?? null,
      rolling_logloss_share_better: rolling.share_better ?? null,
      cfg
    });

    console.log(`Gate: ${gateRes.status === 0 ? "PASS" : "FAIL"}`);
    console.log(`Event logloss model=${fmt(test.platt_scaled?.logloss)} market=${fmt(test.market_implied?.logloss)}`);
    console.log(`Event brier   model=${fmt(test.platt_scaled?.brier)} market=${fmt(test.market_implied?.brier)}`);
  }

  const failed = rows.filter((r) => r.status === "model_failed");
  const scored = sortResults(rows.filter((r) => r.status !== "model_failed"));
  const report = {
    created_at: new Date().toISOString(),
    input: args.input,
    ranking_criteria: [
      "gate_pass",
      "event_logloss_delta_vs_market",
      "logloss_ci_high",
      "brier_p_better",
      "rolling_logloss_std"
    ],
    total_configs: CONFIGS.length,
    results: scored,
    failed
  };

  const reportPath = path.join(OUT_DIR, "nba_feature_model_sweep_v4_report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log("\nSweep V4 Summary");
  console.log("----------------");
  for (const r of scored) {
    const loglossDelta = (r.event_model_logloss ?? 0) - (r.event_market_logloss ?? 0);
    console.log(
      `${r.id} | gate=${r.gate_pass ? "PASS" : "FAIL"} | logloss_delta=${fmt(loglossDelta)} | ci_high=${fmt(r.logloss_ci_high)} | brier_p=${fmt(r.brier_p_better)} | rolling_std=${fmt(r.rolling_logloss_std)}`
    );
  }
  console.log(`Report: ${path.relative(ROOT, reportPath)}`);

  const anyPass = scored.some((r) => r.gate_pass);
  if (!anyPass) process.exit(2);
}

main();
