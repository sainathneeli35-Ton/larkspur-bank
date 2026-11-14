import { randomUUID } from "node:crypto";
import type { Context } from "../context.js";
import { atomic, LARKSPUR_BSB, rows, SYSTEM } from "../db.js";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import { postTransaction } from "./ledger.js";

export interface Account {
  id: string;
  name: string;
  type: "everyday" | "savings";
  bsb: string;
  number: string;
  balanceCents: number;
}

export interface Payee {
  id: string;
  nickname: string;
  accountName: string;
  bsb: string;
  number: string;
}

export interface Receipt {
  transactionId: string;
  createdAt: string;
  replayed: boolean;
  amountCents: number;
  fromAccountId: string;
  to: string;
}

interface PaymentBase {
  fromAccountId: string;
  amountCents: number;
  description?: string;
  idempotencyKey?: string;
  scheduleId?: string;
}

const ACCOUNT_COLUMNS = `id, name, type, bsb, number, balance_cents AS balanceCents`;

export function listAccounts(ctx: Context, userId: string): Account[] {
  return rows<Account>(
    ctx.db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE user_id = ? ORDER BY type, created_at`).all(userId),
  );
}

/** Returns the account only if this user owns it. Someone else's account looks the same as a missing one. */
export function ownAccount(ctx: Context, userId: string, accountId: string): Account {
  const account = ctx.db
    .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ? AND user_id = ?`)
    .get(accountId, userId) as Account | undefined;
  if (!account) throw notFound("Account");
  return account;
}

export function checkAmount(ctx: Context, amountCents: number): void {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw badRequest("invalid_amount", "Enter an amount greater than zero.");
  }
  if (amountCents > ctx.config.maxPaymentCents) {
    throw unprocessable("over_limit", "That is more than the limit for a single payment.");
  }
}

const withNote = (label: string, note?: string) => (note?.trim() ? `${label}: ${note.trim()}` : label);

export function transferBetweenOwn(
  ctx: Context,
  userId: string,
  input: PaymentBase & { toAccountId: string },
): Receipt {
  checkAmount(ctx, input.amountCents);
  if (input.fromAccountId === input.toAccountId) {
    throw badRequest("same_account", "Choose two different accounts.");
  }
  const from = ownAccount(ctx, userId, input.fromAccountId);
  const to = ownAccount(ctx, userId, input.toAccountId);

  const result = postTransaction(ctx, {
    kind: "transfer",
    initiatedBy: userId,
    idempotencyKey: input.idempotencyKey,
    scheduleId: input.scheduleId,
    legs: [
      {
        accountId: from.id,
        amountCents: -input.amountCents,
        description: withNote(`Transfer to ${to.name}`, input.description),
      },
      {
        accountId: to.id,
        amountCents: input.amountCents,
        description: withNote(`Transfer from ${from.name}`, input.description),
      },
    ],
  });
  return { ...result, amountCents: input.amountCents, fromAccountId: from.id, to: to.name };
}

export function getPayee(ctx: Context, userId: string, payeeId: string): Payee {
  const payee = ctx.db
    .prepare(`SELECT id, nickname, account_name AS accountName, bsb, number FROM payees WHERE id = ? AND user_id = ?`)
    .get(payeeId, userId) as Payee | undefined;
  if (!payee) throw notFound("Payee");
  return payee;
}

export function payPayee(ctx: Context, userId: string, input: PaymentBase & { payeeId: string }): Receipt {
  checkAmount(ctx, input.amountCents);
  const from = ownAccount(ctx, userId, input.fromAccountId);
  const payee = getPayee(ctx, userId, input.payeeId);
  const payer = ctx.db.prepare("SELECT name FROM users WHERE id = ?").get(userId) as { name: string };

  // A payee at Larkspur is credited directly. Anyone else is paid through the clearing account.
  const internal = ctx.db
    .prepare("SELECT id FROM accounts WHERE bsb = ? AND number = ? AND type <> 'system'")
    .get(payee.bsb, payee.number) as { id: string } | undefined;
  if (internal?.id === from.id) throw badRequest("same_account", "That payee is the account you're paying from.");

  const result = postTransaction(ctx, {
    kind: "payment",
    initiatedBy: userId,
    idempotencyKey: input.idempotencyKey,
    scheduleId: input.scheduleId,
    legs: [
      {
        accountId: from.id,
        amountCents: -input.amountCents,
        description: withNote(`Payment to ${payee.nickname}`, input.description),
      },
      internal
        ? {
            accountId: internal.id,
            amountCents: input.amountCents,
            description: withNote(`Payment from ${payer.name}`, input.description),
          }
        : {
            accountId: SYSTEM.clearing,
            amountCents: input.amountCents,
            description: `Outbound to ${payee.bsb} ${payee.number}`,
          },
    ],
  });
  return { ...result, amountCents: input.amountCents, fromAccountId: from.id, to: payee.nickname };
}

export interface Biller {
  code: string;
  name: string;
}

export function listBillers(ctx: Context): Biller[] {
  return rows<Biller>(ctx.db.prepare("SELECT code, name FROM billers ORDER BY name").all());
}

export function getBiller(ctx: Context, code: string): Biller {
  const biller = ctx.db.prepare("SELECT code, name FROM billers WHERE code = ?").get(code) as Biller | undefined;
  if (!biller) throw unprocessable("unknown_biller", "No biller has that code.");
  return biller;
}

export function payBill(
  ctx: Context,
  userId: string,
  input: PaymentBase & { billerCode: string; reference: string },
): Receipt {
  checkAmount(ctx, input.amountCents);
  const from = ownAccount(ctx, userId, input.fromAccountId);
  const biller = getBiller(ctx, input.billerCode);

  const result = postTransaction(ctx, {
    kind: "bill",
    initiatedBy: userId,
    idempotencyKey: input.idempotencyKey,
    scheduleId: input.scheduleId,
    legs: [
      {
        accountId: from.id,
        amountCents: -input.amountCents,
        description: `Bill: ${biller.name} (ref ${input.reference})`,
      },
      {
        accountId: SYSTEM.clearing,
        amountCents: input.amountCents,
        description: `Biller ${biller.code} ref ${input.reference}`,
      },
    ],
  });
  return { ...result, amountCents: input.amountCents, fromAccountId: from.id, to: biller.name };
}

// ---------- Payees ----------

export function listPayees(ctx: Context, userId: string): Payee[] {
  return rows<Payee>(
    ctx.db
      .prepare(
        `SELECT id, nickname, account_name AS accountName, bsb, number FROM payees
       WHERE user_id = ? ORDER BY nickname COLLATE NOCASE`,
      )
      .all(userId),
  );
}

export function addPayee(
  ctx: Context,
  userId: string,
  input: { nickname: string; accountName: string; bsb: string; number: string },
): Payee {
  const { db } = ctx;
  const digits = input.bsb.replace(/\D/g, "");
  const bsb = `${digits.slice(0, 3)}-${digits.slice(3)}`;

  const match = db
    .prepare("SELECT user_id FROM accounts WHERE bsb = ? AND number = ? AND type <> 'system'")
    .get(bsb, input.number) as { user_id: string } | undefined;
  if (match?.user_id === userId) {
    throw badRequest("own_account", "That's one of your own accounts. Use a transfer between accounts instead.");
  }
  if (bsb === LARKSPUR_BSB && !match) {
    throw unprocessable("unknown_account", "No Larkspur account has that number. Check the details and try again.");
  }
  if (db.prepare("SELECT 1 FROM payees WHERE user_id = ? AND bsb = ? AND number = ?").get(userId, bsb, input.number)) {
    throw conflict("payee_exists", "You've already saved a payee with those account details.");
  }

  const payee: Payee = {
    id: randomUUID(),
    nickname: input.nickname.trim(),
    accountName: input.accountName.trim(),
    bsb,
    number: input.number,
  };
  db.prepare(
    `INSERT INTO payees (id, user_id, nickname, account_name, bsb, number, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(payee.id, userId, payee.nickname, payee.accountName, payee.bsb, payee.number, ctx.now().toISOString());
  return payee;
}

export function removePayee(ctx: Context, userId: string, payeeId: string): void {
  const { db } = ctx;
  getPayee(ctx, userId, payeeId);
  atomic(db, () => {
    const active = db.prepare("SELECT 1 FROM scheduled_payments WHERE payee_id = ? AND status = 'active'").get(payeeId);
    if (active) {
      throw conflict("payee_in_use", "Cancel the scheduled payments to this payee first.");
    }
    db.prepare("UPDATE scheduled_payments SET payee_id = NULL WHERE payee_id = ?").run(payeeId);
    db.prepare("DELETE FROM payees WHERE id = ?").run(payeeId);
  });
}

// ---------- History ----------

export interface HistoryFilters {
  accountId?: string;
  /** Matches text in the description. */
  q?: string;
  /** Inclusive calendar dates, YYYY-MM-DD, in the bank's timezone. */
  from?: string;
  to?: string;
  direction?: "in" | "out";
  /** The id of the last item on the previous page. */
  cursor?: number;
  limit?: number;
}

export interface HistoryItem {
  id: number;
  transactionId: string;
  accountId: string;
  accountName: string;
  kind: string;
  description: string;
  amountCents: number;
  balanceAfterCents: number;
  scheduled: boolean;
  createdAt: string;
}

/** Converts a local calendar date to the UTC instant it starts at in `timezone`. */
function startOfDayUtc(date: string, timezone: string): string {
  const guess = new Date(`${date}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" })
    .formatToParts(guess)
    .find((p) => p.type === "timeZoneName")!.value; // e.g. "GMT+11:00"
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(parts);
  const offsetMinutes = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return new Date(guess.getTime() - offsetMinutes * 60_000).toISOString();
}

export function listHistory(
  ctx: Context,
  userId: string,
  filters: HistoryFilters,
): { items: HistoryItem[]; nextCursor: number | null } {
  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);
  const where = ["a.user_id = ?"];
  const params: Array<string | number> = [userId];

  if (filters.accountId) {
    ownAccount(ctx, userId, filters.accountId);
    where.push("e.account_id = ?");
    params.push(filters.accountId);
  }
  if (filters.q?.trim()) {
    where.push("e.description LIKE ? ESCAPE '\\'");
    params.push(`%${filters.q.trim().replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (filters.from) {
    where.push("e.created_at >= ?");
    params.push(startOfDayUtc(filters.from, ctx.config.timezone));
  }
  if (filters.to) {
    const dayAfter = new Date(`${filters.to}T00:00:00Z`);
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
    where.push("e.created_at < ?");
    params.push(startOfDayUtc(dayAfter.toISOString().slice(0, 10), ctx.config.timezone));
  }
  if (filters.direction === "in") where.push("e.amount_cents > 0");
  if (filters.direction === "out") where.push("e.amount_cents < 0");
  if (filters.cursor) {
    where.push("e.id < ?");
    params.push(filters.cursor);
  }

  const found = rows<HistoryItem & { scheduled: number | boolean }>(
    ctx.db
      .prepare(
        `SELECT e.id, e.transaction_id AS transactionId, e.account_id AS accountId, a.name AS accountName,
              t.kind, e.description, e.amount_cents AS amountCents, e.balance_after_cents AS balanceAfterCents,
              t.schedule_id IS NOT NULL AS scheduled, e.created_at AS createdAt
       FROM entries e
       JOIN accounts a ON a.id = e.account_id
       JOIN transactions t ON t.id = e.transaction_id
       WHERE ${where.join(" AND ")}
       ORDER BY e.id DESC
       LIMIT ?`,
      )
      .all(...params, limit + 1),
  );

  const page = found.slice(0, limit).map((r) => ({ ...r, scheduled: Boolean(r.scheduled) }));
  return { items: page, nextCursor: found.length > limit ? page[page.length - 1]!.id : null };
}
