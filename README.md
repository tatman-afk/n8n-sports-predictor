# n8n Sports Predictor

Sports prediction pipeline using n8n + OpenAI + odds/score feeds, with a live dashboard and Supabase-backed history.

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

## Environment Variables

Required:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional:

- `PORT`
- `INGEST_KEY`

## API Endpoints

### `POST /api/predictions`

Ingests a prediction run from n8n.

Body fields:

- `title` (optional)
- `league` (optional)
- `aiSummary` (optional)
- `rawMessage` (optional if `games` exists)
- `games` (optional if `rawMessage` exists)

At least one of `rawMessage` or non-empty `games` is required.

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
