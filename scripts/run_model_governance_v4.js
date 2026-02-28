#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

function parseArgs(argv) {
  const args = {
    input: "data/nba_event_training_features_v4.csv",
    outDir: "data/reports/governance_v4",
    minWalkForwardRoiMean: 0,
    minWalkForwardBeatCoinMean: 0.9,
    minConfidenceABRoi: 0,
    minConfidenceABBets: 20
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--input") args.input = argv[i + 1] || args.input;
    if (t === "--out-dir") args.outDir = argv[i + 1] || args.outDir;
    if (t === "--min-wf-roi-mean") args.minWalkForwardRoiMean = Number(argv[i + 1]);
    if (t === "--min-wf-beat-coin-mean") args.minWalkForwardBeatCoinMean = Number(argv[i + 1]);
    if (t === "--min-conf-ab-roi") args.minConfidenceABRoi = Number(argv[i + 1]);
    if (t === "--min-conf-ab-bets") args.minConfidenceABBets = Number(argv[i + 1]);
  }
  return args;
}

function runNode(script, argv) {
  const res = spawnSync("node", [script, ...argv], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20
  });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || ""
  };
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function ymdhmsIsoSafe() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function findLatestGovernanceReport(outDir) {
  if (!fs.existsSync(outDir)) return null;
  const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".json")).sort();
  return files.length ? path.join(outDir, files[files.length - 1]) : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.input)) throw new Error(`Input not found: ${args.input}`);

  ensureDir(args.outDir);
  const runId = `v4_governance_${ymdhmsIsoSafe()}`;
  const integrityOut = path.join(args.outDir, `${runId}_integrity.json`);
  const wfOut = path.join(args.outDir, `${runId}_walk_forward.json`);
  const confOut = path.join(args.outDir, `${runId}_confidence.json`);
  const mcOut = path.join(args.outDir, `${runId}_coin_mc.json`);
  const reportOut = path.join(args.outDir, `${runId}.json`);

  const integrityRun = runNode("scripts/validate_event_dataset_integrity_v4.js", [
    "--input", args.input,
    "--out", integrityOut
  ]);
  const wfRun = runNode("scripts/walk_forward_pnl_v4.js", [
    "--input", args.input,
    "--out", wfOut,
    "--features", "implied_logit",
    "--edge-min", "-0.02",
    "--bankroll", "10000",
    "--flat-stake", "100",
    "--max-stake-pct", "0.03",
    "--slippage-bps", "25",
    "--min-train-seasons", "2",
    "--coin-seeds", "200",
    "--bootstrap-samples", "1000"
  ]);
  const confRun = runNode("scripts/backtest_confidence_policy_v4.js", [
    "--input", args.input,
    "--train-start", "2021-10-01",
    "--train-end", "2024-06-30",
    "--test-start", "2024-10-01",
    "--test-end", "2025-06-30",
    "--out", confOut,
    "--features", "implied_logit",
    "--slippage-bps", "25",
    "--bankroll", "10000",
    "--flat-stake", "100",
    "--threshold-mode", "hybrid"
  ]);
  const mcRun = runNode("scripts/model_vs_coin_monte_carlo_v4.js", [
    "--input", args.input,
    "--train-start", "2021-10-01",
    "--train-end", "2024-06-30",
    "--test-start", "2024-10-01",
    "--test-end", "2025-06-30",
    "--model-edge-min", "-0.02",
    "--coin-bet-prob", "1",
    "--coin-follows-model",
    "--bankroll", "10000",
    "--flat-stake", "100",
    "--seeds", "200",
    "--start-seed", "1",
    "--out", mcOut
  ]);

  const criticalRuns = [integrityRun, wfRun, confRun, mcRun];
  if (criticalRuns.some((r) => !r.ok)) {
    const fail = {
      created_at: new Date().toISOString(),
      run_id: runId,
      status: "failed",
      failures: {
        integrity: integrityRun,
        walk_forward: wfRun,
        confidence: confRun,
        coin_mc: mcRun
      }
    };
    fs.writeFileSync(reportOut, JSON.stringify(fail, null, 2), "utf8");
    throw new Error(`Governance pipeline failed; report: ${reportOut}`);
  }

  const integrity = readJson(integrityOut);
  const wf = readJson(wfOut);
  const conf = readJson(confOut);
  const mc = readJson(mcOut);
  const abPolicy = (conf.policy_results || []).find((p) => p.policy === "A_B") || null;

  const alerts = [];
  if ((integrity.total_issue_count || 0) > 0) alerts.push(`dataset_integrity_issues=${integrity.total_issue_count}`);
  if ((wf.summary?.model_roi_mean ?? -1) <= args.minWalkForwardRoiMean) alerts.push("walk_forward_roi_mean_below_threshold");
  if ((wf.summary?.model_beats_coin_rate_mean ?? 0) < args.minWalkForwardBeatCoinMean) alerts.push("walk_forward_beat_coin_mean_below_threshold");
  if ((abPolicy?.roi_on_staked ?? -1) <= args.minConfidenceABRoi) alerts.push("confidence_ab_roi_below_threshold");
  if ((abPolicy?.n_bets ?? 0) < args.minConfidenceABBets) alerts.push("confidence_ab_bets_below_threshold");

  const previous = findLatestGovernanceReport(args.outDir);
  let drift = null;
  if (previous && previous !== reportOut) {
    try {
      const prev = readJson(previous);
      const prevRoi = prev?.metrics?.walk_forward?.summary?.model_roi_mean;
      const currRoi = wf?.summary?.model_roi_mean;
      if (Number.isFinite(prevRoi) && Number.isFinite(currRoi)) {
        drift = {
          previous_report: previous,
          previous_roi_mean: prevRoi,
          current_roi_mean: currRoi,
          delta_roi_mean: currRoi - prevRoi
        };
        if ((currRoi - prevRoi) < -0.02) alerts.push("roi_mean_drift_down_gt_0.02");
      }
    } catch (_e) {
      drift = { previous_report: previous, note: "unable_to_parse_previous_report" };
    }
  }

  const report = {
    created_at: new Date().toISOString(),
    run_id: runId,
    status: alerts.length ? "attention" : "healthy",
    decision: alerts.length ? "hold_provisional_policy" : "keep_provisional_policy",
    thresholds: {
      min_walk_forward_roi_mean: args.minWalkForwardRoiMean,
      min_walk_forward_beat_coin_mean: args.minWalkForwardBeatCoinMean,
      min_confidence_ab_roi: args.minConfidenceABRoi,
      min_confidence_ab_bets: args.minConfidenceABBets
    },
    artifact_hashes: {
      input: { file: args.input, sha256: sha256File(args.input) },
      integrity_report: { file: integrityOut, sha256: sha256File(integrityOut) },
      walk_forward_report: { file: wfOut, sha256: sha256File(wfOut) },
      confidence_report: { file: confOut, sha256: sha256File(confOut) },
      monte_carlo_report: { file: mcOut, sha256: sha256File(mcOut) }
    },
    metrics: {
      integrity: {
        total_issue_count: integrity.total_issue_count,
        issue_counts: integrity.issue_counts
      },
      walk_forward: {
        summary: wf.summary
      },
      confidence_policy: {
        thresholds_active: conf?.config?.confidence
          ? {
              bucket_a_active: conf.config.confidence.bucket_a_active,
              bucket_b_active: conf.config.confidence.bucket_b_active
            }
          : null,
        a_b_policy: abPolicy
      },
      model_vs_coin_monte_carlo: mc.monte_carlo_summary
    },
    alerts,
    drift,
    artifacts: {
      integrity: integrityOut,
      walk_forward: wfOut,
      confidence: confOut,
      coin_mc: mcOut,
      governance: reportOut
    }
  };

  fs.writeFileSync(reportOut, JSON.stringify(report, null, 2), "utf8");

  console.log("V4 Governance Pipeline Complete");
  console.log("-------------------------------");
  console.log(`Run ID: ${runId}`);
  console.log(`Status: ${report.status}`);
  console.log(`Decision: ${report.decision}`);
  console.log(`Alerts: ${alerts.length ? alerts.join(", ") : "none"}`);
  console.log(`Report: ${reportOut}`);
}

main();
