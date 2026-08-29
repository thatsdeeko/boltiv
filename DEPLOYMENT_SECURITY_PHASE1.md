# BOLTIV Deployment Security — Phase 1

## Completed
- Removed the real `backend/.env` from the deployment package. Production secrets must be configured in the hosting provider environment (for example, Render Environment Variables).
- Kept `backend/.env.example` as the safe configuration template.
- Fixed the History page JavaScript regex syntax error.
- Removed unavailable/private transactional routes from `sitemap.xml`; only public pages are listed for indexing.
- Added unavailable service routes to `robots.txt`.

## Before deployment
- Confirm no real `.env`, private keys, certificates, or provider secrets are committed to Git.
- Configure all required production environment variables in Render.
- Rotate any secret that was previously exposed in a public repository or shared archive.
