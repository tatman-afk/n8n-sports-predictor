# n8n Sports Predictor

This repo now includes:
1. Your n8n workflow (`workflows/sports-betting-agent.json`)
2. A lightweight web dashboard to view predictions that auto-refresh every minute
3. Supabase-backed storage for latest prediction runs

## What the web app does

- Stores prediction payloads in Supabase and returns latest + history
- Exposes API endpoints for ingest + read:
  - `POST /api/predictions` (from n8n)
  - `GET /api/predictions` (for dashboard)
  - `POST /api/settle` (nightly result settlement)
- Displays:
  - Latest run
  - Structured picks (if provided)
  - Raw OpenAI output text (if provided)
  - Recent run history

## Project structure

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
└── package.json
```

## Local setup

1. Create a Supabase project.
2. In Supabase SQL editor, run `/Users/shanetatman/Documents/n8n-sports-predictor/supabase/schema.sql`.
3. Copy your project URL and service role key from Supabase settings.

```bash
npm install
cp .env.example .env
# edit .env with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
npm run dev
```

Server starts at `http://localhost:3000` by default.

## Connect n8n to the dashboard

Add a new **HTTP Request** node after your OpenAI node in n8n.

- Method: `POST`
- URL: `http://YOUR_SERVER:3000/api/predictions`
- Headers:
  - `Content-Type: application/json`
  - `x-ingest-key: {{$env.INGEST_KEY}}` (only if you set `INGEST_KEY`)
- Body (JSON):

```json
{
  "title": "Daily Sports Predictions",
  "league": "NBA + MLB",
  "aiSummary": "Top confidence picks based on current lines and implied win rates.",
  "rawMessage": "={{$node[\"Ods Assistant\"].json.message.content}}",
  "games": [
    {
      "matchup": "Lakers @ Celtics",
      "pick": "Celtics ML",
      "odds": "-145",
      "confidence": "72%",
      "reason": "Higher implied probability and stronger current form."
    }
  ]
}
```

If you only have the OpenAI text right now, send just `rawMessage` and add structured `games` later.

If you import the updated workflow JSON in this repo, it already includes a node named `POST Dashboard Prediction` that uses:

- `{{$env.DASHBOARD_API_URL}}` (fallback: `http://localhost:3000/api/predictions`)
- `{{$env.INGEST_KEY}}` (if configured)

## API contract

### `POST /api/predictions`

Accepts:

- `title` (string, optional)
- `league` (string, optional)
- `aiSummary` (string, optional)
- `rawMessage` (string, optional)
- `games` (array, optional if `rawMessage` is provided)

At least one of `rawMessage` or non-empty `games` is required.

### `GET /api/predictions`

Returns:

```json
{
  "latest": {},
  "history": [],
  "updatedAt": "2026-02-17T00:00:00.000Z"
}
```

### `POST /api/settle`

Automatically settles recent picks/parlays by matching them against completed ESPN scoreboard results.

Request body (optional):

```json
{
  "daysBack": 4
}
```

Response:

```json
{
  "ok": true,
  "scannedPredictions": 30,
  "updatedPredictions": 8,
  "settledItems": 41,
  "fetchedGames": 57
}
```

## Automatic nightly settlement in n8n

Add a second daily node (or a separate workflow) to run after games end:

- Method: `POST`
- URL: `http://localhost:3000/api/settle` (or your deployed API URL)
- Headers:
  - `Content-Type: application/json`
  - `x-ingest-key: <your INGEST_KEY>` (if enabled)
- Body:

```json
{
  "daysBack": 4
}
```

This writes `Result: Win` / `Result: Loss` into saved picks, which powers section win/loss percentages in the dashboard.

## Required environment variables

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional:

- `PORT`
- `INGEST_KEY`
