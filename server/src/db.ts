// Node's built-in SQLite driver: no native module to compile on install.
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/** Fictional BSB for every Larkspur account. */
export const LARKSPUR_BSB = "990-417";

/** Internal accounts the bank itself owns. They are the other side of money entering or leaving. */
export const SYSTEM = {
  /** Funds simulated deposits such as the welcome balance and salary. */
  funding: "sys_funding",
  /** Receives payments to other banks and to billers. */
  clearing: "sys_clearing",
} as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name            TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  pin_hash        TEXT NOT NULL,
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  failed_pins     INTEGER NOT NULL DEFAULT 0,
  pin_locked_until TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT REFERENCES users(id),
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('everyday', 'savings', 'system')),
  bsb           TEXT NOT NULL,
  number        TEXT NOT NULL,
  -- Cached balance. Always equals the sum of this account's entries; customer accounts cannot go negative.
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (type = 'system' OR balance_cents >= 0),
  created_at    TEXT NOT NULL,
  UNIQUE (bsb, number)
);
CREATE INDEX IF NOT EXISTS accounts_user ON accounts(user_id);

-- One row per movement of money. Its entries always sum to zero.
CREATE TABLE IF NOT EXISTS transactions (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('deposit', 'transfer', 'payment', 'bill')),
  initiated_by    TEXT REFERENCES users(id),
  idempotency_key TEXT,
  request_hash    TEXT,
  schedule_id     TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (initiated_by, idempotency_key)
);

CREATE TABLE IF NOT EXISTS entries (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id      TEXT NOT NULL REFERENCES transactions(id),
  account_id          TEXT NOT NULL REFERENCES accounts(id),
  -- Positive is money in, negative is money out.
  amount_cents        INTEGER NOT NULL CHECK (amount_cents <> 0),
  balance_after_cents INTEGER NOT NULL,
  description         TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_account ON entries(account_id, id DESC);
CREATE INDEX IF NOT EXISTS entries_transaction ON entries(transaction_id);

-- The ledger is append-only: history is corrected with new entries, never edited.
CREATE TRIGGER IF NOT EXISTS entries_no_update BEFORE UPDATE ON entries
BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS entries_no_delete BEFORE DELETE ON entries
BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;

CREATE TABLE IF NOT EXISTS payees (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  nickname     TEXT NOT NULL,
  account_name TEXT NOT NULL,
  bsb          TEXT NOT NULL,
  number       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (user_id, bsb, number)
);

CREATE TABLE IF NOT EXISTS billers (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_payments (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  kind            TEXT NOT NULL CHECK (kind IN ('transfer', 'payment', 'bill')),
  from_account_id TEXT NOT NULL REFERENCES accounts(id),
  to_account_id   TEXT REFERENCES accounts(id),
  payee_id        TEXT REFERENCES payees(id),
  biller_code     TEXT REFERENCES billers(code),
  biller_reference TEXT,
  -- Who the money goes to, kept as text so it still reads correctly if the payee is later removed.
  to_label        TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  description     TEXT NOT NULL,
  frequency       TEXT NOT NULL CHECK (frequency IN ('once', 'weekly', 'fortnightly', 'monthly')),
  anchor_day      INTEGER NOT NULL,
  next_run_date   TEXT,
  end_date        TEXT,
  status          TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
  runs_count      INTEGER NOT NULL DEFAULT 0,
  last_run_date   TEXT,
  last_run_status TEXT CHECK (last_run_status IN ('paid', 'failed')),
  last_error      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scheduled_due ON scheduled_payments(status, next_run_date);
`;

const BILLERS: Array<[string, string]> = [
  ["20417", "Yarra Bend Energy"],
  ["31882", "Southern Cross Water"],
  ["45093", "Koala Mobile"],
  ["58126", "Merri Creek City Council"],
  ["67340", "Bluegum Internet"],
];

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);

  const now = new Date().toISOString();
  const addSystem = db.prepare(
    `INSERT OR IGNORE INTO accounts (id, user_id, name, type, bsb, number, created_at)
     VALUES (?, NULL, ?, 'system', '000-000', ?, ?)`,
  );
  addSystem.run(SYSTEM.funding, "Deposit funding", "00000001", now);
  addSystem.run(SYSTEM.clearing, "External clearing", "00000002", now);

  const addBiller = db.prepare("INSERT OR IGNORE INTO billers (code, name) VALUES (?, ?)");
  for (const [code, name] of BILLERS) addBiller.run(code, name);
  return db;
}

const depths = new WeakMap<Db, number>();

/**
 * Runs `fn` atomically: everything it writes is committed together, or nothing is.
 *
 * The outermost call opens the transaction with BEGIN IMMEDIATE, taking the write lock
 * before anything is read. Nested calls become savepoints, so an inner failure that the
 * caller handles undoes only the inner work.
 */
export function atomic<T>(db: Db, fn: () => T): T {
  const depth = depths.get(db) ?? 0;
  const savepoint = `sp_${depth}`;
  db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
  depths.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    throw err;
  } finally {
    depths.set(db, depth);
  }
}

/** Types the rows a query returns. */
export const rows = <T>(result: unknown[]): T[] => result as T[];
