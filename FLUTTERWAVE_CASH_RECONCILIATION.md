# Flutterwave Cash & Settlement Reconciliation

This patch does **not** transfer the BOLTIV Revenue Wallet to Flutterwave.

BOLTIV customer wallet funding is the Flutterwave collection. A later airtime/data purchase is an internal customer-wallet debit and should not create a second Flutterwave collection.

The admin reconciliation endpoint:

`GET /api/admin/flutterwave/reconciliation`

compares the last 30 days of:

- Flutterwave NGN available and ledger balances (`/balances`)
- successful NGN collections (`/transactions`)
- Flutterwave settlements (`/settlements`)
- BOLTIV successful `Wallet Funding` transactions

It also attempts to match Flutterwave collection references to BOLTIV wallet-funding provider references and flags unmatched collections.

## Important

The figures are reconciliation evidence, not permission to manufacture a transfer. Flutterwave states that collected funds appear in the collection balance until settlement; completed settlements are delivered to the configured bank account or F4B wallet. See Flutterwave settlement documentation for the authoritative settlement state.
