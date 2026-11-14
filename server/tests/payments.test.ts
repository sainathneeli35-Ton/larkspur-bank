import { describe, expect, it } from "vitest";
import { auditLedger } from "../src/services/ledger.js";
import { createBank, PIN, signUp } from "./helpers.js";

describe("transfers between your own accounts", () => {
  it("moves money and records both sides with running balances", async () => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");

    const res = await sai
      .post("/api/transfers")
      .send({
        fromAccountId: sai.everyday.id,
        toAccountId: sai.savings.id,
        amountCents: 150_00,
        description: "Rainy day",
      });
    expect(res.status).toBe(201);
    expect(await sai.balances()).toEqual({ everyday: 2_350_00, savings: 8_150_00 });

    const history = (await sai.agent.get("/api/transactions").query({ q: "Rainy" })).body.items;
    expect(history).toHaveLength(2);
    expect(history.map((h: any) => [h.accountName, h.amountCents, h.balanceAfterCents])).toEqual([
      ["Goal Saver", 150_00, 8_150_00],
      ["Everyday", -150_00, 2_350_00],
    ]);
  });

  it("refuses to overdraw and leaves balances untouched", async () => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");

    const res = await sai
      .post("/api/transfers")
      .send({ fromAccountId: sai.everyday.id, toAccountId: sai.savings.id, amountCents: 2_500_01 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("insufficient_funds");
    expect(await sai.balances()).toEqual({ everyday: 2_500_00, savings: 8_000_00 });
  });

  it.each([0, -5, 10.5, "100", 100_000_01])("rejects the amount %s", async (amountCents) => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");
    const res = await sai
      .post("/api/transfers")
      .send({ fromAccountId: sai.everyday.id, toAccountId: sai.savings.id, amountCents });
    expect([400, 422]).toContain(res.status);
    expect(await sai.balances()).toEqual({ everyday: 2_500_00, savings: 8_000_00 });
  });

  it("cannot move money out of someone else's account", async () => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");
    const mallory = await signUp(bank, "Mallory");

    const res = await mallory
      .post("/api/transfers")
      .send({ fromAccountId: sai.everyday.id, toAccountId: mallory.everyday.id, amountCents: 100_00 });
    expect(res.status).toBe(404);
    expect((await sai.balances()).everyday).toBe(2_500_00);

    const peek = await mallory.agent.get("/api/transactions").query({ accountId: sai.everyday.id });
    expect(peek.status).toBe(404);
  });
});

describe("idempotency", () => {
  it("a retried request with the same key moves money once", async () => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");
    const body = { fromAccountId: sai.everyday.id, toAccountId: sai.savings.id, amountCents: 200_00 };

    const first = await sai.post("/api/transfers").set("Idempotency-Key", "retry-key-0001").send(body);
    const second = await sai.post("/api/transfers").set("Idempotency-Key", "retry-key-0001").send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.receipt.transactionId).toBe(first.body.receipt.transactionId);
    expect(second.body.receipt.replayed).toBe(true);
    expect((await sai.balances()).everyday).toBe(2_300_00);
  });

  it("rejects a reused key on a different payment", async () => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");
    const body = { fromAccountId: sai.everyday.id, toAccountId: sai.savings.id, amountCents: 200_00 };

    await sai.post("/api/transfers").set("Idempotency-Key", "retry-key-0002").send(body);
    const res = await sai
      .post("/api/transfers")
      .set("Idempotency-Key", "retry-key-0002")
      .send({ ...body, amountCents: 999_00 });
    expect(res.status).toBe(409);
    expect((await sai.balances()).everyday).toBe(2_300_00);
  });
});

describe("paying someone", () => {
  it("credits another Larkspur customer and shows it in both histories", async () => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");
    const priya = await signUp(bank, "Priya");

    const payee = await sai
      .post("/api/payees")
      .send({ nickname: "Priya", accountName: "Priya", bsb: priya.everyday.bsb, number: priya.everyday.number });
    expect(payee.status).toBe(201);

    const res = await sai
      .post("/api/payments")
      .send({
        fromAccountId: sai.everyday.id,
        payeeId: payee.body.payee.id,
        amountCents: 42_50,
        description: "Lunch",
        pin: PIN,
      });
    expect(res.status).toBe(201);

    expect((await sai.balances()).everyday).toBe(2_457_50);
    expect((await priya.balances()).everyday).toBe(2_542_50);
    const received = (await priya.agent.get("/api/transactions").query({ direction: "in", q: "Lunch" })).body.items;
    expect(received[0].description).toBe("Payment from Sai: Lunch");
  });

  it("sends payments to other banks through the clearing account", async () => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");
    const payee = await sai
      .post("/api/payees")
      .send({ nickname: "Landlord", accountName: "Acme Property", bsb: "063-112", number: "10457783" });

    await sai
      .post("/api/payments")
      .send({ fromAccountId: sai.everyday.id, payeeId: payee.body.payee.id, amountCents: 600_00, pin: PIN });

    expect((await sai.balances()).everyday).toBe(1_900_00);
    const clearing = bank.ctx.db.prepare("SELECT balance_cents AS b FROM accounts WHERE id = 'sys_clearing'").get() as {
      b: number;
    };
    expect(clearing.b).toBe(600_00);
  });

  it("rejects a Larkspur payee whose account doesn't exist", async () => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");
    const res = await sai
      .post("/api/payees")
      .send({ nickname: "Typo", accountName: "Nobody", bsb: "990-417", number: "12345678" });
    expect(res.status).toBe(422);
  });

  it("pays a bill to a known biller and rejects an unknown one", async () => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");
    const bill = {
      fromAccountId: sai.everyday.id,
      billerCode: "20417",
      reference: "30077219",
      amountCents: 132_48,
      pin: PIN,
    };

    expect((await sai.post("/api/bills").send(bill)).status).toBe(201);
    expect((await sai.post("/api/bills").send({ ...bill, billerCode: "99999" })).status).toBe(422);
    expect((await sai.balances()).everyday).toBe(2_500_00 - 132_48);
  });
});

describe("the ledger", () => {
  it("stays balanced after a mix of activity, and no money is created or lost", async () => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");
    const priya = await signUp(bank, "Priya");
    const payee = await sai
      .post("/api/payees")
      .send({ nickname: "Priya", accountName: "Priya", bsb: priya.everyday.bsb, number: priya.everyday.number });

    await sai
      .post("/api/transfers")
      .send({ fromAccountId: sai.savings.id, toAccountId: sai.everyday.id, amountCents: 1_000_00 });
    await sai
      .post("/api/payments")
      .send({ fromAccountId: sai.everyday.id, payeeId: payee.body.payee.id, amountCents: 3_333_33, pin: PIN });
    await sai
      .post("/api/payments")
      .send({ fromAccountId: sai.everyday.id, payeeId: payee.body.payee.id, amountCents: 9_999_99, pin: PIN }); // fails
    await priya
      .post("/api/bills")
      .send({
        fromAccountId: priya.everyday.id,
        billerCode: "45093",
        reference: "88104523",
        amountCents: 45_00,
        pin: PIN,
      });

    // Every account, including the bank's own, nets to zero: money only ever moves.
    expect(auditLedger(bank.ctx)).toEqual({ unbalancedTransactions: 0, driftedAccounts: 0, totalCents: 0 });
  });

  it("does not allow history to be edited or deleted", () => {
    const bank = createBank();
    expect(() => bank.ctx.db.prepare("UPDATE entries SET amount_cents = 1").run()).not.toThrow(); // no rows yet
    return signUp(bank, "Sai").then(() => {
      expect(() => bank.ctx.db.prepare("UPDATE entries SET amount_cents = 1").run()).toThrow(/immutable/);
      expect(() => bank.ctx.db.prepare("DELETE FROM entries").run()).toThrow(/immutable/);
    });
  });
});

describe("transaction history", () => {
  it("filters by direction and date, and pages with a cursor", async () => {
    const bank = createBank("2026-03-10T01:00:00Z");
    const sai = await signUp(bank, "Sai");
    const move = (amountCents: number) =>
      sai.post("/api/transfers").send({ fromAccountId: sai.everyday.id, toAccountId: sai.savings.id, amountCents });

    await move(1_00);
    bank.advanceDays(1);
    await sai.signIn(); // the session timed out overnight
    await move(2_00);
    bank.advanceDays(1);
    await sai.signIn();
    await move(3_00);

    const everyday = { accountId: sai.everyday.id };
    const out = (await sai.agent.get("/api/transactions").query({ ...everyday, direction: "out" })).body.items;
    expect(out.map((i: any) => i.amountCents)).toEqual([-3_00, -2_00, -1_00]);

    const midDay = (
      await sai.agent.get("/api/transactions").query({ ...everyday, from: "2026-03-11", to: "2026-03-11" })
    ).body.items;
    expect(midDay.map((i: any) => i.amountCents)).toEqual([-2_00]);

    const page1 = (await sai.agent.get("/api/transactions").query({ ...everyday, limit: 2 })).body;
    expect(page1.items).toHaveLength(2);
    const page2 = (await sai.agent.get("/api/transactions").query({ ...everyday, limit: 2, cursor: page1.nextCursor }))
      .body;
    expect(page2.items.map((i: any) => i.description)).toEqual(["Transfer to Goal Saver", "Welcome deposit"]);
    expect(page2.nextCursor).toBeNull();
  });
});
