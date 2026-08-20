# BOLTIV Phase 3

Implemented without a second VTU provider, referral/agent system, or 2FA.

## Included
- Unified financial ledger for customer wallets, admin operating wallet, and BOLTIV revenue wallet.
- Opening-balance entries for existing accounts when the Phase 3 migration first runs.
- Ledger entries for wallet funding, VTU debits, refunds, admin wallet adjustments, revenue sales/refunds, and revenue withdrawals.
- Idempotent ledger references to prevent duplicate financial entries.
- Financial reconciliation endpoint and admin reconciliation screen.
- Automated reconciliation/alert job every 5 minutes plus an initial startup check.
- Platform alerts for ledger mismatches, funding mismatches, missing CheapDataHub configuration, high transaction failure rates, and pending transaction value.
- Optional critical alert email using the existing `RESEND_API_KEY` and `ADMIN_EMAIL` environment variables.
- Real 14-day analytics for users, transactions, sales, funding, refunds, and profit.
- 30-day service performance and top-customer analytics.
- Admin financial ledger viewer.

## New environment variables
None are required for Phase 3.

Critical alert emails use existing:
- `RESEND_API_KEY`
- `ADMIN_EMAIL`

If those are not configured, alerts remain visible in the admin panel and no email is sent.

## Explicitly not included
- Second VTU provider / failover
- Referral system
- Agent/reseller system
- Admin 2FA
- Native Android application


Reconciliation note: funding reconciliation compares successful Wallet Funding transactions against the financial ledger's wallet_funding entries. Legacy payments are not treated as a separate funding source.
