# BOLTIV Revenue Wallet — Flutterwave Withdrawals

BOLTIV records successful customer service sales in `admin_revenue_wallets` and `admin_revenue_ledger`. The admin can now withdraw the existing revenue balance through the configured Flutterwave NGN transfer API.

## Withdrawal flow

1. Admin opens **Financial Reconciliation → Revenue Withdrawal**.
2. Admin enters the destination Nigerian bank code, account number and amount.
3. BOLTIV resolves the account through Flutterwave before reserving any balance.
4. BOLTIV reserves the requested amount from the Revenue Wallet and creates an auditable `admin_revenue_withdrawals` record.
5. BOLTIV initiates `POST /v3/transfers` in NGN with a unique reference. Flutterwave documents this endpoint for NGN bank transfers.
6. The transfer remains `pending` until Flutterwave reports a final status.
7. Flutterwave transfer webhooks update the withdrawal. A failed transfer automatically restores the reserved amount to the Revenue Wallet with a reversal ledger entry.
8. Admin can manually refresh a pending transfer from the dashboard; BOLTIV queries `GET /v3/transfers/{id}`.

## Important accounting rule

The Revenue Wallet is an internal sales ledger, not a bank account. A successful VTUGATE sale increases BOLTIV's sales/revenue ledger; the Flutterwave transfer is the mechanism used to move an available amount to the configured bank account. Do not manually edit the Revenue Wallet balance or create duplicate transfers.

## Environment

Set:

`FLW_SECRET_KEY=...`

`FLW_BASE_URL=https://api.flutterwave.com/v3`

`FLW_SECRET_HASH=...`

`BACKEND_PUBLIC_URL=https://boltiv-backend.onrender.com`

The Flutterwave webhook should point to:

`https://<your-render-service>.onrender.com/api/flutterwave/webhook`

Flutterwave's transfer webhook is used to finalize successful/failed payouts; the dashboard also provides a manual status check path.
