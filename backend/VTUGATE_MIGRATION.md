# BOLTIV — VTUGATE Production Migration

BOLTIV has migrated its VTU provider layer from SME API to **VTUGATE**. The integration is production-only; no sandbox/test key is configured by default.

## Production configuration

```env
VTUGATE_API_BASE_URL=https://api.vtugate.com
VTUGATE_API_KEY=YOUR_LIVE_VTUGATE_API_KEY
VTUGATE_SERVICE_MAP={}
VTUGATE_EDUCATION_PRODUCTS={"waec":"WAEC","neco":"NECO","jamb":"JAMB","nabteb":"NABTEB"}
```

Never put the VTUGATE API key in frontend code or commit it to GitHub.

## VTUGATE endpoints used

- Account/balance: `POST /api/v1/accountdetails`
- Services: `POST /api/v1/fetchservices` / `POST /api/v1/fetchallservices`
- Data plans: `POST /api/v1/fetchdataplans`
- Airtime: `POST /api/v1/buyairtime`
- Data: `POST /api/v1/buydata`
- Cable verification: `POST /api/v1/verifycabletv`
- Cable purchase: `POST /api/v1/buycabletv`
- Electricity verification: `POST /api/v1/verifyelectricity`
- Electricity purchase: `POST /api/v1/buyelectricity`
- Education price: `POST /api/v1/geteducationtypeprice`
- Education PIN purchase: `POST /api/v1/buyeducation`
- Transaction reconciliation: `POST /api/v1/transactionstatus`

VTUGATE uses HTTPS, `application/x-www-form-urlencoded`, and `Authorization: Bearer {API_KEY}`. urlVTUGATE API documentationhttps://vtugate.com/docs

## BOLTIV transaction flow

1. Customer authentication and Transaction PIN remain inside BOLTIV.
2. BOLTIV validates the current provider/catalog price before debiting the customer wallet.
3. BOLTIV creates an idempotent internal transaction and debits the wallet.
4. BOLTIV sends the purchase to VTUGATE with the BOLTIV reference.
5. VTUGATE response status is normalized into successful, pending, failed, refunded, or unknown.
6. Pending/unknown transactions are reconciled through `/api/v1/transactionstatus`.
7. Wallet finalization/refund is performed by BOLTIV exactly once.

## Important

The provider key must be a **live VTUGATE key** for production. Do not use the VTUGATE test key for BOLTIV production transactions.
