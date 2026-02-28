#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function parseArgs(argv) {
  const args = {
    inputs: "data/nba_event_training_features_v4.csv",
    out: "data/reports/v4_extended_coverage_report.json",
    edgeMin: -0.02,
    slippageBps: 25,
    coinSeeds: 200
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--inputs") args.inputs = argv[i + 1] || args.inputs;
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

function runWalkForward(input, outFile, args) {
  return spawnSync("node", [
    "scripts/walk_forward_pnl_v4.js",
    "--input", input,
    "--out", outFile,
    "--features", "implied_logit",
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
  const inputs = String(args.inputs).split(",").map((s) => s.trim()).filter(Boolean);
  if (!inputs.length) throw new Error("No inputs provided.");

  const tmpDir = path.join("data", "reports", "extended_coverage_runs");
  fs.mkdirSync(tmpDir, { recursive: true });

  const rows = [];
  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i];
    if (!fs.existsSync(input)) {
      rows.push({ input, status: "missing_input" });
      continue;
    }
    const outFile = path.join(tmpDir, `coverage_${i + 1}.json`);
    const res = runWalkForward(input, outFile, args);
    if (res.status !== 0 || !fs.existsSync(outFile)) {
      rows.push({
        input,
        status: "run_failed",
        error: (res.stderr || res.stdout || "").slice(-500)
      });
      continue;
    }
    const j = JSON.parse(fs.readFileSync(outFile, "utf8"));
    rows.push({
      input,
      status: "ok",
      windows: j.summary?.n_windows ?? 0,
      model_roi_mean: j.summary?.model_roi_mean ?? null,
      model_income_mean: j.summary?.model_income_mean ?? null,
      model_beats_coin_rate_mean: j.summary?.model_beats_coin_rate_mean ?? null,
      walk_forward_report: outFile
    });
  }

  const ok = rows.filter((r) => r.status === "ok");
  const report = {
    created_at: new Date().toISOString(),
    config: {
      inputs,
      edge_min: args.edgeMin,
      slippage_bps: args.slippageBps,
      coin_seeds: args.coinSeeds
    },
    summary: {
      datasets_total: inputs.length,
      datasets_ok: ok.length,
      datasets_failed: rows.length - ok.length,
      model_roi_mean_across_datasets: ok.length ? ok.reduce((s, r) => s + (r.model_roi_mean || 0), 0) / ok.length : null,
      model_beats_coin_rate_mean_across_datasets: ok.length ? ok.reduce((s, r) => s + (r.model_beats_coin_rate_mean || 0), 0) / ok.length : null
    },
    results: rows
  };

  ensureDirForFile(args.out);
  fs.writeFileSync(args.out, JSON.stringify(report, null, 2), "utf8");

  console.log("V4 Extended Coverage Complete");
  console.log("-----------------------------");
  console.log(`Datasets: ${inputs.length} | OK: ${ok.length} | Failed: ${rows.length - ok.length}`);
  console.log(`Report: ${args.out}`);
}

main();
