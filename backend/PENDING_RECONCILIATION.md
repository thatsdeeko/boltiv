# BOLTIV VTUGATE transaction reconciliation

BOLTIV rechecks VTUGATE transactions that are `processing` or `pending` through `POST /api/v1/transactionstatus`.

- `successful` finalizes the BOLTIV transaction.
- `failed` or `refunded` refunds the customer exactly once and marks the BOLTIV transaction accordingly.
- Provider timeouts and unavailable status checks remain pending/unknown; BOLTIV never refunds solely because a network request timed out.
- The VTUGATE transaction ID/external reference is stored as `provider_reference`.
- Transactions older than 48 hours remain available for admin review.
- The reconciliation job runs every 5 minutes by default.

Environment variable:

`PENDING_RECONCILE_INTERVAL_MS=300000`
