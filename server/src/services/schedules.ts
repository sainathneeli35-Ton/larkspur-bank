import { randomUUID } from "node:crypto";
import type { Context } from "../context.js";
import { rows } from "../db.js";
import { type Frequency, isIsoDate, nextRunDate, todayIn } from "../dates.js";
import { AppError, badRequest, notFound } from "../errors.js";
import { checkAmount, getBiller, getPayee, ownAccount, payBill, payPayee, transferBetweenOwn } from "./payments.js";

export interface ScheduleInput {
  kind: "transfer" | "payment" | "bill";
  fromAccountId: string;
  toAccountId?: string;
  payeeId?: string;
  billerCode?: string;
  billerReference?: string;
  amountCents: number;
  description?: string;
  frequency: Frequency;
  startDate: string;
  endDate?: string;
}

export interface Schedule {
  id: string;
  kind: "transfer" | "payment" | "bill";
  fromAccountId: string;
  fromAccountName: string;
  toLabel: string;
  amountCents: number;
  description: string;
  frequency: Frequency;
  nextRunDate: string | null;
  endDate: string | null;
  status: "active" | "completed" | "cancelled";
  runsCount: number;
  lastRunDate: string | null;
  lastRunStatus: "paid" | "failed" | null;
  lastError: string | null;
}

interface ScheduleRow {
  id: string;
  user_id: string;
  kind: "transfer" | "payment" | "bill";
  from_account_id: string;
  to_account_id: string | null;
  payee_id: string | null;
  biller_code: string | null;
  biller_reference: string | null;
  amount_cents: number;
  description: string;
  frequency: Frequency;
  anchor_day: number;
  next_run_date: string | null;
  end_date: string | null;
}

const SELECT_SCHEDULE = `
  SELECT s.id, s.kind, s.from_account_id AS fromAccountId, a.name AS fromAccountName, s.to_label AS toLabel,
         s.amount_cents AS amountCents, s.description, s.frequency, s.next_run_date AS nextRunDate,
         s.end_date AS endDate, s.status, s.runs_count AS runsCount, s.last_run_date AS lastRunDate,
         s.last_run_status AS lastRunStatus, s.last_error AS lastError
  FROM scheduled_payments s JOIN accounts a ON a.id = s.from_account_id`;

export function listSchedules(ctx: Context, userId: string): Schedule[] {
  return rows<Schedule>(
    ctx.db
      .prepare(
        `${SELECT_SCHEDULE} WHERE s.user_id = ?
       ORDER BY s.status = 'active' DESC, COALESCE(s.next_run_date, s.last_run_date) , s.created_at`,
      )
      .all(userId),
  );
}

function getSchedule(ctx: Context, userId: string, id: string): Schedule {
  const row = ctx.db.prepare(`${SELECT_SCHEDULE} WHERE s.id = ? AND s.user_id = ?`).get(id, userId) as
    Schedule | undefined;
  if (!row) throw notFound("Scheduled payment");
  return row;
}

export function createSchedule(ctx: Context, userId: string, input: ScheduleInput): Schedule {
  const today = todayIn(ctx.config.timezone, ctx.now());
  checkAmount(ctx, input.amountCents);
  if (!isIsoDate(input.startDate)) throw badRequest("invalid_date", "Choose a valid start date.");
  if (input.startDate < today) throw badRequest("date_in_past", "The start date can't be in the past.");
  if (input.endDate !== undefined) {
    if (!isIsoDate(input.endDate)) throw badRequest("invalid_date", "Choose a valid end date.");
    if (input.endDate < input.startDate) throw badRequest("invalid_date", "The end date must be after the start date.");
    if (input.frequency === "once") throw badRequest("invalid_date", "A one-off payment doesn't have an end date.");
  }

  // Validate the destination now, so a schedule that could never run is rejected up front.
  ownAccount(ctx, userId, input.fromAccountId);
  let toLabel: string;
  if (input.kind === "transfer") {
    if (!input.toAccountId) throw badRequest("missing_destination", "Choose an account to transfer to.");
    if (input.toAccountId === input.fromAccountId) throw badRequest("same_account", "Choose two different accounts.");
    toLabel = ownAccount(ctx, userId, input.toAccountId).name;
  } else if (input.kind === "payment") {
    if (!input.payeeId) throw badRequest("missing_destination", "Choose a payee.");
    toLabel = getPayee(ctx, userId, input.payeeId).nickname;
  } else {
    if (!input.billerCode || !input.billerReference) {
      throw badRequest("missing_destination", "Enter the biller code and reference.");
    }
    toLabel = getBiller(ctx, input.billerCode).name;
  }

  const id = randomUUID();
  ctx.db
    .prepare(
      `INSERT INTO scheduled_payments
         (id, user_id, kind, from_account_id, to_account_id, payee_id, biller_code, biller_reference, to_label,
          amount_cents, description, frequency, anchor_day, next_run_date, end_date, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    )
    .run(
      id,
      userId,
      input.kind,
      input.fromAccountId,
      input.kind === "transfer" ? (input.toAccountId ?? null) : null,
      input.kind === "payment" ? (input.payeeId ?? null) : null,
      input.kind === "bill" ? (input.billerCode ?? null) : null,
      input.kind === "bill" ? (input.billerReference ?? null) : null,
      toLabel,
      input.amountCents,
      input.description?.trim() ?? "",
      input.frequency,
      Number(input.startDate.slice(8, 10)),
      input.startDate,
      input.endDate ?? null,
      ctx.now().toISOString(),
    );

  // A schedule starting today makes its first payment straight away.
  if (input.startDate === today) runDueSchedules(ctx, id);
  return getSchedule(ctx, userId, id);
}

export function cancelSchedule(ctx: Context, userId: string, id: string): Schedule {
  const schedule = getSchedule(ctx, userId, id);
  if (schedule.status !== "active") throw badRequest("not_active", "That scheduled payment has already finished.");
  ctx.db.prepare("UPDATE scheduled_payments SET status = 'cancelled', next_run_date = NULL WHERE id = ?").run(id);
  return getSchedule(ctx, userId, id);
}

function execute(ctx: Context, row: ScheduleRow, runDate: string): void {
  const base = {
    fromAccountId: row.from_account_id,
    amountCents: row.amount_cents,
    description: row.description,
    scheduleId: row.id,
    // One payment per schedule per date, even if the scheduler crashes mid-run and retries.
    idempotencyKey: `schedule:${row.id}:${runDate}`,
  };
  if (row.kind === "transfer") transferBetweenOwn(ctx, row.user_id, { ...base, toAccountId: row.to_account_id! });
  else if (row.kind === "payment") payPayee(ctx, row.user_id, { ...base, payeeId: row.payee_id! });
  else payBill(ctx, row.user_id, { ...base, billerCode: row.biller_code!, reference: row.biller_reference! });
}

/**
 * Makes every scheduled payment that is due. Safe to call as often as you like.
 * Runs missed while the server was off are caught up one date at a time.
 */
export function runDueSchedules(ctx: Context, onlyId?: string): { paid: number; failed: number } {
  const { db } = ctx;
  const today = todayIn(ctx.config.timezone, ctx.now());
  const due = rows<ScheduleRow>(
    db
      .prepare(
        `SELECT * FROM scheduled_payments
       WHERE status = 'active' AND next_run_date <= ? AND (? IS NULL OR id = ?)
       ORDER BY next_run_date, created_at`,
      )
      .all(today, onlyId ?? null, onlyId ?? null),
  );

  const record = db.prepare(
    `UPDATE scheduled_payments
     SET runs_count = runs_count + ?, last_run_date = ?, last_run_status = ?, last_error = ?,
         next_run_date = ?, status = ?
     WHERE id = ?`,
  );

  let paid = 0;
  let failed = 0;
  for (const row of due) {
    let runDate = row.next_run_date;
    while (runDate && runDate <= today) {
      let error: string | null = null;
      try {
        execute(ctx, row, runDate);
        paid++;
      } catch (err) {
        failed++;
        error = err instanceof AppError ? err.message : "Something went wrong making this payment.";
        if (!(err instanceof AppError)) console.error(`Scheduled payment ${row.id} failed`, err);
      }
      let next = nextRunDate(runDate, row.frequency, row.anchor_day);
      if (next && row.end_date && next > row.end_date) next = null;
      record.run(error ? 0 : 1, runDate, error ? "failed" : "paid", error, next, next ? "active" : "completed", row.id);
      runDate = next;
    }
  }
  return { paid, failed };
}
