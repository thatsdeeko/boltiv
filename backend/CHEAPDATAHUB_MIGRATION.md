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
