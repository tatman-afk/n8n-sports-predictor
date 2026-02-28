#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    governanceDir: "data/reports/governance_v4",
    out: "data/reports/v4_provisional_policy_state.json",
    policy: "A_B",
    validDays: 30
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--governance-dir") args.governanceDir = argv[i + 1] || args.governanceDir;
    if (t === "--out") args.out = argv[i + 1] || args.out;
    if (t === "--policy") args.policy = argv[i + 1] || args.policy;
    if (t === "--valid-days") args.validDays = Number(argv[i + 1]) || args.validDays;
  }
  return args;
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const reportPath = latestGovernanceReport(args.governanceDir);
  if (!reportPath) throw new Error(`No governance report found in ${args.governanceDir}`);
  const gov = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (gov.status !== "healthy") {
    throw new Error(`Cannot publish policy from non-healthy governance status: ${gov.status}`);
  }

  const confPath = gov?.artifacts?.confidence;
  if (!confPath || !fs.existsSync(confPath)) throw new Error("Confidence artifact missing from governance report.");
  const conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
  const thresholds = conf?.config?.confidence;
  if (!thresholds) throw new Error("Missing confidence thresholds in confidence artifact.");
  const policy = (conf.policy_results || []).find((p) => p.policy === args.policy);
  if (!policy) throw new Error(`Policy ${args.policy} not found in confidence report.`);

  const now = new Date();
  const validUntil = new Date(now.getTime() + args.validDays * 24 * 60 * 60 * 1000);
  const state = {
    created_at: now.toISOString(),
    valid_until: validUntil.toISOString(),
    status: "provisional_active",
    governance_report: reportPath,
    source_artifacts: gov.artifacts,
    model_policy: {
      policy: args.policy,
      threshold_mode: thresholds.threshold_mode,
      bucket_a_active: thresholds.bucket_a_active,
      bucket_b_active: thresholds.bucket_b_active,
      performance_snapshot: policy
    },
    controls: {
      revalidate_before_use_if_after_valid_until: true,
      require_healthy_governance: true
    }
  };

  ensureDirForFile(args.out);
  fs.writeFileSync(args.out, JSON.stringify(state, null, 2), "utf8");

  console.log("V4 Provisional Policy Published");
  console.log("-------------------------------");
  console.log(`Policy: ${args.policy}`);
  console.log(`Thresholds: A>=${state.model_policy.bucket_a_active} B>=${state.model_policy.bucket_b_active}`);
  console.log(`Valid until: ${state.valid_until}`);
  console.log(`Output: ${args.out}`);
}

main();
