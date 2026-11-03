# Scalefox Hack'26

The existing site and Express API deploy together on Vercel. Registration and payment data is stored in Neon PostgreSQL; the SQLite files in `data/` are legacy local data and are not read by this application.

## Local development

1. Install dependencies and copy `.env.example` to `.env`.
2. Set `DATABASE_URL` to Neon's pooled URL, `DATABASE_URL_UNPOOLED` to its direct URL, and set a random `ADMIN_TOKEN` of at least 16 characters.
3. Keep `PAYMENT_MODE=mock` for local-only checkout simulation. Mock mode is rejected when `NODE_ENV=production`.
4. Run `npm run db:migrate` and then `npm start`.
5. Open http://localhost:3000. The registration page is `/` and the admin dashboard is `/admin.html`.
6. Run `npm test` to exercise registration, Razorpay verification, webhook, and failure cases using a disposable in-memory database double.

The migration command uses the direct, non-pooled connection. The app uses the pooled `DATABASE_URL` for request traffic. Migrations are versioned in `migrations/`; apply each new migration before deploying code that depends on it.

## Production environment variables

Configure these in the Vercel project settings for Production (and Preview only if you intend to accept test payments there):

| Variable | Required | Value |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Neon pooled PostgreSQL connection string (`-pooler` host), with TLS enabled |
| `ADMIN_TOKEN` | Yes | Long, random secret of at least 16 characters |
| `PAYMENT_MODE` | Yes | `razorpay` |
| `RAZORPAY_KEY_ID` | Yes | Razorpay test or live Key ID |
| `RAZORPAY_KEY_SECRET` | Yes | Matching Razorpay Key Secret |
| `RAZORPAY_WEBHOOK_SECRET` | Yes | Secret configured for the Razorpay webhook |
| `REG_OPEN` | No | Registration opening time in ISO 8601 format; defaults to `2026-11-01T00:00:00+05:30` |
| `REG_CLOSE` | No | Registration closing time in ISO 8601 format; defaults to `2026-12-20T23:59:59+05:30` |
| `ALLOWED_ORIGIN` | No | Set only when the frontend is hosted on another origin |

Vercel sets `NODE_ENV=production` for Production deployments. `DATABASE_URL_UNPOOLED` is only needed in the environment where you run migrations; do not use it for the app's serverless request pool. Never put database credentials, Razorpay secrets, or `ADMIN_TOKEN` in frontend files. The Razorpay Key ID is public and is returned to the browser only to initialize Razorpay Checkout.

## Neon schema setup and migrations

1. Create or select a Neon project and copy its pooled and direct connection strings.
2. Set the direct string as `DATABASE_URL_UNPOOLED` in your local migration environment and run:

   ```powershell
   npm run db:migrate
   ```

3. The migration runner applies numbered SQL files transactionally and records them in `schema_migrations`. Test migrations on a Neon development branch before applying them to the production branch.
4. On subsequent schema changes, run the migration against the intended Neon branch before deploying the matching application code.

The schema has `registrations` as the parent record, `team_members` linked by `registration_id`, and `payments` linked by `registration_id` (with each order/payment attempt recorded separately). `webhook_events` stores Razorpay event IDs for replay protection. Foreign keys cascade only when a registration is explicitly deleted; payment failures and abandoned checkouts do not delete registrations.

## Vercel deployment

1. Set the Vercel project Root Directory to `scalefox-hack` if the Git repository root is its parent folder.
2. Add the Production environment variables above. Select Razorpay test credentials first and set `PAYMENT_MODE=razorpay`.
3. Run the migrations using the direct Neon URL before promoting the application.
4. Deploy the project to Vercel. `api/[...path].js` routes API requests to the existing Express app; static pages continue to be served from `public/`.
5. In Razorpay Dashboard, add a webhook at `https://YOUR-DOMAIN/api/webhook/razorpay`, use the same value as `RAZORPAY_WEBHOOK_SECRET`, and enable `payment.captured`, `payment.failed`, `order.paid`, and `refund.processed`.
6. Make a Razorpay test payment and verify the registration, payment status, and admin dashboard before switching to live credentials.

The Node.js process reuses a small `pg` connection pool, attaches it to Vercel's function lifecycle helper when available, and limits the pool to one client in Vercel. The Neon pooled URL is intended for this serverless request traffic. `/healthz` (or `/api/healthz` on Vercel) reports a database error if Postgres is unreachable.

## Registration and payment behavior

- Server-defined prices remain Team: Rs 299 and Solo: Rs 99. The browser never supplies the amount.
- A registration, its team member names, and a pending payment row are committed before a Razorpay order is requested. An order-creation failure is recorded as a failed payment; the registration is retained.
- Abandoned checkout remains pending. Only a Razorpay-verified payment or a valid signed Razorpay webhook can mark a payment paid.
- The checkout signature is checked on the server, then the payment is fetched from Razorpay and matched against the stored order, amount, and currency. Webhook HMAC signatures, order ownership, amount, and currency are also checked.
- Razorpay event IDs and payment IDs are unique in the database, and updates run in transactions to make repeated callbacks and webhook deliveries safe.
- Mock checkout is only for local development and is rejected at production startup.

## Admin and endpoints

Open `/admin.html` and enter the `ADMIN_TOKEN` to use the protected admin API. The dashboard shows registration totals, payment statuses, revenue, and registration/team details. Never expose the bearer token or private admin API responses publicly.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/register` | Validate and persist a registration and pending payment, then create its order |
| POST | `/api/verify` | Verify a Razorpay checkout payment on the server |
| POST | `/api/webhook/razorpay` | Verify and process signed Razorpay events |
| GET | `/api/stats` | Public counts of paid teams and solo registrations |
| GET | `/api/admin/registrations` | Protected summary and registration list |
| GET | `/api/admin/registrations/:id` | Protected complete registration, team, and payment details |
| GET | `/api/admin/export.csv` | Protected CSV export (paid only by default; `?paid=0` includes all) |
| GET | `/healthz` locally; `/api/healthz` on Vercel | Database connectivity check |

The current form collects names (not email addresses or phone numbers) for non-leader team members. Those names are stored as related `team_members`; the leader's email, phone, and college remain on the registration. No new mandatory form fields have been added.
