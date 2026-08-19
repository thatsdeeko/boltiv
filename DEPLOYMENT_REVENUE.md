# BOLTIV Revenue Wallet — Flutterwave Withdrawals

Revenue-wallet withdrawals use Flutterwave's Nigerian bank list, account-name resolution, transfer API, transfer webhooks, and transfer-status endpoint.

Flow:

1. Customer service sale credits the BOLTIV Revenue Wallet.
2. Authenticated admin selects a Nigerian bank.
3. BOLTIV resolves the recipient account through Flutterwave.
4. BOLTIV reserves the requested amount.
5. BOLTIV initiates `POST /v3/transfers`.
6. Flutterwave reports the final status through webhook or status lookup.
7. A failed transfer reverses the reserved revenue amount.

Required environment variables:

```env
FLW_SECRET_KEY=
FLW_BASE_URL=https://api.flutterwave.com/v3
FLW_SECRET_HASH=
FLW_CALLBACK_URL=
```
