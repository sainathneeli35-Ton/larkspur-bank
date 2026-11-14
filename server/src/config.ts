import { randomBytes } from "node:crypto";

export interface Config {
  port: number;
  dbPath: string;
  jwtSecret: string;
  /** Sessions end after this much inactivity. */
  sessionMinutes: number;
  /** IANA timezone used to decide what "today" is for scheduled payments. */
  timezone: string;
  bcryptRounds: number;
  maxLoginAttempts: number;
  maxPinAttempts: number;
  lockMinutes: number;
  /** Largest single payment, in cents. */
  maxPaymentCents: number;
  secureCookies: boolean;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = process.env;
  if (env.NODE_ENV === "production" && !env.JWT_SECRET) {
    throw new Error("JWT_SECRET must be set in production.");
  }
  return {
    port: Number(env.PORT ?? 4000),
    dbPath: env.DB_PATH ?? "larkspur.db",
    // Without JWT_SECRET a random one is used, so sessions end when the server restarts.
    jwtSecret: env.JWT_SECRET ?? randomBytes(32).toString("hex"),
    sessionMinutes: Number(env.SESSION_MINUTES ?? 15),
    timezone: env.BANK_TIMEZONE ?? "Australia/Melbourne",
    bcryptRounds: Number(env.BCRYPT_ROUNDS ?? 12),
    maxLoginAttempts: 5,
    maxPinAttempts: 3,
    lockMinutes: 15,
    maxPaymentCents: 100_000_00,
    secureCookies: env.NODE_ENV === "production",
    ...overrides,
  };
}
