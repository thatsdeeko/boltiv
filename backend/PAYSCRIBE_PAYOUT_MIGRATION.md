# BOLTIV Payscribe Admin Payout Migration

Admin revenue withdrawals now use Payscribe Payouts instead of Paystack.

## Endpoints used
- GET `/payouts/bank/list?country=NGN`
- POST `/payouts/account/lookup`
- POST `/payouts/transfer`
- GET `/payouts/verify/:trans_id`

The Payscribe API key is backend-only. Payscribe requires the Render server outbound IP to be whitelisted for payout access.

## Render environment
- `PAYSCRIBE_API_KEY`
- `PAYSCRIBE_API_BASE_URL=https://api.payscribe.ng/api/v1`
- `PAYSCRIBE_WEBHOOK_SECRET`
- `PAYSCRIBE_WEBHOOK_TOLERANCE_SECONDS=300`
- `PAYSCRIBE_PAYOUT_COUNTRY=NGN`

## Withdrawal safety
BOLTIV reserves/deducts the admin revenue amount before calling Payscribe. If Payscribe rejects the transfer or a later payout webhook reports failure, the amount is reversed back to the admin revenue wallet. Successful/processing payouts retain their provider transaction ID and reference for reconciliation.

Paystack is no longer used by `/api/admin/revenue/banks`, `/api/admin/revenue/verify-account`, `/api/admin/revenue/withdraw`, or `/api/admin/revenue/status`.
