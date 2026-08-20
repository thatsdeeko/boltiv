# BOLTIV transaction receipt fix

Fixed Airtime and Data transaction details so Network and Data Plan are populated from all supported metadata locations, including pricing.network and pricing.plan.

Backend `/api/transactions` now exposes normalized `phone`, `network`, and `plan` fields. Transaction history uses those normalized values. The receipt detail route also reads `pricing.network`.
