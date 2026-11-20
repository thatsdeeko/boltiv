# BOLTIV Link: business hub upgrade

## What changed
- backend/link/templates.js (new): 10 design languages (adds Vista, Forma, Lumen, Fête).
- backend/link/logic.js: expanded config (layout controls, up to 8 photos per item, categories, badges, options, stats, FAQ, custom blocks, announcement bar, shop and booking settings), server-side order pricing, promo rules, booking slot engine, CRM helpers.
- backend/link/render.js: rewritten renderer (layout-driven, responsive image variants, JSON-LD, mobile action bar).
- backend/link/client.js (new): the one static script on published sites (cart, product gallery with thumbnails/swipe/lightbox, booking, enquiry). Allowed in the CSP by hash.
- backend/link/index.js: new tables, image variants, orders/bookings/enquiries/customers/promos/analytics APIs, public site API.
- backend/server.js: image route accepts /s and /m variants.
- link.html + link-app.js (new): owner dashboard (Overview, Design, Content, Inbox, Customers, Marketing, Analytics, Shop & booking).
- boltiv-link.html: public page rewritten. index.html, all-services.html: stale Link copy fixed. admin.html: hub stats. service-worker.js: cache v74.

## Deploy checklist
1. Deploy backend first (tables and columns are created automatically on first request, all additive).
2. Deploy front-end files together (link.html and link-app.js).
3. Hard-refresh once; the service worker cache name was bumped.
4. Smoke test on a throwaway site: publish, add to cart, place order, book a slot, send enquiry, upload 8 photos, open gallery on a phone.
