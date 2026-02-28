# Backup Safety Policy

## DO NOT DELETE (Critical)

Do not delete backup artifacts from this folder unless all of the following are true:

1. The backup set has been copied to a verified long-term location.
2. Restore has been tested successfully from that archived copy.
3. Retention policy sign-off is complete.

## Backup Set Components

Each backup set should include:

- `*.dump` (compressed custom format; preferred for `pg_restore`)
- `*.sql` (plain SQL fallback)
- `*_globals.sql` (roles/tablespaces if available)

Keep these files together as one logical restore unit.

## Operational Rule

Before schema/data migration work, run:

```bash
npm run db:backup
```

Then verify output files exist in `data/backups/`.
