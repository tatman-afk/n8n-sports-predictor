const { spawnSync } = require("child_process");

function getCurrentSeasonStartYear() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  // NBA regular seasons begin in October, so Jan-Sep belong to the prior start year.
  return month >= 9 ? year : year - 1;
}

function runStep(label, command, args) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function main() {
  const seasonStartYear = Number(process.argv[2] || getCurrentSeasonStartYear());
  const seasonLabel = `${seasonStartYear}-${String(seasonStartYear + 1).slice(-2)}`;
  const datasetPath = `model/generated/nba_training_${seasonLabel}.csv`;
  const artifactPath = "model/nba-logistic-model.json";

  console.log(
    `Refreshing NBA model for ${seasonLabel} (season start year ${seasonStartYear}).`
  );

  runStep("Ingest Games", "node", ["scripts/ingestNbaGames.js", String(seasonStartYear)]);
  runStep("Build Schedule Features", "node", [
    "scripts/buildNbaFeatures.js",
    String(seasonStartYear)
  ]);
  runStep("Ingest Team Boxscores", "node", [
    "scripts/ingestNbaBoxscores.js",
    String(seasonStartYear)
  ]);
  runStep("Export Training Data", "node", [
    "scripts/exportNbaTrainingData.js",
    seasonLabel
  ]);
  runStep("Train Logistic Model", "python3", [
    "model/train_nba_model.py",
    datasetPath,
    artifactPath
  ]);
}

main();
