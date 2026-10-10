# BOLTIV premium update: deployment

Copy every file in this zip into the root of your repo (same folder as index.html), overwrite when asked, commit and push. Railway auto-deploys.

New files: boltiv-premium.css, boltiv-motion.js
Changed: boltiv-theme.js (new visitors default to dark), index.html (rebuilt homepage), services.html (removed duplicate "International Airtime" coming-soon card), agents.html and features.html (new nav), dashboard.html (8 service tiles + motion script), and every other .html page (new stylesheet link and cache-busting ?v=20261010-pm).
Not touched: admin.html, backend/, server.js, all other JS files.

After deploying, hard refresh once (or clear site data) so phones pick up the new theme file.
To undo: restore the previous commit. Nothing else depends on these files.
