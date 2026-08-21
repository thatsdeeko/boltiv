# BOLTIV Phase 2 — SEO & Launch Setup

## Completed in this build

- Added real clean-URL directory indexes for GitHub Pages (`/contact/`, `/privacy/`, `/terms/`, and application routes).
- Replaced the old `404.html` JavaScript route-loader with a real generic 404 page.
- Removed stale references to deleted services from routing/robots configuration.
- Kept authenticated/application pages `noindex,nofollow`.
- Kept public pages indexable.
- Added Open Graph and Twitter metadata to the main public informational pages.
- Added a site-wide favicon reference.
- Optimized BOLTIV logo/icon assets to WebP and updated page references.
- Kept `sitemap.xml` limited to public indexable pages.

## Google Search Console

BOLTIV still needs Google Search Console ownership verification. This cannot be completed until the verification method is chosen and the verification value is supplied.

Recommended method for `boltiv.ng`: DNS verification at the domain/DNS provider.

Alternative: Google HTML-file verification can be used if Google provides a file for the site root.

After verification, submit:

`https://boltiv.ng/sitemap.xml`

## Google Analytics

Analytics is intentionally not activated with a fake measurement ID. Add the real Google Analytics 4 Measurement ID (format `G-XXXXXXXXXX`) only after creating the BOLTIV property.

Recommended events for BOLTIV:

- `sign_up`
- `login`
- `wallet_funding_started`
- `wallet_funding_success`
- `service_purchase_started`
- `service_purchase_success`
- `service_purchase_failed`

Do not send passwords, PINs, API keys, full payment credentials, or other sensitive personal/financial data to Analytics.
