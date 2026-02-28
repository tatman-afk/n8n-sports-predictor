# n8n Sports Predictor

Sports prediction pipeline using n8n + OpenAI + odds/score feeds, with a live dashboard and Supabase-backed history.

## Scope Of Recent Changes (V4)

Recent repository work has focused on historical-data modeling and offline evaluation tooling.

- No production web API route contract changes were introduced for:
  - Supabase persistence flow
  - n8n ingestion contract
  - OpenAI call path used by the web service
- Added/updated mainly: model/backtest/governance scripts and reporting artifacts under `scripts/` and `data/reports/`.

## Critical Backup Precaution

DO NOT DELETE backup artifacts in `data/backups/` unless they are archived and verified elsewhere.

- Keep both `.dump` and `.sql` files for restore flexibility.
- Keep `*_globals.sql` alongside each backup set.
- Run `npm run db:backup` before schema or data-migration operations.
- See `data/backups/README.md` for backup handling policy.

## Live Dashboard

- Production: [https://sports-predictor-ai.onrender.com/](https://sports-predictor-ai.onrender.com/)

## What This Repo Includes

- n8n workflow export: `workflows/sports-betting-agent.json`
- Express API + dashboard UI
- Supabase schema and persistence
- Auto-settlement endpoint (`/api/settle`) for win/loss tagging

## Project Structure

```text
.
├── public/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── supabase/
│   └── schema.sql
├── workflows/
│   └── sports-betting-agent.json
├── server.js
├── package.json
└── .env.example
```

## Quick Start (Local)

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the Supabase SQL editor.
3. Create local env file and run app:

```bash
npm install
cp .env.example .env
npm run dev
```

Local app URL: `http://localhost:3000`

Local dev mode tip: set `DEV=true` with `DATABASE_URL` to run directly against local Postgres.

## Environment Variables

Required (choose one mode):

- Supabase mode:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
- Local PostgreSQL mode:
  - `DEV=true`
  - `DATABASE_URL` (for local `psql`/Postgres)

Optional:

- `DEV` (`true` uses local dev Supabase env defaults)
- `PORT`
- `INGEST_KEY`
- `LOCAL_PG_AUTO_INIT` (`true` runs `supabase/schema.sql` at startup in local Postgres mode)
- `DEV_SUPABASE_URL` (default `http://127.0.0.1:54321` when `DEV=true`)
- `DEV_SUPABASE_SERVICE_ROLE_KEY` (used first when `DEV=true`, then falls back to `SUPABASE_SERVICE_ROLE_KEY`)

## API Endpoints

### `POST /api/predictions`

Ingests a prediction run from n8n.

Body fields:

- `title` (optional)
- `league` (optional)
- `aiSummary` (optional)
- `rawMessage` (optional if `games` exists)
- `games` (optional if `rawMessage` exists)
- `sourceRunId` (optional)
- `modelVersion` (optional, defaults to `unknown` for structured writes)
- `generatedAt` (optional ISO timestamp for structured writes)
- `legs` (optional array for structured model output)

At least one of the following is required:

- legacy payload: non-empty `games` or `rawMessage`
- structured payload: non-empty `legs`

`legs` item fields:

- `legType` (`team_ml`, `team_spread`, `team_total`, `player_prop`, `other`)
- `marketType` (string, required)
- `pickDirection` (`over`, `under`, `home`, `away`, `yes`, `no`, `moneyline`, `other`)
- `probability` (number between `0` and `1`, required)
- `edge` (number between `-1` and `1`, optional, default `0`)
- `confidence` (number between `0` and `1`, optional)
- `oddsAmerican` (integer between `-2000` and `2000`, not `0`, optional)
- `eventId`, `teamId`, `playerId`, `lineValue`, `result` (optional)

### `GET /api/predictions`

Returns latest run, recent history, and timestamp used by the dashboard.

### `POST /api/settle`

Settles saved picks/parlays by matching them against completed ESPN games and appending:

- `Result: Win`
- `Result: Loss`
- `Result: Pending`

Example body:

```json
{
  "daysBack": 31
}
```

## n8n Integration

### Prediction node

- Method: `POST`
- URL: `https://sports-predictor-ai.onrender.com/api/predictions`
- Headers:
  - `Content-Type: application/json`
  - `x-ingest-key: <your INGEST_KEY>` (if enabled)

### Nightly settle node

- Method: `POST`
- URL: `https://sports-predictor-ai.onrender.com/api/settle`
- Headers:
  - `Content-Type: application/json`
  - `x-ingest-key: <your INGEST_KEY>` (if enabled)
- Body:

```json
{
  "daysBack": 31
}
```

## Deployment

Hosted on Render as a Web Service:

- Build command: `npm install`
- Start command: `npm start`
- Runtime: Node

## NBA Historical Ingest (Local PostgreSQL)

The repo includes a first ingest adapter framework for NBA historical events using ESPN scoreboard data.

### Run backfill

Requires `DATABASE_URL` in your `.env`.

```bash
# Defaults to last 30 days
npm run ingest:nba:backfill

# Custom date range (UTC dates)
npm run ingest:nba:backfill -- --start 2024-10-01 --end 2025-06-30
```

### Run QA summary

```bash
npm run ingest:nba:qa
```

This prints:
- NBA team/event coverage
- completed-vs-outcome coverage
- ingest run health
- a sample of recent events

### Run NBA odds snapshot

Add `ODDS_API_KEY` to `.env` and run:

```bash
npm run ingest:nba:odds-snapshot
```

This writes team moneyline snapshots into `market_lines` (`market_type = h2h_moneyline`) and links them to canonical NBA events when team/date matching succeeds.

Deduping: set `ODDS_DEDUPE_WINDOW_MINUTES` (default `5`) to treat near-time-identical snapshots as idempotent inserts.

### Run NBA historical odds backfill

Requires `ODDS_API_KEY` with historical endpoint access.

```bash
# Last 30 days by default
npm run ingest:nba:odds-backfill

# Larger date range (optional sleep for rate limits)
npm run ingest:nba:odds-backfill -- --start 2024-10-01 --end 2025-06-30 --sleep-ms 250
```

## NBA Training Dataset Export

Exports a model-ready CSV by joining:
- completed `events`
- closest pre-game `market_lines` (team h2h moneyline, one row per event/sportsbook/team)
- `outcomes` labels (`team_win` = 1/0)

```bash
# Default last 365 days -> data/nba_training_dataset.csv
npm run dataset:nba:export

# Custom range and file path
npm run dataset:nba:export -- --start 2024-10-01 --end 2025-06-30 --out data/nba_2024_2025.csv
```

Default split is chronological `80/20` (train/test). Override with:
- `--val-ratio <n>` and `--test-ratio <n>` (ratio mode)
- or `--validation-start YYYY-MM-DD --test-start YYYY-MM-DD` (cutoff-date mode)

## Baseline ML Evaluation

Evaluate baseline models on exported dataset:
- market implied probability (raw)
- constant-rate baseline
- Platt-scaled calibration over implied probability

```bash
npm run ml:nba:baseline
```

Output metrics JSON:
- `data/nba_baseline_metrics.json`

## Progress Status

Current ingestion/modeling status is tracked in:
- `docs-current-status.md`

## Sprint 1 Data-Scale Ops

### Batch import OddsHarvester season files

```bash
npm run ingest:nba:oddsharvester-batch
```

Writes per-file summary report to `data/reports/oddsharvester_import_summary_*.json`.

### Coverage diagnostics (exclusion reasons)

```bash
npm run ingest:nba:diagnose
```

Includes:
- `no_odds_completed_events`
- `postgame_odds_rows`
- `skipped_invalid_odds`
- `skipped_unresolved_team`
- `event_mismatch_proxy_created_events`

### Usable-row data gate

```bash
npm run ingest:nba:gate
```

Fails with non-zero exit code if usable rows are below `2500`.
