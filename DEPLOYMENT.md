# BOLTIV Deployment — Flutterwave Only

BOLTIV now uses Flutterwave as the payment provider for:

- Customer wallet deposits through Dynamic or Static NGN virtual accounts.
- Permanent customer accounts using NIN or BVN.
- Admin operating-wallet funding through a Flutterwave Dynamic virtual account.
- Admin Revenue Wallet withdrawals to Nigerian bank accounts through Flutterwave Transfers.

## Required Render variables

```env
DATABASE_URL=
FRONTEND_URL=https://boltiv.ng
FRONTEND_ORIGIN=https://boltiv.ng
BACKEND_PUBLIC_URL=https://boltiv-backend.onrender.com
ADMIN_EMAIL=
ADMIN_PASSWORD=
ADMIN_PHONE=
FLW_SECRET_KEY=
FLW_BASE_URL=https://api.flutterwave.com/v3
FLW_SECRET_HASH=
FLW_CALLBACK_URL=
```

Keep the Flutterwave secret key and webhook secret hash server-side only.

## Flutterwave webhook

Configure this URL in Flutterwave Dashboard → Settings → Webhooks:

`https://<your-render-service>.onrender.com/api/flutterwave/webhook`

Set the same random secret hash in `FLW_SECRET_HASH`. The backend accepts Flutterwave's current `flutterwave-signature` HMAC format and the v3 `verif-hash` format.

## Customer funding

- Static: customer chooses NIN or BVN and receives a reusable permanent account.
- Dynamic: customer chooses a deposit amount and receives a temporary account for that deposit.
- Flutterwave sends `charge.completed`; BOLTIV maps the webhook to the stored virtual-account `tx_ref` and credits the correct wallet idempotently.

## Admin funding

Admin → Wallets → Fund Admin Wallet → enter amount → create Flutterwave Dynamic account → transfer → Flutterwave webhook → admin operating wallet credited.

## Revenue withdrawal

Admin → Revenue & Withdrawals → select bank → verify account → enter amount → Flutterwave Transfer. Pending transfers are reconciled through Flutterwave transfer status/webhooks; failed transfers reverse the reserved revenue balance.
