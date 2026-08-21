# BOLTIV Phase 4 — Production & Transaction QA

## Applied hardening
- Flutterwave HMAC webhook signatures now use a timing-safe comparison.
- Unsupported legacy services are disabled at startup and excluded from the public service catalogue.
- The public service catalogue is limited to airtime, data, cable, electricity and exam PIN.
- Legacy PNG logo/icon assets were removed after confirming no frontend references remain; WebP assets are the production assets.
- No `.env`, `.pem`, or `.key` files are included in the deployment package.

## Required live tests before launch
1. Register a new customer.
2. Login/logout and session expiry.
3. Password reset email and token expiry.
4. Create/change transaction PIN.
5. Create/activate wallet funding account.
6. Flutterwave funding initialization and verification.
7. Flutterwave webhook signature + duplicate-event handling.
8. Wallet balance and ledger reconciliation after funding.
9. Airtime purchase: success, provider failure, insufficient balance, duplicate/idempotency.
10. Data purchase: catalogue, plan selection, purchase, failure/refund.
11. Cable verification and purchase.
12. Electricity verification and purchase.
13. Exam PIN catalogue and purchase.
14. Transaction history and receipt generation.
15. Admin login, CSRF, session revocation and audit events.
16. Admin wallet credit/debit and refund controls.
17. Support ticket creation/reply/status.
18. Mobile browser testing on Android Chrome.
19. CORS verification from `https://boltiv.ng` and rejection of untrusted origins.
20. Confirm Render environment variables are populated; never commit real secrets.

## Live-only checks
The live provider/database/payment tests require BOLTIV's production credentials and cannot be truthfully marked PASS from the local source package alone.
