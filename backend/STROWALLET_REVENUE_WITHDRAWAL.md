# BOLTIV Revenue Wallet — Strowallet Withdrawals

Revenue-wallet withdrawals now use Strowallet's documented Nigerian bank-transfer API instead of Payscribe.

## Render environment

Required:

- `STROWALLET_PUBLIC_KEY` — live Strowallet public/API key
- `STROWALLET_BASE_URL=https://strowallet.com/api`
- `STROWALLET_MODE=live`
- `STROWALLET_SENDER_NAME=BOLTIV TECHNOLOGIES LIMITED`

The existing Strowallet customer funding variables remain in use for virtual-account funding.

## Withdrawal flow

1. Admin opens **Revenue & Withdrawals**.
2. BOLTIV loads banks from Strowallet.
3. Admin enters a Nigerian 10-digit account number.
4. BOLTIV verifies the account through Strowallet's `GET /banks/get-customer-name/` endpoint.
5. BOLTIV reserves the revenue balance.
6. BOLTIV sends the payout through Strowallet's `POST /banks/request/` endpoint using the returned name-enquiry reference.
7. If Strowallet immediately reports failure, BOLTIV reverses the reserved amount.
8. If the provider accepts the transfer without a final status, the withdrawal stays `processing`.

## Important provider limitation

Strowallet's current public API documentation documents bank-list retrieval, account-name lookup, and bank transfer, but does not document a separate outgoing-transfer status endpoint. Therefore BOLTIV does not invent a status-polling endpoint. Transfers that are accepted without a final status remain `processing` until a provider-confirmed result is available through a supported mechanism.

Strowallet currently advertises Fund Transfer and Developer API access, and its public fee page lists a ₦12 Fund Transfer fee.
