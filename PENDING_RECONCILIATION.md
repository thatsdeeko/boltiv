# Pending transaction reconciliation

BOLTIV rechecks CheapDataHub Airtime, Data, and Exam PIN debit transactions that are `processing` or `pending` through the CheapDataHub Transactions API.

- `successful` finalizes the transaction.
- `failed` or `refunded` refunds the customer exactly once and marks the BOLTIV transaction `refunded`.
- Provider timeouts, HTTP 409 duplicate responses, 5xx errors, and unavailable status checks are treated as unknown/pending; they are never auto-refunded solely because the provider could not be reached.
- The reconciliation worker uses the CheapDataHub transaction ID/reference stored on the BOLTIV transaction.
- Transactions older than 48 hours are left for admin review rather than automatically refunded.
- The reconciliation job runs every 5 minutes by default.

CheapDataHub webhook integration is intentionally not required. The BOLTIV deployment should rely on the documented Transactions API for polling/reconciliation unless CheapDataHub explicitly enables and documents webhook delivery for the reseller account.

Environment variables:
- `PENDING_RECONCILE_INTERVAL_MS=300000`
