# BOLTIV — Railway Deployment

This package preserves BOLTIV application/business logic. Deployment changes are limited to Railway API routing and deployment configuration.

- Runtime: Node.js 18+
- Build: `npm install`
- Start: `npm start`
- Railway supplies `PORT`; the server binds to `0.0.0.0`.
- Database: use Railway PostgreSQL `DATABASE_URL`.
- Frontend API: `boltiv-api-config.js`.
- Flutterwave webhook: `/api/flutterwave/webhook`.
