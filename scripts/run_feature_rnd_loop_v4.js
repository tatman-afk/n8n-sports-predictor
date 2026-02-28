#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const CONFIGS = [
  { id: "anchor_logit", features: "implied_logit" },
  { id: "logit_plus_home", features: "implied_logit,is_home" },
  { id: "logit_plus_rest", features: "implied_logit,rest_days_diff,is_back_to_back_diff" },
  { id: "logit_plus_form", features: "implied_logit,rolling_win_rate_diff_10,rolling_net_rating_diff_10" },
  { id: "logit_plus_market_quality", features: "implied_logit,books_total,market_dispersion_total,low_liquidity_total,missing_market_features" }
];

function parseArgs(argv) {
  const args = {
    input: "data/nba_event_training_features_v4.csv",
    out: "data/reports/v4_feature_rnd_loop_report.json",
    edgeMin: -0.02,
    slippageBps: 25,
    coinSeeds: 200
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--input") args.input = argv[i + 1] || args.input;
    if (t === "--out") args.out = argv[i + 1] || args.out;
    if (t === "--edge-min") args.edgeMin = Number(argv[i + 1]);
    if (t === "--slippage-bps") args.slippageBps = Number(argv[i + 1]) || args.slippageBps;
    if (t === "--coin-seeds") args.coinSeeds = Number(argv[i + 1]) || args.coinSeeds;
  }
  return args;
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function runConfig(cfg, args, outFile) {
  return spawnSync("node", [
    "scripts/walk_forward_pnl_v4.js",
    "--input", args.input,
    "--out", outFile,
    "--features", cfg.features,
    "--edge-min", String(args.edgeMin),
    "--bankroll", "10000",
    "--flat-stake", "100",
    "--max-stake-pct", "0.03",
    "--slippage-bps", String(args.slippageBps),
    "--min-train-seasons", "2",
    "--coin-seeds", String(args.coinSeeds),
    "--bootstrap-samples", "1000"
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 * 20 });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const tmpDir = path.join("data", "reports", "feature_rnd_runs");
  fs.mkdirSync(tmpDir, { recursive: true });
  const rows = [];

  for (const cfg of CONFIGS) {
    const outFile = path.join(tmpDir, `${cfg.id}.json`);
    const res = runConfig(cfg, args, outFile);
    if (res.status !== 0 || !fs.existsSync(outFile)) {
      rows.push({
        id: cfg.id,
        status: "failed",
        features: cfg.features,
        error: (res.stderr || res.stdout || "").slice(-500)
      });
      continue;
    }
    const j = JSON.parse(fs.readFileSync(outFile, "utf8"));
    rows.push({
      id: cfg.id,
      status: "ok",
      features: cfg.features,
      model_roi_mean: j.summary?.model_roi_mean ?? null,
      model_income_mean: j.summary?.model_income_mean ?? null,
      model_beats_coin_rate_mean: j.summary?.model_beats_coin_rate_mean ?? null,
      model_bet_rate_mean: j.summary?.model_bet_rate_mean ?? null,
      report: outFile
    });
  }

  const ranked = rows
    .filter((r) => r.status === "ok")
    .sort((a, b) => {
      const sa = (a.model_roi_mean || -99) * Math.sqrt(Math.max(1e-9, a.model_bet_rate_mean || 0));
      const sb = (b.model_roi_mean || -99) * Math.sqrt(Math.max(1e-9, b.model_bet_rate_mean || 0));
      return sb - sa;
    });

  const report = {
    created_at: new Date().toISOString(),
    config: {
      input: args.input,
      edge_min: args.edgeMin,
      slippage_bps: args.slippageBps,
      coin_seeds: args.coinSeeds,
      configs: CONFIGS
    },
    results: rows,
    ranked_candidates: ranked
  };

  ensureDirForFile(args.out);
  fs.writeFileSync(args.out, JSON.stringify(report, null, 2), "utf8");

  console.log("V4 Feature R&D Loop Complete");
  console.log("----------------------------");
  console.log(`Configs run: ${CONFIGS.length} | Success: ${ranked.length}`);
  if (ranked.length) {
    console.log(`Top candidate: ${ranked[0].id} | roi_mean=${Number(ranked[0].model_roi_mean).toFixed(4)} | bet_rate_mean=${Number(ranked[0].model_bet_rate_mean).toFixed(4)}`);
  }
  console.log(`Report: ${args.out}`);
}

main();
