# SME API data-plan validity fix

This build uses the uploaded Boltiv project as the base.

The backend now normalizes SME API plan validity from `validity`, `validity_period`,
`validityPeriod`, `validity_days`, `duration`, and related fields, including nested
values and numeric validity values such as `30` (treated as 30 days, matching the
SME API catalogue).

The `/api/vtu/data/plans` response exposes `validity`, `validity_period`,
`duration`, and `validity_days`. The frontend renders the validity directly below
the plan size/name.

No new environment variables are required.
