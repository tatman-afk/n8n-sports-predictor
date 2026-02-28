# V4 Migration Pipeline (NBA Prediction Engine)

## Objective
Move from proxy-heavy feature experiments (v2/v3) to a high-trust, statistically grounded v4 pipeline that can beat market baseline under existing gate rules.

## Current State
- Data foundation is strong and backed up (`sports_predictor` + validated restore).
- Baseline (`market_implied + platt`) is stable and gate-pass.
- v2 improved directionally but failed CI gate.
- v3 degraded materially and failed gate.

Decision: keep baseline as production candidate while v4 is developed offline.

## V4 Design Principles
1. Prioritize low-leakage, high-signal features derived from source-of-truth outcomes and pregame lines.
2. Prefer opponent-relative features over raw absolute features.
3. Avoid synthetic proxies unless empirically justified.
4. Gate every candidate against market baseline with CI support.
5. Keep model complexity minimal until it demonstrates stable edge.

## V4 Implementation Pipeline

### Phase 0: Freeze + Repro Baseline
- Pin baseline artifact and config used for current gate-pass.
- Save baseline report snapshot under `data/reports/baseline_v4_anchor_*.json`.
- Confirm backup checkpoint exists before v4 DB/model changes.

Deliverable:
- Immutable baseline anchor + reproducibility note.

### Phase 1: Build V4 Feature Dataset (Trusted Inputs Only)
Create `scripts/build_nba_event_features_v4.js` using only these categories:

1. Team form features (from completed outcomes only, prior games only)
- rolling net rating diff (last 5, 10)
- rolling win-rate diff (last 5, 10)
- rolling offensive/defensive points-for/against diff

2. Scheduling features
- rest days (team, opponent, and differential)
- back-to-back flags (team/opponent)
- home/away flag + home-away interaction with implied edge

3. Market structure features (pregame only)
- implied probability (team, opponent, difference)
- line dispersion statistics across books
- consensus disagreement signal (stddev/iqr)

4. Data quality flags
- missingness flags per feature group
- book count thresholds and low-liquidity indicators

Hard constraints:
- No postgame or post-start signals.
- Strict chronological feature computation per team/event.

Deliverables:
- `data/nba_event_training_features_v4.csv`
- feature dictionary markdown (`v4 ideas/feature_contract_v4.md`)

### Phase 2: Modeling Track (Simple -> Strong)
Add `scripts/ml_event_feature_model_v4.js` with three tracks:

Track A (anchor):
- logistic regression on implied + opponent-relative form/schedule features

Track B (regularized):
- logistic regression with stronger L2 and feature sparsity selection

Track C (optional only if A/B close to pass):
- tree-based shallow model (calibrated) for non-linear effects

All tracks must emit report schema compatible with `ml_acceptance_gate.js`:
- `event_level.metrics.test.platt_scaled`
- `event_level.bootstrap_ci_test.platt_vs_market`

Deliverables:
- model script + per-run metrics artifacts

### Phase 3: Controlled Sweep + Selection
Add `scripts/run_feature_model_sweep_v4.js`:
- Max 3-5 configs (not broad brute force)
- Priority on:
  - feature subset quality
  - regularization stability
  - CI robustness, not single-point best

Ranking criteria:
1. Gate pass/fail
2. logloss delta vs market (event-level)
3. CI upper bound and p_model_better
4. rolling-window stability std

Deliverable:
- `data/sweeps_v4/nba_feature_model_sweep_v4_report.json`

### Phase 4: Gate + Promotion Rules
Use existing gate script with strict thresholds:
- logloss CI upper < 0
- brier support: CI upper <= 0.0001 OR p_model_better >= 0.97
- must outperform market on point metrics too

Promotion policy:
- Require 2 consecutive reruns with pass under fixed data snapshot.
- If unstable, remain on baseline and iterate features.

Deliverable:
- promotion decision note (`v4 ideas/promotion_decision_v4.md`)

## Data/Model Migration Checklist
1. Backup current DB (`npm run db:backup`).
   - Critical: do not delete generated backup files (`data/backups/*.dump`, `data/backups/*.sql`, `data/backups/*_globals.sql`) until verified archive retention is complete.
2. Export event dataset (`dataset:nba:export:event`).
3. Build v4 features.
4. Train/evaluate v4 model.
5. Run gate.
6. Compare against baseline anchor.
7. Promote only if gate and stability criteria pass.

## Suggested Command Flow (Target)
```bash
npm run db:backup
npm run dataset:nba:export:event
node scripts/build_nba_event_features_v4.js --input data/nba_event_training_dataset.csv --out data/nba_event_training_features_v4.csv
node scripts/ml_event_feature_model_v4.js --input data/nba_event_training_features_v4.csv --out data/nba_feature_model_v4_metrics.json --bootstrap-samples 1000 --rolling-windows 8
node scripts/ml_acceptance_gate.js --input data/nba_feature_model_v4_metrics.json --logloss-ci-upper-max 0 --brier-ci-upper-max 0.0001 --brier-p-better-min 0.97
node scripts/run_feature_model_sweep_v4.js
```

## Risks and Mitigations
- Risk: hidden leakage in rolling features.
  - Mitigation: explicit prior-game indexing tests and spot checks per event.

- Risk: overfitting via too many engineered interactions.
  - Mitigation: start minimal, add features incrementally, monitor CI and rolling std.

- Risk: gate instability between runs.
  - Mitigation: fix seed/config/data snapshot; require consecutive pass policy.

## Exit Criteria for V4
- Event-level model beats market on out-of-sample logloss and brier.
- Gate passes with CI support on at least two reruns.
- Rolling-window deltas remain stable (low variance, positive share_better).
- Artifacts and commands are reproducible by a single operator.
