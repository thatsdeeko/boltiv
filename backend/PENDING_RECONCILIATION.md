# Pending transaction reconciliation

BOLTIV rechecks CheapDataHub Airtime, Data, and Exam PIN debit transactions that are `processing` or `pending` through the CheapDataHub Transactions API.

- `successful` finalizes the transaction.
- `failed` or `refunded` refunds the customer exactly once and marks the BOLTIV transaction `refunded`.
- Provider timeouts, HTTP 409 duplicate responses, 5xx errors, and unavailable status checks are treated as unknown/pending; they are never auto-refunded solely because the provider could not be reached.
- Duplicate webhooks are ignored through `cheapdatahub_webhook_events`.
- Transactions older than 48 hours are left for admin review rather than automatically refunded.
- The reconciliation job runs every 5 minutes by default.

Environment variables:
- `PENDING_RECONCILE_INTERVAL_MS=300000`
- `PENDING_STALE_AFTER_MS=172800000`
- `CHEAPDATAHUB_WEBHOOK_SECRET=`
