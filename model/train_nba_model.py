from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import joblib  # noqa: F401  # Ensures dependency is available for local experimentation.
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, log_loss, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATASET = ROOT / "model" / "generated" / "nba_training_2024-25.csv"
DEFAULT_ARTIFACT = ROOT / "model" / "nba-logistic-model.json"
META_COLUMNS = {
    "game_id",
    "game_datetime_utc",
    "season",
    "team_id",
    "opponent_team_id",
    "won_game",
}


def safe_metric(fn, *args):
    try:
        return float(fn(*args))
    except Exception:
        return None


def main() -> None:
    dataset_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DATASET
    artifact_path = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_ARTIFACT

    if not dataset_path.exists():
        raise SystemExit(f"Dataset not found: {dataset_path}")

    df = pd.read_csv(dataset_path)
    if df.empty:
        raise SystemExit("Training dataset is empty.")

    df = df.sort_values("game_datetime_utc").reset_index(drop=True)
    feature_columns = [column for column in df.columns if column not in META_COLUMNS]
    X = df[feature_columns]
    y = df["won_game"]

    split_index = max(int(len(df) * 0.8), 1)
    if split_index >= len(df):
        split_index = len(df) - 1

    X_train = X.iloc[:split_index]
    y_train = y.iloc[:split_index]
    X_test = X.iloc[split_index:]
    y_test = y.iloc[split_index:]

    pipeline = Pipeline(
        steps=[
            ("scaler", StandardScaler()),
            ("model", LogisticRegression(max_iter=2000, random_state=42)),
        ]
    )
    pipeline.fit(X_train, y_train)

    train_probs = pipeline.predict_proba(X_train)[:, 1]
    test_probs = pipeline.predict_proba(X_test)[:, 1] if len(X_test) else train_probs
    train_preds = (train_probs >= 0.5).astype(int)
    test_preds = (test_probs >= 0.5).astype(int)

    scaler: StandardScaler = pipeline.named_steps["scaler"]
    model: LogisticRegression = pipeline.named_steps["model"]

    artifact = {
        "model_type": "logistic_regression",
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "source_dataset": str(dataset_path),
        "feature_columns": feature_columns,
        "means": scaler.mean_.tolist(),
        "scales": scaler.scale_.tolist(),
        "coefficients": model.coef_[0].tolist(),
        "intercept": float(model.intercept_[0]),
        "train_rows": int(len(X_train)),
        "test_rows": int(len(X_test)),
        "metrics": {
            "train_accuracy": float(accuracy_score(y_train, train_preds)),
            "test_accuracy": float(accuracy_score(y_test, test_preds)) if len(X_test) else None,
            "train_log_loss": float(log_loss(y_train, train_probs)),
            "test_log_loss": float(log_loss(y_test, test_probs)) if len(X_test) else None,
            "train_roc_auc": safe_metric(roc_auc_score, y_train, train_probs),
            "test_roc_auc": safe_metric(roc_auc_score, y_test, test_probs) if len(X_test) else None,
        },
    }

    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    artifact_path.write_text(json.dumps(artifact, indent=2), encoding="utf-8")

    print(json.dumps(artifact["metrics"], indent=2))
    print(f"Wrote model artifact to {artifact_path}")


if __name__ == "__main__":
    main()
