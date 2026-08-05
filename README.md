# WiFi Voucher

A simple WiFi billing & voucher generator website — Express backend with a flat
JSON-file "database" (same pattern as the landlink project), plain HTML/CSS/JS
frontend, Nunito Sans font, brand color `#6144f2`.

## Run it

```
start.bat
```
(or manually: `npm install` then `npm start`)

Then open http://localhost:4001

## What's included

- **Plans page** (`/index.html`) — browse plans, pay with mobile money or grab an instant demo voucher
- **Redeem page** (`/redeem.html`) — check a voucher's status or activate it
- **Admin panel** (`/generate.html`) — login (`admin` / `admin123`), view all
  plans, vouchers, transactions, and mobile money payment attempts, reset demo data

## Mobile money payments (ClickPesa)

Real payments are integrated directly against ClickPesa's REST API (no
third-party wrapper) — USSD push to M-Pesa, Tigo Pesa/Mixx, Airtel Money, or
HaloPesa. See `server/clickpesa.js`.

**Setup:**
1. Copy `.env.example` to `.env`.
2. Log into the [ClickPesa Merchant Dashboard](https://merchant.clickpesa.com) → Settings → Developers → your application, and fill in `CLICKPESA_CLIENT_ID` and `CLICKPESA_API_KEY`.
3. (Optional) If you've enabled request/webhook checksums on your ClickPesa app, also set `CLICKPESA_CHECKSUM_KEY`.
4. For production, register `https://yourdomain.com/api/webhooks/clickpesa` as an **Application Webhook** for `PAYMENT RECEIVED` and `PAYMENT FAILED` in the dashboard, so vouchers get issued the moment payment clears instead of waiting on the poll fallback.

**How it works:**
1. Customer picks a plan and taps "Pay with mobile money", enters their phone number.
2. Backend calls ClickPesa's `initiate-ussd-push-request` — the customer gets a USSD prompt on their phone to enter their mobile money PIN.
3. The frontend polls `GET /api/payments/:orderReference/status` every few seconds; the backend either receives ClickPesa's webhook or falls back to querying ClickPesa directly.
4. On confirmed success, the voucher is generated automatically and shown to the customer.

The old "Instant demo voucher" button is still there for quick testing without going through a real payment.

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | /api/plans | — | list plans |
| POST | /api/vouchers | — | instant demo voucher (no payment) |
| GET | /api/vouchers/:code | — | check a voucher's status |
| POST | /api/vouchers/:code/redeem | — | activate a voucher |
| POST | /api/payments/mobile-money | — | start a ClickPesa USSD push payment for a plan |
| GET | /api/payments/:orderReference/status | — | poll payment status; issues the voucher once paid |
| POST | /api/webhooks/clickpesa | — | ClickPesa → us: PAYMENT RECEIVED / PAYMENT FAILED |
| POST | /api/auth/login | — | admin login → JWT |
| GET | /api/admin/vouchers | admin | list all vouchers |
| GET | /api/admin/transactions | admin | list all transactions |
| GET | /api/admin/payments | admin | list all mobile money payment attempts |
| POST | /api/admin/plans | admin | create a plan |
| PATCH/DELETE | /api/admin/plans/:id | admin | edit/remove a plan |
| POST | /api/admin/reset-demo-data | admin | reset to seed data |

## Data

Everything is stored in `server/data.json`, created automatically on first
run and seeded with 4 plans (1 Hour / 1 Day / 1 Week / 1 Month) and one admin
account. No database server to install — same tradeoff as landlink: fast to
run anywhere, not meant for real production scale.

## Change the admin password

Edit `SEED_ADMIN` in `server/index.js` before first run, or add a
`PATCH /api/admin/...` route later if you want in-app password changes.
