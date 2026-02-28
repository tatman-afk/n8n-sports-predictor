#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    provisionalState: "data/reports/v4_provisional_policy_state.json",
    governanceDir: "data/reports/governance_v4",
    out: "data/reports/v4_runtime_policy_state.json",
    fallbackPolicy: "A_only",
    minConfidenceABBets: 20
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--provisional-state") args.provisionalState = argv[i + 1] || args.provisionalState;
    if (t === "--governance-dir") args.governanceDir = argv[i + 1] || args.governanceDir;
    if (t === "--out") args.out = argv[i + 1] || args.out;
    if (t === "--fallback-policy") args.fallbackPolicy = argv[i + 1] || args.fallbackPolicy;
    if (t === "--min-conf-ab-bets") args.minConfidenceABBets = Number(argv[i + 1]) || args.minConfidenceABBets;
  }
  return args;
}

function latestGovernanceReport(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f.startsWith("v4_governance_"))
    .filter((f) => !f.includes("_integrity") && !f.includes("_walk_forward") && !f.includes("_confidence") && !f.includes("_coin_mc"))
    .sort();
  if (!files.length) return null;
  return path.join(dir, files[files.length - 1]);
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.provisionalState)) throw new Error(`Missing provisional state: ${args.provisionalState}`);
  const provisional = JSON.parse(fs.readFileSync(args.provisionalState, "utf8"));
  const govPath = latestGovernanceReport(args.governanceDir);
  if (!govPath) throw new Error(`No governance report found in ${args.governanceDir}`);
  const gov = JSON.parse(fs.readFileSync(govPath, "utf8"));

  const now = new Date();
  const validUntil = new Date(provisional.valid_until);
  const expired = Number.isFinite(validUntil.getTime()) ? now > validUntil : true;
  const unhealthy = gov.status !== "healthy";
  const alerts = Array.isArray(gov.alerts) ? gov.alerts : [];

  const abBets = gov?.metrics?.confidence_policy?.a_b_policy?.n_bets ?? 0;
  const lowSample = abBets < args.minConfidenceABBets;

  let action = "keep";
  let activePolicy = provisional?.model_policy?.policy || "A_B";
  const reasons = [];
  if (expired) {
    action = "no_bet";
    activePolicy = "NO_BET";
    reasons.push("provisional_policy_expired");
  }
  if (unhealthy) {
    action = "fallback";
    activePolicy = args.fallbackPolicy;
    reasons.push("governance_not_healthy");
  }
  if (alerts.length) {
    action = "fallback";
    activePolicy = args.fallbackPolicy;
    reasons.push(`governance_alerts:${alerts.join("|")}`);
  }
  if (lowSample) {
    action = "fallback";
    activePolicy = args.fallbackPolicy;
    reasons.push(`ab_bets_below_min:${abBets}<${args.minConfidenceABBets}`);
  }

  const runtime = {
    created_at: now.toISOString(),
    action,
    active_policy: activePolicy,
    reasons,
    source: {
      provisional_state: args.provisionalState,
      governance_report: govPath
    },
    thresholds: provisional?.model_policy
      ? {
          bucket_a_active: provisional.model_policy.bucket_a_active,
          bucket_b_active: provisional.model_policy.bucket_b_active
        }
      : null
  };

  ensureDirForFile(args.out);
  fs.writeFileSync(args.out, JSON.stringify(runtime, null, 2), "utf8");

  console.log("V4 Runtime Policy Enforcement");
  console.log("-----------------------------");
  console.log(`Action: ${action}`);
  console.log(`Active policy: ${activePolicy}`);
  console.log(`Reasons: ${reasons.length ? reasons.join(", ") : "none"}`);
  console.log(`Output: ${args.out}`);
}

main();
