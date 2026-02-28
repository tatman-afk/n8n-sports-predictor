# NBA V4 Feature Contract

## Scope
`scripts/build_nba_event_features_v4.js` generates `data/nba_event_training_features_v4.csv` from the event-level export.

Input source:
- `data/nba_event_training_dataset.csv` (pregame market lines + final outcomes)

Hard constraints:
- No post-start market data.
- Team history features are computed from prior games only (strict chronological ordering by `starts_at`).
- Opponent-relative features are built only from same-event counterpart row (`event_id + opponent_team_id`).

## Output Columns

### Identity + Label
- `event_id`, `external_key`, `starts_at`, `sport`, `league`
- `team_id`, `team_name`, `opponent_team_id`, `opponent_team_name`
- `split`, `team_win`

### Core Market Inputs (pregame)
- `is_home`
- `books_aggregated`
- `implied_prob`
- `implied_prob_stddev`
- `odds_american_avg`, `odds_american_min`, `odds_american_max`
- `pulled_at_avg_minutes_to_start`

### Outcome Context (from completed games, for historical feature construction)
- `home_score`, `away_score`

### Opponent-Relative Market Structure
- `implied_prob_opp`
- `implied_prob_diff_vs_opp`
- `implied_prob_event_median`
- `implied_prob_event_iqr`
- `implied_prob_stddev_event_median`
- `books_aggregated_opp`
- `books_total`
- `line_dispersion_odds_range_avg`
- `market_dispersion_total`
- `consensus_disagreement_signal`

### Team Form (prior completed games only)
- `rolling_win_rate_5`, `rolling_win_rate_10`
- `rolling_net_rating_5`, `rolling_net_rating_10` (score-diff proxy)
- `rolling_points_for_10`
- `rolling_points_against_10`

### Schedule / Fatigue
- `rest_days`
- `is_back_to_back`
- `opp_rest_days`
- `opp_is_back_to_back`
- `rest_days_diff`
- `is_back_to_back_diff`
- `home_implied_edge_interaction`

### Opponent-Relative Form Deltas
- `rolling_win_rate_diff_5`
- `rolling_win_rate_diff_10`
- `rolling_net_rating_diff_5`
- `rolling_net_rating_diff_10`
- `rolling_points_for_diff_10`
- `rolling_points_against_diff_10`

### Data Quality + Liquidity Flags
- `low_liquidity_team` (`books_aggregated < 3`)
- `low_liquidity_opp` (`books_aggregated_opp < 3`)
- `low_liquidity_total` (`books_total < 6`)
- `missing_form_features`
- `missing_schedule_features`
- `missing_market_features`

## Missingness Rules
- Missing numeric features remain empty in CSV.
- Group-level missing flags are binary (`0`/`1`) and indicate at least one critical field in the group is missing.
- Model scripts should include missing flags when using sparse early-history rows.
