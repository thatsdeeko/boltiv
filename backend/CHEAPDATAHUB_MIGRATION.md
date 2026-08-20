# BOLTIV CheapDataHub Airtime + Data Migration

## What changed
- Airtime and Data now route to CheapDataHub when `CHEAPDATAHUB_API_KEY` is configured.
- Cable TV and Electricity remain on VTUGATE.
- CheapDataHub authentication stays backend-only with `Authorization: Bearer ...`.
- Airtime maps BOLTIV networks to CheapDataHub provider IDs: MTN=1, GLO=2, Airtel=3, 9Mobile=4.
- Data uses CheapDataHub `bundle_id` instead of VTUGATE `service_id + plan_code`.
- The BOLTIV wallet/PIN/idempotency/refund/revenue logic is unchanged.
- The data catalog reads CheapDataHub's public Plan IDs page and has a built-in fallback catalogue based on the current published plans.

## Environment variables
```
CHEAPDATAHUB_API_BASE_URL=https://www.cheapdatahub.ng/api/v1/resellers
CHEAPDATAHUB_API_KEY=
VTU_API_BASE_URL=https://api.vtugate.com
VTU_API_KEY=
VTU_PROVIDER=vtugate
```

## Important
CheapDataHub currently documents a live API rather than a public sandbox. Use a very small live transaction after funding the CheapDataHub reseller wallet.

The API key shown in the supplied screenshot is considered exposed. Regenerate it in CheapDataHub before putting the new key into Render.


## Reliability hardening
- CheapDataHub purchase timeouts, 409 duplicate responses, and 5xx responses are treated as `unknown`/`pending`, not immediate failures.
- Wallet refunds are transaction-aware and idempotent.
- CheapDataHub `successful`, `failed`, and `refunded` final states are reconciled through provider transaction lookup.
- A CheapDataHub webhook endpoint is available at `/api/cheapdatahub/webhook`. If `CHEAPDATAHUB_WEBHOOK_SECRET` is configured, the endpoint verifies an HMAC-SHA256 signature from `x-cheapdatahub-signature` (or `x-webhook-signature`). Configure the header/secret to match your CheapDataHub webhook settings.
- The backend reconciles pending/processing CheapDataHub transactions every five minutes and does not auto-refund merely because a provider lookup is unavailable.
- The frontend API contract is unchanged.
