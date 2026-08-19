# BOLTIV Payscribe Wallet Funding Migration

This build replaces the customer-facing Paystack wallet-funding flow with Payscribe personal virtual accounts.

## Render environment variables

Set these on the backend service:

- `PAYSCRIBE_API_KEY` — Payscribe secret API key. Never expose it to the frontend.
- `PAYSCRIBE_API_BASE_URL=https://api.payscribe.ng/api/v1`
- `PAYSCRIBE_VA_CREATE_PATH` — the exact current Payscribe Collections virtual-account creation path for your account/docs.
- `PAYSCRIBE_WEBHOOK_SECRET` — webhook signing secret. If omitted, the backend falls back to `PAYSCRIBE_API_KEY`.
- `PAYSCRIBE_WEBHOOK_TOLERANCE_SECONDS=300`

The current Payscribe documentation confirms Bearer authentication and the production base URL. Tier 1 is required for Collections.

## Webhook

Configure Payscribe to send the collection/virtual-account events to:

`https://<your-render-host>/api/payscribe/webhook`

The backend verifies:

`HMAC-SHA256(timestamp + "." + event_id + "." + raw_body, webhook_secret)`

using the `X-Payscribe-Event-Id`, `X-Payscribe-Timestamp`, and `X-Payscribe-Signature` headers, rejects stale deliveries, and stores event IDs for idempotency.

## Customer flow

1. Registration creates a BOLTIV user and attempts to create the corresponding Payscribe Tier 0 customer.
2. The Wallet page loads the user's personal funding account.
3. If no account exists, the user completes the required Tier 1 information.
4. The backend upgrades the Payscribe customer to Tier 1.
5. The backend creates the personal virtual account.
6. The account number/bank is displayed to the user.
7. The user transfers directly to that account; there is no Paystack redirect.
8. Payscribe webhook is verified and the BOLTIV wallet is credited atomically.
9. A `Wallet Funding` transaction and notification are recorded.

## Important

The exact Collections virtual-account endpoint should be copied from the current Payscribe Collections documentation/dashboard into `PAYSCRIBE_VA_CREATE_PATH`. The rest of the integration intentionally does not hard-code an undocumented endpoint.

Paystack admin withdrawal functionality is left intact because it is separate from customer wallet funding.
