const express = require("express");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const INGEST_KEY = process.env.INGEST_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Update your .env file."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const ESPN_LEAGUES = [
  { sport: "basketball", league: "nba" },
  { sport: "baseball", league: "mlb" },
  { sport: "icehockey", league: "nhl" },
  { sport: "football", league: "nfl" }
];

function mapRow(row) {
  return {
    id: row.id,
    title: row.title,
    league: row.league,
    games: Array.isArray(row.games) ? row.games : [],
    aiSummary: row.ai_summary || "",
    rawMessage: row.raw_message || "",
    createdAt: row.created_at
  };
}

function normalizeTeamName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(the|fc|cf|sc)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function teamMatch(candidate, aliases) {
  const normalized = normalizeTeamName(candidate);
  if (!normalized) return false;
  if (aliases.has(normalized)) return true;
  for (const alias of aliases) {
    if (alias.length >= 5 && normalized.includes(alias)) return true;
    if (normalized.length >= 5 && alias.includes(normalized)) return true;
  }
  return false;
}

function toDateKey(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function dateRangeKeys(startDate, endDate) {
  const keys = [];
  const current = new Date(
    Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate())
  );
  const end = new Date(
    Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate())
  );

  while (current <= end) {
    keys.push(toDateKey(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return keys;
}

function buildAliases(competitor) {
  const aliases = new Set();
  const team = competitor?.team || {};
  const values = [
    competitor?.displayName,
    competitor?.shortDisplayName,
    team?.displayName,
    team?.shortDisplayName,
    team?.name,
    team?.abbreviation
  ];

  for (const value of values) {
    const normalized = normalizeTeamName(value);
    if (normalized) aliases.add(normalized);
  }

  return aliases;
}

async function fetchCompletedGames(startDate, endDate) {
  const dates = dateRangeKeys(startDate, endDate);
  const games = [];

  for (const { sport, league } of ESPN_LEAGUES) {
    for (const dateKey of dates) {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard?dates=${dateKey}`;

      try {
        const response = await fetch(url);
        if (!response.ok) continue;
        const payload = await response.json();

        for (const event of payload?.events || []) {
          const competition = event?.competitions?.[0];
          const competitors = competition?.competitors || [];
          if (competitors.length !== 2) continue;
          if (!competition?.status?.type?.completed) continue;

          const a = competitors[0];
          const b = competitors[1];
          const aAliases = buildAliases(a);
          const bAliases = buildAliases(b);

          let winner = null;
          if (a?.winner === true) winner = "a";
          if (b?.winner === true) winner = "b";
          if (!winner) continue;

          games.push({
            date: new Date(event?.date || competition?.date || Date.now()),
            aAliases,
            bAliases,
            winner,
            loser: winner === "a" ? "b" : "a"
          });
        }
      } catch (_err) {
        // Ignore a failed league/date pull and continue with others.
      }
    }
  }

  return games;
}

function findGameForMatchup(games, pickTeam, opponentTeam) {
  for (const game of games) {
    const pickIsA = teamMatch(pickTeam, game.aAliases);
    const pickIsB = teamMatch(pickTeam, game.bAliases);
    const oppIsA = teamMatch(opponentTeam, game.aAliases);
    const oppIsB = teamMatch(opponentTeam, game.bAliases);

    if ((pickIsA && oppIsB) || (pickIsB && oppIsA)) {
      return {
        outcome: pickIsA ? (game.winner === "a" ? "win" : "loss") : game.winner === "b" ? "win" : "loss"
      };
    }
  }
  return null;
}

function findTeamOutcome(games, teamName) {
  for (const game of games) {
    if (teamMatch(teamName, game.aAliases)) {
      return game.winner === "a" ? "win" : "loss";
    }
    if (teamMatch(teamName, game.bAliases)) {
      return game.winner === "b" ? "win" : "loss";
    }
  }
  return null;
}

function upsertResult(line, outcome) {
  const label = outcome === "win" ? "Win" : outcome === "loss" ? "Loss" : "Pending";
  if (/\|\s*Result:\s*(Win|Loss|Pending)/i.test(line)) {
    return line.replace(/\|\s*Result:\s*(Win|Loss|Pending)/i, `| Result: ${label}`);
  }
  return `${line} | Result: ${label}`;
}

function settlePredictionMessage(rawMessage, createdAt, allGames) {
  if (!rawMessage || typeof rawMessage !== "string") {
    return { message: rawMessage || "", changed: false, settledItems: 0 };
  }

  const predictionDate = new Date(createdAt || Date.now());
  const windowStart = new Date(predictionDate);
  windowStart.setUTCDate(windowStart.getUTCDate() - 1);
  const windowEnd = new Date(predictionDate);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + 2);

  const gamesWindow = allGames
    .filter((g) => g.date >= windowStart && g.date <= windowEnd)
    .sort((a, b) => a.date - b.date);

  const lines = rawMessage.split("\n");
  let currentSection = "";
  let changed = false;
  let settledItems = 0;

  const updatedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    const headerMatch = trimmed.match(
      /^(Safe Bets|Best Value Bets|Long Shots|2-Leg Parlays|3-Leg Parlays)\b/i
    );
    if (headerMatch) {
      currentSection = headerMatch[1].toLowerCase();
      return line;
    }

    if (!currentSection) return line;

    const cleaned = trimmed.replace(/^\d+\)\s*/, "").replace(/^-\s*/, "");
    let outcome = null;

    if (currentSection.includes("parlays")) {
      const mainPart = cleaned.split("|")[0];
      const teams = [...mainPart.matchAll(/([^+|]+?)\s+MoneyLine/gi)]
        .map((m) => m[1].trim())
        .filter(Boolean);

      if (teams.length > 0) {
        const outcomes = teams.map((team) => findTeamOutcome(gamesWindow, team));
        if (outcomes.some((r) => r === "loss")) outcome = "loss";
        else if (outcomes.every((r) => r === "win")) outcome = "win";
        else if (outcomes.some(Boolean)) outcome = "pending";
      }
    } else {
      const pickMatch = cleaned.match(/(.+?)\s+MoneyLine\s+vs\s+(.+?)(?:\s*\||$)/i);
      if (pickMatch) {
        const pickTeam = pickMatch[1].trim();
        const opponentTeam = pickMatch[2].trim();
        const match = findGameForMatchup(gamesWindow, pickTeam, opponentTeam);
        outcome = match?.outcome || null;
      }
    }

    if (!outcome) return line;
    const updatedLine = upsertResult(line, outcome);
    if (updatedLine !== line) changed = true;
    if (outcome === "win" || outcome === "loss") settledItems += 1;
    return updatedLine;
  });

  return {
    message: updatedLines.join("\n"),
    changed,
    settledItems
  };
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/predictions", async (_req, res) => {
  const { data, error } = await supabase
    .from("predictions")
    .select("id,title,league,games,ai_summary,raw_message,created_at")
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) {
    return res.status(500).json({ error: "Failed to fetch predictions." });
  }

  const rows = (data || []).map(mapRow);
  const latest = rows[0] || null;

  res.json({
    latest,
    history: rows,
    updatedAt: latest ? latest.createdAt : null
  });
});

app.post("/api/predictions", async (req, res) => {
  if (INGEST_KEY) {
    const key = req.header("x-ingest-key");
    if (key !== INGEST_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const { title, league, games, aiSummary, rawMessage } = req.body || {};

  if ((!Array.isArray(games) || games.length === 0) && !rawMessage) {
    return res.status(400).json({
      error: "Provide either a non-empty games array or rawMessage text."
    });
  }

  const insertPayload = {
    title: title || "Daily Sports Predictions",
    league: league || "Mixed",
    games: Array.isArray(games) ? games : [],
    ai_summary: aiSummary || "",
    raw_message: rawMessage || ""
  };

  const { data, error } = await supabase
    .from("predictions")
    .insert(insertPayload)
    .select("id,title,league,games,ai_summary,raw_message,created_at")
    .single();

  if (error) {
    return res.status(500).json({ error: "Failed to save prediction." });
  }

  res.status(201).json({ ok: true, entry: mapRow(data) });
});

app.post("/api/settle", async (req, res) => {
  if (INGEST_KEY) {
    const key = req.header("x-ingest-key");
    if (key !== INGEST_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const daysBack = Number(req.body?.daysBack || 4);
  const startDate = new Date();
  startDate.setUTCDate(startDate.getUTCDate() - daysBack);
  const endDate = new Date();

  const { data: rows, error } = await supabase
    .from("predictions")
    .select("id,raw_message,created_at")
    .gte("created_at", startDate.toISOString())
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    return res.status(500).json({ error: "Failed to load predictions for settlement." });
  }

  const completedGames = await fetchCompletedGames(startDate, endDate);
  let updatedCount = 0;
  let settledItemCount = 0;

  for (const row of rows || []) {
    const result = settlePredictionMessage(row.raw_message, row.created_at, completedGames);
    if (!result.changed) continue;

    const { error: updateError } = await supabase
      .from("predictions")
      .update({ raw_message: result.message })
      .eq("id", row.id);

    if (!updateError) {
      updatedCount += 1;
      settledItemCount += result.settledItems;
    }
  }

  res.json({
    ok: true,
    scannedPredictions: (rows || []).length,
    updatedPredictions: updatedCount,
    settledItems: settledItemCount,
    fetchedGames: completedGames.length
  });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Sports dashboard running on http://localhost:${PORT}`);
});
