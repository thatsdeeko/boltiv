# Pending transaction reconciliation

Boltiv automatically rechecks debit transactions stuck in `processing` or `pending` through VTUGATE.

- A successful provider result finalizes the transaction.
- A failed provider result refunds the customer wallet exactly once.
- Unavailable provider checks are left pending.
- Transactions older than 48 hours are flagged as stale for admin review; they are not auto-refunded merely because they are old.
- The reconciliation job runs 15 seconds after startup and every 5 minutes by default.

Optional Render environment variables:
- `PENDING_RECONCILE_INTERVAL_MS=300000`
- `PENDING_STALE_AFTER_MS=172800000`
