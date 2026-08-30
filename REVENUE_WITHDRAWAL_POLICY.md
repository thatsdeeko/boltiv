# BOLTIV Revenue Withdrawal Policy

BOLTIV revenue withdrawals are initiated by an authenticated administrator from the BOLTIV admin dashboard and executed through Flutterwave's configured NGN transfer API.

The application:
- verifies the destination bank account with Flutterwave;
- reserves the requested amount from `admin_revenue_wallets`;
- records an immutable withdrawal ledger entry;
- creates a unique Flutterwave transfer reference;
- stores the Flutterwave transfer ID/status;
- restores the reserved amount automatically if Flutterwave rejects/fails the transfer; and
- supports manual status refresh for pending transfers.

The Revenue Wallet remains an accounting ledger. The actual cash movement is performed by Flutterwave. Administrators must not manually edit revenue balances or duplicate a withdrawal that is already pending.
