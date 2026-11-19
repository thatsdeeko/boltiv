# BOLTIV Link: deploy notes

Files (copy over your repo, same paths):
- backend/link/{index,logic,render}.js + link.test.js  (new)
- backend/server.js  (4 small hooks: require, getLink(), serveSite at top of handler, /api/link routes, startTimers)
- boltiv-link.html  (NEW public explainer page, boltiv.ng/boltiv-link: features, how it works, ₦5,000 per 30 days, renewal rules, FAQ, live name check)
- link.html  (the app: name check, payment, builder; boltiv.ng/link; noindex)
- sitemap.xml  (adds /boltiv-link)

## DNS / hosting (no new domain needed: sites live at name.boltiv.ng)
1. In Railway, add `*.boltiv.ng` as a custom domain on the backend service (wildcard domains need a paid Railway plan). Railway shows you one CNAME (and maybe a TXT) record.
2. In your DNS, add that wildcard CNAME for `*`. Keep your existing records as they are: `boltiv.ng` and `www` stay on GitHub Pages, and your email records (Resend etc.) keep working, because a wildcard only covers names that have no record of their own.
3. The server answers only `something.boltiv.ng` names. `www`, and reserved names like `api`, `mail`, `admin`, are never treated as customer sites, so you can still use `api.boltiv.ng` later.
4. Env vars (optional): LINK_DOMAIN (default boltiv.ng), LINK_SALT (any random string).

## Admin settings (platform_settings): link_price (5000), link_days (30), link_enabled (true)
Admin API: GET /api/admin/link/sites, PATCH /api/admin/link/site {id,status,extendDays}, PATCH /api/admin/link/settings.
(No admin screen yet.)

## Test before going live
`node --test backend/link/link.test.js` passes. The database routes could NOT be run here (no Postgres in my sandbox), so test on a staging DB:
register -> check username taken -> edit -> publish -> open https://name.boltiv.ng -> set expires_at in the past -> site shows "temporarily unavailable" -> renew -> back online -> try DELETE FROM link_sites (must error).

The public page shows ₦5,000 / 30 days as default text and refreshes it from /api/link/pricing, so if you change link_price or link_days in settings, edit the written sentences in boltiv-link.html FAQ too (they are fixed text for search engines).
