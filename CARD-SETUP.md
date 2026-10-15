# BOLTIV Card (Payscribe) — setup

## Files (drop into the repo at the same paths)
NEW:     cards.html, backend/payscribe-cards.js
EDITED:  backend/server.js (1 require + 1 route hook), dashboard.html (card section under Quick Services), admin.html (Cards page)
LOGO:    every page now points to assets/boltiv-logo-dark-2.webp (the old boltiv-logo.webp / boltiv-logo-dark.webp / boltiv-logo.png references were replaced, including footer, lock screen, share, theme/premium CSS and the SEO logo URL)
No new image files are needed. Keep assets/boltiv-logo-dark-2.webp, boltiv-icon.* and boltiv-social.webp.

## Railway environment variables
PAYSCRIBE_API_KEY, PAYSCRIBE_MERCHANT_HASH_KEY (64 hex), PAYSCRIBE_BASE_URL (sandbox: https://sandbox.payscribe.ng/api/v1; leave unset for live), PAYSCRIBE_WEBHOOK_SECRET (optional)
Webhook URL: https://boltiv-production.up.railway.app/api/payscribe/webhook
Admin > Cards shows the connection status, USD wallet balance, pricing settings and orders (with refund).

## Pricing (admin-editable)
(card amount + creation fee) x (Payscribe live rate + margin). Defaults: margin 100 NGN, creation fee $2, min $1, max $500, rate refresh 60 min.

## Sandbox checklist
Verify -> create $1 card -> top up -> freeze/unfreeze -> show details (PIN) -> wallet short of funds -> provider error refunds -> webhook duplicate/bad signature -> Activity page shows card rows.
