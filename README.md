# Scalefox Hack'26 backend

A small Node server that serves the event website, takes registrations, collects payment through Razorpay and gives you an admin page.

- Team of 3-4: Rs 299. Solo: Rs 99. Prices are set in `server.js` (`PLANS`), never by the browser.
- Registrations are stored in a SQLite file (`data/registrations.db`).
- A registration counts as paid only after the server verifies Razorpay's signature (and, as a backup, the Razorpay webhook).

## 1. Try it on your computer (no Razorpay needed)

```bash
npm install
cp .env.example .env
```

In `.env` set:

```
PAYMENT_MODE=mock
ADMIN_TOKEN=any-long-random-string-16-chars-or-more
REG_OPEN=2026-01-01T00:00:00+05:30
```

Then `npm start` and open http://localhost:3000. The form runs the whole flow with a fake payment. Open http://localhost:3000/admin.html and enter your admin token to see the saved registration.

Never run real registrations in mock mode.

## 2. Go live with real payments

1. Create a Razorpay account and finish KYC. Test keys work immediately; live keys need KYC.
2. In Razorpay Dashboard, go to Account & Settings, API Keys, and copy the Key Id and Key Secret.
3. Deploy this folder to a host that runs Node and keeps a disk (Render, Railway, a VPS). SQLite needs a persistent disk. On Render add a Disk and set `DB_PATH=/var/data/registrations.db`.
4. Set these environment variables on the host (see `.env.example`):
   `PAYMENT_MODE=razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `ADMIN_TOKEN`, `DB_PATH`.
5. In Razorpay Dashboard, go to Webhooks, add:
   - URL: `https://YOUR-DOMAIN/api/webhook/razorpay`
   - Secret: the same value as `RAZORPAY_WEBHOOK_SECRET`
   - Events: `payment.captured` and `order.paid`
6. Make one Rs 99 test payment with test keys, check it in `/admin.html`, then switch to live keys.

The webhook matters: if a student pays and then closes the tab before the browser confirms, the webhook still marks them paid.

## Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| POST | `/api/register` | Validates the form, saves a pending row, creates a Razorpay order |
| POST | `/api/verify` | Checks Razorpay's signature and marks the registration paid |
| POST | `/api/webhook/razorpay` | Razorpay server-to-server confirmation |
| GET | `/api/stats` | Public count of paid teams and solo entrants |
| GET | `/api/admin/registrations` | All registrations (needs `Authorization: Bearer ADMIN_TOKEN`) |
| GET | `/api/admin/export.csv` | CSV download, paid only (add `?paid=0` for everyone) |

## Things to know

- Registration is open only between `REG_OPEN` and `REG_CLOSE` (default 1 Nov to 20 Dec 2026, India time).
- The same email or phone cannot pay twice.
- Back up `registrations.db` regularly. It is your only copy of the data.
- You still need to publish a refund and cancellation policy, privacy policy and terms. Razorpay asks for them on your site before approving live payments.
- This server sends no emails. Use the CSV or add a mail step (for example Resend or Brevo) inside `finalizePaid` in `server.js`.
