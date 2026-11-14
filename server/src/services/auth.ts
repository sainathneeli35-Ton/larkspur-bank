import { randomInt, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Context } from "../context.js";
import { atomic, LARKSPUR_BSB, SYSTEM } from "../db.js";
import { conflict, forbidden, locked, unauthorized } from "../errors.js";
import { postTransaction } from "./ledger.js";

export interface User {
  id: string;
  email: string;
  name: string;
}

interface UserRow extends User {
  password_hash: string;
  pin_hash: string;
  failed_logins: number;
  locked_until: string | null;
  failed_pins: number;
  pin_locked_until: string | null;
}

// Compared against when the email is unknown, so both cases take the same time.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

function newAccountNumber(ctx: Context): string {
  const exists = ctx.db.prepare("SELECT 1 FROM accounts WHERE bsb = ? AND number = ?");
  for (;;) {
    const number = String(randomInt(10_000_000, 100_000_000));
    if (!exists.get(LARKSPUR_BSB, number)) return number;
  }
}

export function openAccount(ctx: Context, userId: string, name: string, type: "everyday" | "savings"): string {
  const id = randomUUID();
  ctx.db
    .prepare(`INSERT INTO accounts (id, user_id, name, type, bsb, number, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, name, type, LARKSPUR_BSB, newAccountNumber(ctx), ctx.now().toISOString());
  return id;
}

/** Simulated money arriving from outside the bank (welcome balance, salary). */
export function deposit(ctx: Context, accountId: string, amountCents: number, description: string) {
  return postTransaction(ctx, {
    kind: "deposit",
    initiatedBy: null,
    legs: [
      { accountId: SYSTEM.funding, amountCents: -amountCents, description },
      { accountId, amountCents, description },
    ],
  });
}

export interface RegisterInput {
  email: string;
  name: string;
  password: string;
  pin: string;
}

export function register(ctx: Context, input: RegisterInput): User {
  const { db, config } = ctx;
  const email = input.email.trim().toLowerCase();
  // Hash before opening the transaction: bcrypt is slow and shouldn't hold the write lock.
  const passwordHash = bcrypt.hashSync(input.password, config.bcryptRounds);
  const pinHash = bcrypt.hashSync(input.pin, config.bcryptRounds);
  const id = randomUUID();

  atomic(db, () => {
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
      throw conflict("email_taken", "An account with that email already exists.");
    }
    db.prepare(
      `INSERT INTO users (id, email, name, password_hash, pin_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, email, input.name.trim(), passwordHash, pinHash, ctx.now().toISOString());

    const everyday = openAccount(ctx, id, "Everyday", "everyday");
    const savings = openAccount(ctx, id, "Goal Saver", "savings");
    deposit(ctx, everyday, 2_500_00, "Welcome deposit");
    deposit(ctx, savings, 8_000_00, "Welcome deposit");
  });

  return { id, email, name: input.name.trim() };
}

export function login(ctx: Context, emailInput: string, password: string): User {
  const { db, config } = ctx;
  const email = emailInput.trim().toLowerCase();
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
  const now = ctx.now();

  if (row?.locked_until && new Date(row.locked_until) > now) {
    throw locked("Too many failed sign-in attempts. Try again in a few minutes.");
  }

  const ok = bcrypt.compareSync(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) {
    if (row) {
      const failures = row.failed_logins + 1;
      const lockUntil =
        failures >= config.maxLoginAttempts
          ? new Date(now.getTime() + config.lockMinutes * 60_000).toISOString()
          : null;
      db.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?").run(
        lockUntil ? 0 : failures,
        lockUntil,
        row.id,
      );
    }
    // Same message either way, so the response doesn't reveal which emails are registered.
    throw unauthorized("That email or password isn't right.");
  }

  db.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?").run(row.id);
  return { id: row.id, email: row.email, name: row.name };
}

/** Payments to other people and to billers need the PIN, even inside a signed-in session. */
export function verifyPin(ctx: Context, userId: string, pin: string | undefined): void {
  const { db, config } = ctx;
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
  if (!row) throw unauthorized();
  const now = ctx.now();

  if (row.pin_locked_until && new Date(row.pin_locked_until) > now) {
    throw locked("Your PIN is locked after too many wrong attempts. Try again in a few minutes.");
  }
  if (!pin || !bcrypt.compareSync(pin, row.pin_hash)) {
    const failures = row.failed_pins + 1;
    const lockUntil =
      failures >= config.maxPinAttempts ? new Date(now.getTime() + config.lockMinutes * 60_000).toISOString() : null;
    db.prepare("UPDATE users SET failed_pins = ?, pin_locked_until = ? WHERE id = ?").run(
      lockUntil ? 0 : failures,
      lockUntil,
      row.id,
    );
    throw forbidden(
      "wrong_pin",
      lockUntil ? "Wrong PIN. Your PIN is now locked for a few minutes." : "That PIN isn't right.",
    );
  }
  if (row.failed_pins > 0) {
    db.prepare("UPDATE users SET failed_pins = 0, pin_locked_until = NULL WHERE id = ?").run(row.id);
  }
}

export function getUser(ctx: Context, id: string): User | undefined {
  return ctx.db.prepare("SELECT id, email, name FROM users WHERE id = ?").get(id) as User | undefined;
}

export interface Session {
  userId: string;
  /** Seconds since epoch. */
  expiresAt: number;
}

export function issueSession(ctx: Context, userId: string): string {
  const iat = Math.floor(ctx.now().getTime() / 1000);
  return jwt.sign({ sub: userId, iat, exp: iat + ctx.config.sessionMinutes * 60 }, ctx.config.jwtSecret, {
    algorithm: "HS256",
  });
}

export function readSession(ctx: Context, token: string | undefined): Session | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, ctx.config.jwtSecret, {
      algorithms: ["HS256"],
      clockTimestamp: Math.floor(ctx.now().getTime() / 1000),
    }) as jwt.JwtPayload;
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    return { userId: payload.sub, expiresAt: payload.exp };
  } catch {
    return null;
  }
}
