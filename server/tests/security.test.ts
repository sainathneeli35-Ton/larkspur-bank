import request from "supertest";
import { describe, expect, it } from "vitest";
import { createBank, PASSWORD, PIN, signUp } from "./helpers.js";

const csrf = { "X-Requested-With": "larkspur-web" };

describe("signing in", () => {
  it("requires a session for banking endpoints", async () => {
    const bank = createBank();
    expect((await request(bank.app).get("/api/accounts")).status).toBe(401);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");
    const wrong = await request(bank.app)
      .post("/api/auth/login")
      .set(csrf)
      .send({ email: sai.email, password: "nope-nope-nope" });
    const unknown = await request(bank.app)
      .post("/api/auth/login")
      .set(csrf)
      .send({ email: "ghost@example.test", password: "nope-nope-nope" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it("locks the account after five wrong passwords, then unlocks after 15 minutes", async () => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");
    const attempt = (password: string) =>
      request(bank.app).post("/api/auth/login").set(csrf).send({ email: sai.email, password });

    for (let i = 0; i < 5; i++) expect((await attempt("wrong-password")).status).toBe(401);
    expect((await attempt(PASSWORD)).status).toBe(423); // locked even with the right password

    bank.advanceMinutes(16);
    expect((await attempt(PASSWORD)).status).toBe(200);
  });

  it("ends the session after 15 minutes of inactivity, and activity keeps it alive", async () => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");

    bank.advanceMinutes(10);
    expect((await sai.agent.get("/api/accounts")).status).toBe(200); // renews the window
    bank.advanceMinutes(10);
    expect((await sai.agent.get("/api/accounts")).status).toBe(200);
    bank.advanceMinutes(16);
    expect((await sai.agent.get("/api/accounts")).status).toBe(401);
  });

  it("never stores or returns the password or PIN", async () => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");
    const row = bank.ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(sai.userId) as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
    expect(row.pin_hash).not.toBe(PIN);
    const me = await sai.agent.get("/api/me");
    expect(Object.keys(me.body.user).sort()).toEqual(["email", "id", "name"]);
  });

  it("sets the session cookie HttpOnly and SameSite=Strict", async () => {
    const bank = createBank();
    const res = await request(bank.app)
      .post("/api/auth/register")
      .set(csrf)
      .send({ email: "c@example.test", name: "C", password: PASSWORD, pin: PIN });
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it("rejects state-changing requests without the app's header", async () => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");
    const res = await sai.agent
      .post("/api/transfers")
      .send({ fromAccountId: sai.everyday.id, toAccountId: sai.savings.id, amountCents: 100 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("csrf");
  });
});

describe("payment PIN", () => {
  async function withPayee() {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");
    const payee = await sai
      .post("/api/payees")
      .send({ nickname: "Landlord", accountName: "Acme", bsb: "063-112", number: "10457783" });
    const pay = (pin: string) =>
      sai
        .post("/api/payments")
        .send({ fromAccountId: sai.everyday.id, payeeId: payee.body.payee.id, amountCents: 10_00, pin });
    return { bank, sai, pay };
  }

  it("blocks a payment with the wrong PIN", async () => {
    const { sai, pay } = await withPayee();
    const res = await pay("0000");
    expect(res.status).toBe(403);
    expect((await sai.balances()).everyday).toBe(2_500_00);
  });

  it("locks the PIN after three wrong attempts", async () => {
    const { bank, sai, pay } = await withPayee();
    for (let i = 0; i < 3; i++) expect((await pay("0000")).status).toBe(403);
    expect((await pay(PIN)).status).toBe(423);
    expect((await sai.balances()).everyday).toBe(2_500_00);

    bank.advanceMinutes(16);
    await sai.signIn(); // the session lapsed meanwhile
    expect((await pay(PIN)).status).toBe(201);
  });
});
