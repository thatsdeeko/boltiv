# BOLTIV Deployment — Flutterwave Only

BOLTIV now uses Flutterwave as the payment provider for:

- Customer wallet deposits through Dynamic or Static NGN virtual accounts.
- Permanent customer accounts using NIN or BVN.
- Admin operating-wallet funding through a Flutterwave Dynamic virtual account.
- Revenue withdrawals are performed manually in the Flutterwave dashboard; BOLTIV does not initiate bank transfers.

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

BOLTIV does not initiate revenue withdrawals. Withdrawals are performed directly in the Flutterwave dashboard. BOLTIV keeps revenue/ledger records for accounting and reconciliation.


## Resend email configuration

Set these backend environment variables in production:

```text
RESEND_API_KEY=your_resend_api_key
MAIL_FROM=BOLTIV <support@boltiv.ng>
```

Verify `boltiv.ng` in Resend before using `support@boltiv.ng`. The backend uses Resend for password reset, email verification, wallet-funding receipts, successful transaction emails, and refund emails. The test sender `onboarding@resend.dev` can be used only where Resend permits testing.


### Resend troubleshooting

If `/forgot-password` says it could not send the email, check the Render backend service environment variables first:

- `RESEND_API_KEY` must be present and valid.
- `MAIL_FROM` should be `BOLTIV <support@boltiv.ng>` (or another address on the verified `boltiv.ng` domain).
- After changing either variable, redeploy/restart the backend service.

The backend now logs whether the Resend key is configured and returns the non-secret Resend error message when Resend rejects a request, which makes sender/API-key problems diagnosable instead of showing only a generic failure.
