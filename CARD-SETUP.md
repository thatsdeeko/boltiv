# BOLTIV Card — update notes

## New files
cards.html (in-app card page, /cards) | virtual-card.html (public explainer page, /virtual-card) | backend/payscribe-cards.js

## Edited files
- backend/server.js: 1 require + 1 route hook
- dashboard.html: BOLTIV CARD section under Quick Services (real card face, balance, Fund/Details)
- admin.html: Cards page (connection status, USD wallet balance, pricing, orders + refund)
- index.html: Card section, services tile, FAQ; sitemap.xml: /virtual-card
- 20 app pages: new "Cards" tab in the bottom navigation (5 tabs); style.css/inline nav grids now 5 columns
- Logo: every page uses assets/boltiv-logo-dark-2.webp (keep that file in /assets)

## Railway environment variables
PAYSCRIBE_API_KEY | PAYSCRIBE_MERCHANT_HASH_KEY (64 hex) | PAYSCRIBE_BASE_URL (sandbox: https://sandbox.payscribe.ng/api/v1; unset for live) | PAYSCRIBE_WEBHOOK_SECRET (optional)
Webhook URL: https://boltiv-production.up.railway.app/api/payscribe/webhook

## Pricing (admin-editable)
(card amount + creation fee) x (live rate + margin). Defaults: margin 100 NGN, fee $2, min $1, max $500, rate refresh 60 min.

## Sandbox checklist
Verify -> create $1 card -> top up -> freeze/unfreeze -> show details (PIN) -> insufficient wallet -> provider error refunds -> webhook duplicate/bad signature -> Activity shows card rows -> Cards tab opens on every page.
