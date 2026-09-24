# BOLTIV — Railway Deployment

## Service
- Runtime: Node.js 18+
- Root directory: `backend` when deploying the backend as a separate Railway service
- Build command: `npm install`
- Start command: `npm start`
- Railway supplies `PORT`; the server binds to `0.0.0.0`.

## Database
Use the Railway PostgreSQL connection in `DATABASE_URL`.

The current BOLTIV backend initializes/maintains its required schema during startup. Do not replace the database with a different provider unless intentionally migrating later.

## Required production variables
See `backend/.env.example`. Never commit real secrets.

## Frontend
The frontend API endpoint is centralized in:
`boltiv-api-config.js`

Current Railway backend:
`https://boltiv-production.up.railway.app`

## Flutterwave webhook
`https://boltiv-production.up.railway.app/api/flutterwave/webhook`

Update the webhook destination in the Flutterwave dashboard when ready.

## Important
This deployment preparation does not rewrite BOLTIV business logic. Changes are limited to deployment configuration and API endpoint routing.
