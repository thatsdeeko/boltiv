# BOLTIV deployment/security patch

This build removes the Betting/Bigisub frontend and provider integration and hardens the remaining application.

Security changes included:
- Admin state-changing requests require a server-issued CSRF token.
- Admin sessions now carry a CSRF token in the database; existing sessions are upgraded automatically.
- Transaction PIN changes are rate-limited to 5 attempts per 15 minutes per user/IP bucket.
- Registration now requires passwords of at least 8 characters.
- Receipt output escapes transaction/provider/user-controlled values before inserting HTML.
- API responses include HSTS when the configured frontend URL is HTTPS.
- CORS explicitly permits the `X-Admin-CSRF` header.

Before deployment:
1. Set all secrets in Render Environment Variables. Never commit `.env` files or real API keys.
2. Keep `VTU_PROVIDER=vtugate` and configure the VTUGATE service IDs/API key for the services you actually enable.
3. Set `FRONTEND_URL=https://boltiv.ng` and `FRONTEND_ORIGIN=https://boltiv.ng`.
4. Keep the Render service on HTTPS.
5. Rotate any secret that may previously have been exposed in screenshots, repositories, logs, or chat.
