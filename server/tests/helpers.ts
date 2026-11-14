import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Context } from "../src/context.js";
import { openDb } from "../src/db.js";
import type { Account } from "../src/services/payments.js";

export const PASSWORD = "correct-horse-battery";
export const PIN = "4821";

/** A fresh in-memory bank with a clock the test controls. */
export function createBank(start = "2026-03-10T01:00:00Z") {
  const clock = { now: new Date(start) };
  const ctx: Context = {
    db: openDb(":memory:"),
    // Low bcrypt cost keeps the suite fast; production uses the default.
    config: loadConfig({ bcryptRounds: 4, jwtSecret: "test-secret", timezone: "Australia/Melbourne" }),
    now: () => clock.now,
  };
  const app = createApp(ctx);
  return {
    ctx,
    app,
    clock,
    advanceMinutes: (m: number) => (clock.now = new Date(clock.now.getTime() + m * 60_000)),
    advanceDays: (d: number) => (clock.now = new Date(clock.now.getTime() + d * 86_400_000)),
  };
}

export type Bank = ReturnType<typeof createBank>;

/** A signed-in customer: a supertest agent that keeps the session cookie and sends the CSRF header. */
export async function signUp(bank: Bank, name: string) {
  const agent = request.agent(bank.app);
  const email = `${name.toLowerCase()}@example.test`;
  const post = (url: string) => agent.post(url).set("X-Requested-With", "larkspur-web");
  const res = await post("/api/auth/register").send({ email, name, password: PASSWORD, pin: PIN });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  const accounts = (await agent.get("/api/accounts")).body.accounts as Account[];
  const everyday = accounts.find((a) => a.type === "everyday")!;
  const savings = accounts.find((a) => a.type === "savings")!;
  return {
    agent,
    post,
    email,
    userId: res.body.user.id as string,
    /** Signs in again, for tests that move the clock past the session timeout. */
    signIn: () => post("/api/auth/login").send({ email, password: PASSWORD }),
    everyday,
    savings,
    balances: async () => {
      const list = (await agent.get("/api/accounts")).body.accounts as Account[];
      return Object.fromEntries(list.map((a) => [a.type, a.balanceCents])) as Record<"everyday" | "savings", number>;
    },
  };
}
