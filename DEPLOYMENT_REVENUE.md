# BOLTIV Revenue Wallet + Admin-Only Withdrawals

## Money flow

1. A customer funds their BOLTIV customer wallet through Paystack.
2. When the customer successfully buys a VTU service, the purchase amount is recorded as a BOLTIV customer sale.
3. The same successful sale credits the **BOLTIV Revenue Wallet** in the admin dashboard.
4. VTUGATE remains the fulfilment provider and uses its own provider wallet/balance to deliver the service.
5. BOLTIV gross profit is calculated separately as customer price minus the recorded provider cost.
6. Only an authenticated admin can withdraw from the BOLTIV Revenue Wallet.

## Withdrawal provider

Revenue withdrawals use **Paystack Transfers**, because customer payments are collected through the BOLTIV Paystack integration. The backend verifies the Nigerian bank account, creates a Paystack transfer recipient, then initiates a transfer from the Paystack balance.

Paystack documents this flow as: resolve the account, create a transfer recipient, initiate the transfer, and monitor the transfer status. Keep the Paystack secret key server-side only.

## Required environment variables

```text
DATABASE_URL=...
PAYSTACK_SECRET_KEY=sk_test_...   # test first
VTU_API_BASE_URL=https://api.vtugate.com
VTU_API_KEY=...
FRONTEND_URL=https://thatsdeeko.github.io/boltiv
```

Use the live Paystack secret key only after test transfers and account resolution have been verified.

## Important

The old profit-only withdrawal endpoint is disabled. The supported withdrawal path is:

`Admin Dashboard -> Revenue & Withdraw -> BOLTIV Revenue Wallet -> Withdraw`

Customers do not have access to these admin endpoints.
