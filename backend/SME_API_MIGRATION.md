# BOLTIV — SME API Single-Provider Migration

BOLTIV now routes the core VTU services through SME API instead of CheapDataHub/VTUGATE.

## Config

Set these backend environment variables:

```env
SME_API_BASE_URL=https://smeapi.com.ng
SME_API_KEY=YOUR_SME_API_KEY
SME_API_CABLE_PROVIDER_MAP={"DSTV":1,"GOTV":2,"STARTIMES":3}
SME_API_ELECTRICITY_PROVIDER_MAP={"IKEDC":YOUR_ID,"EKEDC":YOUR_ID,"AEDC":YOUR_ID,"KEDCO":YOUR_ID}
```

Do not commit the real API key.

## Core endpoints now used

- Airtime: `POST /api/airtime/`
- Data: `POST /api/data/`
- Plans: `GET /api/dataplans/`
- Cable verify/purchase: `/api/cabletv/verify/`, `/api/cabletv/`
- Electricity verify/purchase: `/api/electricity/verify/`, `/api/electricity/`
- Exam PIN: `POST /api/exam/`
- Balance: `GET /api/user/`

Every paid request uses the BOLTIV transaction reference as SME API `ref`.

## Additional SME services

The service registry includes Data PIN, Recharge Card PIN, Bulk SMS, Smile Data, Alpha Top-up and Kirani so SME API is the single configured provider. Their public docs expose endpoints for these services, but payloads/activation requirements should be confirmed for the account before exposing them in the customer UI.

## Reconciliation

The public SME API documentation currently documents unique transaction references but does not expose a public transaction-status endpoint. Pending transactions therefore remain pending rather than being auto-refunded based only on a timeout. Admins can use the transaction reference to verify provider status before resolving/refunding a transaction.
