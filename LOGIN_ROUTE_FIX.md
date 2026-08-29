# BOLTIV Login Route Fix

The clean-URL 404 router loads pages into URLs such as `/login/` and `/dashboard/`. Relative scripts and assets could therefore resolve under `/login/` or `/dashboard/` instead of the site root.

This build adds `<base href="/">` to HTML documents and makes the 404 router inject it when needed. This keeps `boltiv-client.js`, CSS, and assets loading from the correct root while retaining single-file pages.
