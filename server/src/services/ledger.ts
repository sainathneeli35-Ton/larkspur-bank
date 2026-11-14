import { createHash, randomUUID } from "node:crypto";
import type { Context } from "../context.js";
import { atomic } from "../db.js";
import { AppError, conflict, unprocessable } from "../errors.js";

export type TransactionKind = "deposit" | "transfer" | "payment" | "bill";

export interface Leg {
  accountId: string;
  /** Positive credits the account, negative debits it. */
  amountCents: number;
  /** What the owner of this account sees in their history. */
  description: string;
}

export interface PostRequest {
  kind: TransactionKind;
  initiatedBy: string | null;
  legs: Leg[];
  /** Repeating a request with the same key returns the first result instead of moving money twice. */
  idempotencyKey?: string;
  scheduleId?: string;
}

export interface PostResult {
  transactionId: string;
  createdAt: string;
  /** True when this key was already used and nothing new was posted. */
  replayed: boolean;
}

export class InsufficientFundsError extends AppError {
  constructor() {
    super(422, "insufficient_funds", "There isn't enough money in that account.");
  }
}

function hashRequest(req: PostRequest): string {
  const legs = req.legs.map((l) => [l.accountId, l.amountCents]);
  return createHash("sha256")
    .update(JSON.stringify([req.kind, legs]))
    .digest("hex");
}

/**
 * Posts a balanced set of entries atomically.
 *
 * Everything happens in one BEGIN IMMEDIATE SQLite transaction (see `atomic`), which takes
 * the write lock up front: the balance check and the balance update can't interleave with another payment,
 * so two simultaneous payments can never both spend the same money.
 */
export function postTransaction(ctx: Context, req: PostRequest): PostResult {
  const { db } = ctx;

  if (req.legs.length < 2) throw new Error("A transaction needs at least two entries.");
  for (const leg of req.legs) {
    if (!Number.isSafeInteger(leg.amountCents) || leg.amountCents === 0) {
      throw new Error("Entry amounts must be non-zero whole cents.");
    }
  }
  if (req.legs.reduce((sum, l) => sum + l.amountCents, 0) !== 0) {
    throw new Error("Entries must sum to zero.");
  }

  const requestHash = hashRequest(req);

  return atomic(db, (): PostResult => {
    if (req.idempotencyKey) {
      const prior = db
        .prepare(
          `SELECT id, created_at, request_hash FROM transactions
           WHERE initiated_by IS ? AND idempotency_key = ?`,
        )
        .get(req.initiatedBy, req.idempotencyKey) as
        { id: string; created_at: string; request_hash: string } | undefined;
      if (prior) {
        if (prior.request_hash !== requestHash) {
          throw conflict("idempotency_key_reused", "That request key was already used for a different payment.");
        }
        return { transactionId: prior.id, createdAt: prior.created_at, replayed: true };
      }
    }

    const id = randomUUID();
    const createdAt = ctx.now().toISOString();
    db.prepare(
      `INSERT INTO transactions (id, kind, initiated_by, idempotency_key, request_hash, schedule_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, req.kind, req.initiatedBy, req.idempotencyKey ?? null, requestHash, req.scheduleId ?? null, createdAt);

    const readAccount = db.prepare("SELECT type, balance_cents FROM accounts WHERE id = ?");
    const setBalance = db.prepare("UPDATE accounts SET balance_cents = ? WHERE id = ?");
    const addEntry = db.prepare(
      `INSERT INTO entries (transaction_id, account_id, amount_cents, balance_after_cents, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    for (const leg of req.legs) {
      const account = readAccount.get(leg.accountId) as { type: string; balance_cents: number } | undefined;
      if (!account) throw unprocessable("unknown_account", "That account doesn't exist.");
      const balanceAfter = account.balance_cents + leg.amountCents;
      if (account.type !== "system" && balanceAfter < 0) throw new InsufficientFundsError();
      setBalance.run(balanceAfter, leg.accountId);
      addEntry.run(id, leg.accountId, leg.amountCents, balanceAfter, leg.description, createdAt);
    }
    return { transactionId: id, createdAt, replayed: false };
  });
}

/** Checks the books: every transaction nets to zero and every cached balance matches its entries. */
export function auditLedger(ctx: Context): {
  unbalancedTransactions: number;
  driftedAccounts: number;
  totalCents: number;
} {
  const { db } = ctx;
  const unbalanced = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (SELECT transaction_id FROM entries GROUP BY transaction_id HAVING SUM(amount_cents) <> 0)`,
    )
    .get() as { n: number };
  const drifted = db
    .prepare(
      `SELECT COUNT(*) AS n FROM accounts a
       WHERE a.balance_cents <> COALESCE((SELECT SUM(amount_cents) FROM entries e WHERE e.account_id = a.id), 0)`,
    )
    .get() as { n: number };
  const total = db.prepare("SELECT COALESCE(SUM(balance_cents), 0) AS n FROM accounts").get() as { n: number };
  return { unbalancedTransactions: unbalanced.n, driftedAccounts: drifted.n, totalCents: total.n };
}
