# Multi-Scraper + Player Stats Expansion Timeline

## Objective
Expand the current prediction pipeline so we can store and analyze:
- Player-level picks (not just team moneyline picks)
- Individual player stats used to justify picks
- Multi-source sportsbook and stats data gathered via API, HTML scraping, and browser automation (Selenium)

## Architecture Reference
Detailed system design and Mermaid diagrams are in `architecture.md`.

## Implementation Timeline (2-Point User Stories)

Assume Sprint 1 starts **Monday, February 23, 2026**.

## Sprint 1 (Feb 23 - Mar 6, 2026): Foundations
1. **[2 pts]** As a platform engineer, I want canonical `teams`, `players`, and `events` tables so all sources map into one schema.
: Acceptance: migrations applied; FK constraints present; seed test data inserted.
2. **[2 pts]** As a backend engineer, I want `ingest_runs` and `ingest_items` tables so every scrape run is auditable.
: Acceptance: each run writes start/end status and persisted raw payload references.
3. **[2 pts]** As a developer, I want a source adapter interface (`fetch()`, `parse()`, `normalize()`) so each scraper follows one contract.
: Acceptance: interface module + one stub adapter + unit tests.
4. **[2 pts]** As an operator, I want per-source config (rate limits, retries, enabled flag) so source behavior is controlled without code edits.
: Acceptance: config loaded from env/db and applied at runtime.

## Sprint 2 (Mar 9 - Mar 20, 2026): First Multi-Scraper Path
5. **[2 pts]** As a data engineer, I want an API-based odds scraper for one sport (NBA) so we have a reliable baseline feed.
: Acceptance: odds inserted into `market_lines`; success metrics logged.
6. **[2 pts]** As a data engineer, I want an HTML parser scraper for one stats site so we can ingest player stat lines without an API.
: Acceptance: parsed player stat rows stored in `player_stats` with source tags.
7. **[2 pts]** As a data engineer, I want a Selenium scraper for one dynamic sportsbook page so JS-only props are collectible.
: Acceptance: headless run in CI/worker environment; 3 stable selectors; retry on stale element.
8. **[2 pts]** As a backend engineer, I want alias resolution for players/teams so records from different sources merge cleanly.
: Acceptance: alias table + resolver job; collision report generated.

## Sprint 3 (Mar 23 - Apr 3, 2026): Prediction Model Upgrade
9. **[2 pts]** As an API consumer, I want `POST /api/predictions` to accept structured leg arrays so player props are first-class picks.
: Acceptance: request validation for `team_ml` and `player_prop` legs.
10. **[2 pts]** As a dashboard user, I want prediction details to show leg-level metadata (line, odds, player/team) so picks are explainable.
: Acceptance: API response includes expanded leg payloads.
11. **[2 pts]** As a backend engineer, I want prediction writes to persist to `prediction_runs` + `prediction_legs` so settlement can occur per leg.
: Acceptance: transactional insert; rollback on partial failure.
12. **[2 pts]** As a QA engineer, I want contract tests for ingestion and prediction payloads so schema drift is caught early.
: Acceptance: failing tests on missing required leg fields or invalid market types.

## Sprint 4 (Apr 6 - Apr 17, 2026): Settlement + Reliability
13. **[2 pts]** As an analyst, I want automated player prop settlement using official stats feeds so outcomes are not manual.
: Acceptance: `settlement_results` updated for completed events.
14. **[2 pts]** As an operator, I want alerting on scraper failures and stale feeds so outages are visible quickly.
: Acceptance: alerts fire when failure/staleness thresholds are crossed.
15. **[2 pts]** As a platform engineer, I want idempotent dedupe keys for ingest items so retries do not duplicate odds/stat rows.
: Acceptance: duplicate payload reprocess creates no duplicate canonical rows.
16. **[2 pts]** As a product owner, I want rollout flags per scraper source so risky scrapers can be toggled off instantly.
: Acceptance: feature flags disable source execution without deploy.

## Sprint 5 (Apr 20 - May 1, 2026): Scale + Hardening
17. **[2 pts]** As an engineer, I want parallel scrape execution with queue concurrency limits so throughput increases safely.
: Acceptance: configurable worker concurrency and bounded queue latency.
18. **[2 pts]** As an engineer, I want backfill tooling for last 30 days so model evaluation has enough history.
: Acceptance: backfill command populates historical events/props/stats.
19. **[2 pts]** As a security owner, I want source-specific secrets and rotation policy so scraper credentials are protected.
: Acceptance: secrets moved to managed store and rotation documented.
20. **[2 pts]** As a product owner, I want a go-live checklist (SLOs, compliance, fallback feeds) so launch risk is controlled.
: Acceptance: checklist approved before full production enablement.

## Delivery Milestones
- **Milestone A (Mar 20, 2026):** Multi-scraper MVP (API + HTML + Selenium for selected sources).
- **Milestone B (Apr 3, 2026):** Player-prop picks fully persisted in API/database.
- **Milestone C (Apr 17, 2026):** Automated settlement for team and player picks.
- **Milestone D (May 1, 2026):** Production hardening complete with monitoring and controls.

## Key Risks and Mitigations
- Source blocking / anti-bot controls
: Mitigation: prioritize official APIs, add retry/backoff, rotate agents/proxies, keep fallback sources.
- Selector drift on dynamic pages
: Mitigation: central selector registry + health check tests.
- Entity mismatch (player/team names)
: Mitigation: alias dictionary + confidence-scored matching + manual review queue.
- Terms-of-service violations
: Mitigation: per-source legal review before enabling non-API scraping in production.
