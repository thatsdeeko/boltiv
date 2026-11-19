# BOLTIV Link: install

This zip holds only BOLTIV Link. Your other BOLTIV files are not in it.

## 1. Copy these files into your repo (same folders)
- backend/link/        -> backend/link/   (new folder)
- link.html            -> repo root  (the app: my websites, create flow, editor; boltiv.ng/link)
- boltiv-link.html     -> repo root  (public page with live designs; boltiv.ng/boltiv-link)

## 2. Apply the edits to your existing files (one command, from your repo root)
    patch -p1 < link-edits.patch
It changes 7 files:
- backend/server.js     Link hooks (require, getLink(), host check, /api/link routes, expiry timer)
- dashboard.html        BOLTIV LINK card, placed FIRST, above Business Manager, listing the customer's websites
- admin.html            new "BOLTIV LINK" section in the admin sidebar (stats, settings, websites, suspend, add days)
- index.html            BOLTIV Link tile and section on the main public page
- all-services.html     BOLTIV Link section
- sitemap.xml           adds /boltiv-link
- service-worker.js     cache version v72 -> v73

## 3. Customers see it without clearing Chrome history
Pages are fetched fresh by your service worker. Changing its version makes every phone drop the old saved copy on the next visit.
Raise the number in service-worker.js every time you deploy shell changes.

## 4. DNS (customer websites will not open until this is done)
1. Railway -> backend service -> add custom domain `*.boltiv.ng` (wildcard needs a paid plan). Railway shows a CNAME.
2. Add that wildcard CNAME for `*` in your DNS. Keep every existing record (boltiv.ng and www stay on GitHub Pages, email records keep working).
3. Optional env vars: LINK_DOMAIN (default boltiv.ng), LINK_SALT (any random string).

## 5. What customers get
- Several websites per account (default max 10, admin setting). Each is paid for and renewed separately (₦5,000 per 30 days by default).
- Six designs: Atelier (fashion), Bistro (restaurants), Market (retail), Studio (business services), Folio (portfolio), Glow (beauty).
  Each has 4 colour palettes, font pairings, reorderable/renamable sections, highlights, testimonials, gallery, WhatsApp ordering.
- New websites start with sample content. Publishing warns if sample content is still there.
- Photos are the customer's own; without a photo the design shows tasteful generated artwork, never a blank box.

## 6. Admin (admin.html > BOLTIV LINK)
Settings: on/off, price, days, max websites per customer. List with search and filters, suspend/activate, add 30 days.
Settings keys in platform_settings: link_price (5000), link_days (30), link_enabled (true), link_max_sites (10).
If you change price or days, also edit the written text in boltiv-link.html, index.html and dashboard.html.

## 7. Test on a staging database before launch
`node --test backend/link/link.test.js` passes (9 tests). The database routes and the screens were NOT run in a real
browser/database here, so check:
create website (pay) -> create a second one -> edit + preview on a phone -> publish -> open https://name.boltiv.ng ->
set expires_at in the past -> "temporarily unavailable" -> renew -> back online ->
DELETE FROM link_sites (must fail) -> admin suspend -> site unavailable.
