# BOLTIV Production Deployment

## Render backend

Set the Render service root directory to `backend`, or use the included `render.yaml` Blueprint.

Required environment variables:

- `DATABASE_URL`
- `PAYSTACK_SECRET_KEY`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `VTU_API_URL`
- `VTU_API_KEY`
- `FRONTEND_URL`
- `FRONTEND_ORIGIN`

Optional but recommended:

- `RESEND_API_KEY`
- `MAIL_FROM`

The backend exposes `GET /api/health`. Render should use `/api/health` as its health-check path.

## Paystack

Set the Paystack webhook URL to the deployed backend endpoint:

`https://<your-render-service>.onrender.com/api/paystack/webhook`

Do not put the Paystack secret key in frontend HTML or JavaScript.

## Frontend

The current frontend pages use the deployed backend URL directly. If the backend URL changes, update the API base URLs in the frontend pages before deployment.

## Final smoke test

After deployment verify:

1. `GET /api/health` returns HTTP 200 and `database: connected`.
2. Registration and login work.
3. Wallet funding initializes and Paystack returns to the frontend.
4. Paystack webhook reaches `/api/paystack/webhook`.
5. Wallet balance changes only after verified payment.
6. Airtime/data/cable/electricity transactions require the transaction PIN.
7. Failed transactions refund correctly.
8. Admin login works.
9. Admin audit logs are populated.
10. A suspended user cannot use an existing session.


## Customer NIN KYC

BOLTIV now requires a verified NIN before wallet funding. The backend uses VerifyMe's Nigerian NIN verification endpoint. Set `VERIFYME_API_KEY` in the Render backend environment. Never expose this key in frontend code.

The customer flow is:
`Register -> NIN KYC -> Verified -> Fund Wallet -> Paystack`

No customer withdrawal flow is enabled.
