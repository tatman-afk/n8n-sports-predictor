# V4 Promotion Decision

## Decision
Promote **V4 Track A Anchor** as the current promotion candidate.

Status: **APPROVED (criteria satisfied)**
Date: **2026-02-25**

## Fixed Snapshot
- Snapshot file: `data/snapshots/nba_event_training_features_v4_20260225_102301.csv`
- SHA256: `c12a2e2270feca7df9618a6a4659344ea27f703e579cf4b5f075b74600948888`
- Hash source: `data/reports/v4_reruns/snapshot.sha256.txt`

## Locked Model Config
- Script: `scripts/ml_event_feature_model_v4.js`
- Track: `track_a_anchor` (`--track a`)
- Features: `implied_logit`
- Hyperparameters:
  - `iters=12000`
  - `lr=0.0025`
  - `l2=0.01`
- Evaluation settings:
  - `bootstrap-samples=1000`
  - `rolling-windows=8`

## Consecutive Rerun Evidence (Same Snapshot, Same Config)

### Run 1
- Artifact: `data/reports/v4_reruns/v4_top_run1.json`
- Gate decision: **PASS**
- Event-level point metrics:
  - Model logloss: `0.5976961931812865`
  - Market logloss: `0.6004156932145581`
  - Model brier: `0.2068024531389983`
  - Market brier: `0.20775155324662092`
- CI support (`platt_vs_market`):
  - Logloss `ci_95_high`: `-0.0014183939598793132`
  - Brier `ci_95_high`: `-0.0004938355596474515`
  - Brier `p_model_better`: `1.0`

### Run 2
- Artifact: `data/reports/v4_reruns/v4_top_run2.json`
- Gate decision: **PASS**
- Event-level point metrics:
  - Model logloss: `0.5976961931812865`
  - Market logloss: `0.6004156932145581`
  - Model brier: `0.2068024531389983`
  - Market brier: `0.20775155324662092`
- CI support (`platt_vs_market`):
  - Logloss `ci_95_high`: `-0.0015402336252921317`
  - Brier `ci_95_high`: `-0.0004871583549850443`
  - Brier `p_model_better`: `1.0`

## Promotion Policy Check
Required policy: 2 consecutive reruns with pass under fixed data snapshot.

- Same snapshot hash across runs: **PASS**
- Same fixed model config across runs: **PASS**
- Gate pass on run 1: **PASS**
- Gate pass on run 2: **PASS**

Final policy outcome: **PASS**

## Artifact Index
- `data/snapshots/nba_event_training_features_v4_20260225_102301.csv`
- `data/reports/v4_reruns/snapshot.sha256.txt`
- `data/reports/v4_reruns/v4_top_run1.json`
- `data/reports/v4_reruns/v4_top_run2.json`
- `data/sweeps_v4/nba_feature_model_sweep_v4_report.json`
