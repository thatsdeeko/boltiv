# BOLTIV Flutterwave Cash-Flow Reconciliation Fix

## What this fixes

BOLTIV customer wallet funding is collected by Flutterwave. When a customer later buys airtime/data/another VTU service, BOLTIV debits the customer's internal wallet and VTUGATE debits BOLTIV's provider float. The service purchase is **not a second Flutterwave collection**.

The application therefore must not create a new Flutterwave transfer merely because a VTU sale succeeded. Doing that would risk double-counting the customer's money.

This release adds an admin-side Flutterwave reconciliation view that reads:

- NGN available and ledger balance from Flutterwave
- successful customer collections for a selected period
- settlement gross/net amounts and settlement statuses
- recent collection references and settlement references

Flutterwave's collection/settlement system is the source of truth for actual cash. BOLTIV's `admin_revenue_wallets` and `admin_revenue_ledger` remain the internal sales/accounting ledger.

## Admin endpoint

`GET /api/admin/flutterwave/reconciliation`

Optional query parameters:

- `from=YYYY-MM-DD`
- `to=YYYY-MM-DD`

Defaults to the previous 30 days through today.

## Important

Do not manually credit the Revenue Wallet to represent cash. Do not create a second Flutterwave transfer for an already-collected customer deposit. Successful Flutterwave collections are settled according to the merchant's Flutterwave settlement configuration and schedule.

Use the Flutterwave dashboard for actual settlement/withdrawal of collected funds. The BOLTIV reconciliation page is for matching the application's internal accounting with Flutterwave's real cash/settlement records.
