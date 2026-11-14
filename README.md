# Larkspur Bank

A full-stack demonstration banking app. Customers sign in, see their accounts, move money
between them, pay other people and billers, search their history, and schedule one-off or
repeating payments.

Larkspur is a fictional bank and all money is simulated. It is a portfolio project, not a
product: see [Limits](#limits) for what a real bank would need on top.

| | |
|---|---|
| **API** | Node.js, TypeScript, Express 5, SQLite (Node's built-in `node:sqlite`), Zod |
| **Web** | React 19, TypeScript, Vite, React Router, hand-written CSS |
| **Tests** | Vitest and Supertest, 34 tests against an in-memory database |

## Run it

Needs Node.js 22.13 or newer. There are no native modules to compile.

```bash
npm install        # root tooling
npm run setup      # installs server/ and web/
npm run seed       # two demo customers with six weeks of history
npm run dev        # API on :4000, web app on http://localhost:5173
```

Sign in as `alex@larkspur.test` or `priya@larkspur.test`, password `demo-password-1`,
payment PIN `1234`. Or open a new account: it starts with a simulated welcome deposit.

Open the two demo customers in separate browser profiles to watch a payment from Alex
arrive in Priya's account.

```bash
npm test           # run the test suite
npm run typecheck  # typecheck server and web
npm run build && npm start   # production-style: the API serves the built web app on :4000
```

## What it does

- **Accounts**: an Everyday and a Goal Saver account per customer, each with a BSB and account number.
- **Transfers** between your own accounts, instantly.
- **Pay someone**: save a payee by BSB and account number. Payees at Larkspur are credited
  straight away; payees at other banks are paid through a clearing account.
- **Bill payments** by biller code and reference number.
- **Transaction history** with running balance, text search, money in/out and date filters,
  and cursor pagination.
- **Scheduled payments**: on a future date, or repeating weekly, fortnightly or monthly,
  with an optional end date. Each can be cancelled.
- **Security**: password sign-in, a PIN to confirm money leaving to someone else, lockouts
  after repeated wrong attempts, and automatic sign-out after inactivity.

## How the money works

These are the design decisions worth reading the code for.

**Money is whole cents.** Amounts are integers end to end. The web app parses what the
customer types with string handling, never `parseFloat`, so `0.1 + 0.2` problems can't occur.

**Double-entry ledger** (`server/src/services/ledger.ts`). Every movement is one
`transactions` row with two or more `entries` that sum to zero: a debit on one account and a
credit on another. Money arriving from or leaving to the outside world moves against the
bank's own system accounts, so the total across all accounts is always exactly zero. A test
asserts this after a mix of successful and failed payments.

**Atomic and race-free.** Each posting runs in a single `BEGIN IMMEDIATE` SQLite transaction,
which takes the write lock before reading the balance. The balance check and the update can't
interleave with another payment, so the same money can't be spent twice. A `CHECK` constraint
on customer balances is a second line of defence.

**Append-only history.** Database triggers reject any `UPDATE` or `DELETE` on `entries`.
Each entry stores the balance after it, which gives the history its running balance.

**Idempotent payments.** The web app creates an `Idempotency-Key` when the customer reaches
the review screen and sends it with the payment. Pressing Confirm twice, or retrying after a
dropped connection, returns the original receipt instead of paying again. Reusing a key for
a different payment is rejected with `409`.

**Scheduled payments** (`server/src/services/schedules.ts`). A sweep runs every minute and at
startup. Each run uses the key `schedule:<id>:<date>`, so a crash mid-sweep can't double-pay,
and runs missed while the server was off are caught up date by date. A run that fails for
lack of funds is recorded on the schedule and shown to the customer; the schedule carries
on. Monthly payments keep their day of the month and clamp in short months (the 31st runs on
28 Feb, then returns to 31 Mar). "Today" is decided in the bank's timezone, not UTC.

## Security

| Concern | Approach |
|---|---|
| Passwords and PINs | bcrypt hashes only; never returned by the API |
| Sessions | Signed JWT in an `HttpOnly`, `SameSite=Strict` cookie; 15-minute sliding expiry |
| Inactivity | The web app warns at 14 minutes idle and signs out at 15 |
| Brute force | Sign-in locks for 15 minutes after 5 wrong passwords; the PIN after 3 |
| Account enumeration | A wrong password and an unknown email get the identical response |
| Step-up | Payments and schedules to other people or billers need the PIN |
| Authorisation | Every query is scoped to the signed-in customer; another customer's account returns `404` |
| CSRF | `SameSite=Strict` cookie plus a required custom header on state-changing requests |
| Input | Every request body and query is validated with Zod; SQL is parameterised throughout |
| Headers | Helmet defaults, including a Content Security Policy |

## API

All routes are under `/api`. State-changing requests need the header
`X-Requested-With: larkspur-web`. Errors look like `{ "error": { "code", "message" } }`.

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register`, `/auth/login`, `/auth/logout` | |
| GET | `/me` | Signed-in customer and session length |
| GET | `/accounts` | |
| GET | `/transactions` | `accountId`, `q`, `from`, `to`, `direction`, `cursor`, `limit` |
| POST | `/transfers` | Between own accounts. Accepts `Idempotency-Key` |
| POST | `/payments` | To a saved payee. Needs `pin`. Accepts `Idempotency-Key` |
| POST | `/bills` | To a biller. Needs `pin`. Accepts `Idempotency-Key` |
| GET, POST | `/payees` | |
| DELETE | `/payees/:id` | Refused while an active schedule uses the payee |
| GET | `/billers` | |
| GET, POST | `/scheduled` | `pin` needed unless it is a transfer between own accounts |
| POST | `/scheduled/:id/cancel` | |

## Layout

```
server/
  src/
    app.ts              routes, validation, error handling
    db.ts               schema and system accounts
    dates.ts            calendar-date maths for schedules
    services/
      ledger.ts         double-entry posting, idempotency, audit
      auth.ts           registration, sign-in, PIN, sessions
      payments.ts       transfers, payees, bills, history
      schedules.ts      scheduled payments and the sweep
    seed.ts             demo data
  tests/                payments, security and schedule tests
web/
  src/
    api.ts              typed API client
    session.tsx         sign-in state and inactivity timeout
    pages/              Home, Account, Pay, Payees, Scheduled, SignIn
```

## Limits

Deliberately out of scope, and good next steps:

- A single SQLite file and one server process. A real system would use PostgreSQL with
  row-level locking and run the scheduler as a separate worker with a lease.
- No daily payment limits, payee confirmation (name matching), or fraud checks.
- No multi-factor authentication, password reset, or device management.
- Payments to other banks stop at the clearing account; there is no real settlement.
- No audit log of sign-ins or administrative actions, and no rate limiting by IP address.
