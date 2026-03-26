# n8n Sports Predictor

Sports prediction pipeline using n8n + OpenAI + odds/score feeds, with a live dashboard and Supabase-backed history.

## Live Dashboard

- Production: [https://sports-predictor-ai.onrender.com/](https://sports-predictor-ai.onrender.com/)

## What This Repo Includes

- n8n workflow export: `workflows/sports-betting-agent.json`
- Express API + dashboard UI
- Supabase schema and persistence
- NBA warehousing scripts for teams, arenas, games, and travel features
- Trained-model pipeline for NBA win probabilities
- Auto-settlement endpoint (`/api/settle`) for win/loss tagging

## Project Structure

```text
.
├── data/
│   ├── nba-teams.json
│   └── predictions.json
├── public/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── scripts/
│   ├── buildArenaDistances.js
│   ├── buildNbaFeatures.js
│   ├── exportNbaTrainingData.js
│   ├── ingestNbaBoxscores.js
│   ├── ingestNbaGames.js
│   ├── seedNbaMetadata.js
│   └── lib/
│       ├── env.js
│       ├── nbaModel.js
│       └── nba.js
├── model/
│   └── train_nba_model.py
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

### `POST /api/nba/pick-context`

Builds AI-ready NBA matchup context from your historical warehouse tables.

Body:

```json
{
  "games": [
    {
      "home_team": "Boston Celtics",
      "away_team": "Miami Heat",
      "commence_time": "2026-03-27T23:30:00Z",
      "bookmakers": []
    }
  ]
}
```

Response includes:

- `games`: structured matchup stats for each team
- `prompt`: a plain-text block ready to feed into the OpenAI node in n8n
- `modelAvailable`: whether a trained model artifact was loaded
- `unresolvedTeams`: any team names that could not be mapped

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

### NBA pick-context node

- Method: `POST`
- URL: `https://sports-predictor-ai.onrender.com/api/nba/pick-context`
- Headers:
  - `Content-Type: application/json`
  - `x-ingest-key: <your INGEST_KEY>` (if enabled)
- Body:

```json
{
  "games": {{ $json }}
}
```

Then use `{{$json.prompt}}` as the main evidence block in your OpenAI node instead of sending odds alone.

## NBA Model Training

After loading the warehouse tables, you can train a baseline logistic-regression model:

```bash
npm run boxscores:nba -- 2024
npm run export:nba-training -- 2024-25
npm run train:nba-model
```

This creates:

- `model/generated/nba_training_2024-25.csv`: supervised training rows
- `model/nba-logistic-model.json`: portable model artifact with scaler stats, coefficients, and metrics

The live `POST /api/nba/pick-context` endpoint will automatically include model probabilities if `model/nba-logistic-model.json` exists on the deployed server.
Commit and deploy `model/nba-logistic-model.json` if you want Render to serve trained-model probabilities.
The training export includes rolling offense, rolling defense allowed, and offense-vs-defense matchup edges for major team stats such as shooting, rebounds, assists, turnovers, steals, blocks, and fouls.

## Daily Model Refresh

You can refresh the current NBA season model end-to-end with:

```bash
npm run refresh:nba-model
```

This command:

- ingests the current season's games
- rebuilds travel/rest features
- ingests team boxscores
- exports a fresh training dataset
- retrains `model/nba-logistic-model.json`

The repo also includes a scheduled GitHub Actions workflow at `.github/workflows/daily-nba-model-refresh.yml`.
To enable it, add these GitHub repository secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The workflow runs daily, retrains the model, and commits the updated model artifact back to `main` when it changes.

## Deployment

Hosted on Render as a Web Service:

- Build command: `npm install`
- Start command: `npm start`
- Runtime: Node

## NBA Data Pipeline

Run these after applying `supabase/schema.sql` in Supabase:

```bash
npm run seed:nba
npm run distances:nba
npm run ingest:nba -- 2024
npm run features:nba -- 2024
npm run boxscores:nba -- 2024
```

What they do:

- `seed:nba`: inserts the 30 NBA teams and home arenas
- `distances:nba`: computes pairwise arena distances and estimated flight times
- `ingest:nba -- 2024`: pulls the 2024-25 season schedule/results from ESPN's NBA scoreboard feed
- `features:nba -- 2024`: derives rest, back-to-back, and travel features per team/game
- `boxscores:nba -- 2024`: pulls completed-game team box scores from ESPN summary pages

New warehouse tables:

- `teams`
- `arenas`
- `games`
- `team_boxscores`
- `arena_distances`
- `team_game_features`
