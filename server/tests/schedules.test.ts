import { describe, expect, it } from "vitest";
import { addMonths, nextRunDate, todayIn } from "../src/dates.js";
import { runDueSchedules } from "../src/services/schedules.js";
import { createBank, PIN, signUp } from "./helpers.js";

// The bank's clock starts at 2026-03-10 12:00 in Melbourne.

describe("date maths", () => {
  it("uses the bank's timezone for today", () => {
    // 14:30 UTC on the 9th is already the 10th in Melbourne.
    expect(todayIn("Australia/Melbourne", new Date("2026-03-09T14:30:00Z"))).toBe("2026-03-10");
  });

  it("keeps a monthly payment on its day, clamping in short months", () => {
    expect(addMonths("2026-01-31", 1, 31)).toBe("2026-02-28");
    expect(addMonths("2026-02-28", 1, 31)).toBe("2026-03-31");
    expect(addMonths("2028-01-31", 1, 31)).toBe("2028-02-29");
    expect(addMonths("2026-12-15", 1, 15)).toBe("2027-01-15");
    expect(nextRunDate("2026-03-10", "fortnightly", 10)).toBe("2026-03-24");
  });
});

describe("scheduled payments", () => {
  it("makes a future-dated transfer on its date and not before", async () => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");
    const res = await sai.post("/api/scheduled").send({
      kind: "transfer",
      fromAccountId: sai.everyday.id,
      toAccountId: sai.savings.id,
      amountCents: 250_00,
      frequency: "once",
      startDate: "2026-03-13",
    });
    expect(res.status).toBe(201);
    expect(res.body.scheduled.status).toBe("active");

    bank.advanceDays(2);
    await sai.signIn(); // the session timed out while the clock moved
    expect(runDueSchedules(bank.ctx)).toEqual({ paid: 0, failed: 0 });
    expect((await sai.balances()).everyday).toBe(2_500_00);

    bank.advanceDays(1);
    await sai.signIn();
    expect(runDueSchedules(bank.ctx)).toEqual({ paid: 1, failed: 0 });
    expect((await sai.balances()).everyday).toBe(2_250_00);

    const [schedule] = (await sai.agent.get("/api/scheduled")).body.scheduled;
    expect(schedule).toMatchObject({ status: "completed", runsCount: 1, lastRunStatus: "paid", nextRunDate: null });
  });

  it("repeats weekly, never pays twice for the same date, and stops at the end date", async () => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");
    await sai.post("/api/scheduled").send({
      kind: "transfer",
      fromAccountId: sai.everyday.id,
      toAccountId: sai.savings.id,
      amountCents: 100_00,
      frequency: "weekly",
      startDate: "2026-03-10",
      endDate: "2026-03-24",
    });
    // Starts today, so the first payment is immediate.
    expect((await sai.balances()).everyday).toBe(2_400_00);

    runDueSchedules(bank.ctx);
    runDueSchedules(bank.ctx);
    expect((await sai.balances()).everyday).toBe(2_400_00);

    bank.advanceDays(30); // the server was "off" across the 17th and 24th: both are caught up
    expect(runDueSchedules(bank.ctx)).toEqual({ paid: 2, failed: 0 });
    await sai.signIn();
    expect((await sai.balances()).everyday).toBe(2_200_00);

    const [schedule] = (await sai.agent.get("/api/scheduled")).body.scheduled;
    expect(schedule).toMatchObject({ status: "completed", runsCount: 3 });
  });

  it("records a failed run when there isn't enough money and carries on", async () => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");
    await sai.post("/api/scheduled").send({
      kind: "bill",
      fromAccountId: sai.everyday.id,
      billerCode: "67340",
      billerReference: "55120094",
      amountCents: 2_000_00,
      frequency: "weekly",
      startDate: "2026-03-11",
      pin: PIN,
    });

    bank.advanceDays(1);
    runDueSchedules(bank.ctx); // paid: 500 left
    bank.advanceDays(7);
    expect(runDueSchedules(bank.ctx)).toEqual({ paid: 0, failed: 1 });
    await sai.signIn();

    const [schedule] = (await sai.agent.get("/api/scheduled")).body.scheduled;
    expect(schedule).toMatchObject({
      status: "active",
      runsCount: 1,
      lastRunStatus: "failed",
      nextRunDate: "2026-03-25",
    });
    expect(schedule.lastError).toMatch(/enough money/);
    expect((await sai.balances()).everyday).toBe(500_00);
  });

  it("needs the PIN to schedule a payment to someone else, and rejects past dates", async () => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");
    const bill = {
      kind: "bill",
      fromAccountId: sai.everyday.id,
      billerCode: "67340",
      billerReference: "55120094",
      amountCents: 79_00,
      frequency: "monthly",
      startDate: "2026-03-20",
    };
    expect((await sai.post("/api/scheduled").send(bill)).status).toBe(403);
    expect((await sai.post("/api/scheduled").send({ ...bill, pin: PIN, startDate: "2026-03-09" })).status).toBe(400);
    expect((await sai.post("/api/scheduled").send({ ...bill, pin: PIN })).status).toBe(201);
  });

  it("a cancelled schedule makes no more payments", async () => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");
    const created = await sai.post("/api/scheduled").send({
      kind: "transfer",
      fromAccountId: sai.everyday.id,
      toAccountId: sai.savings.id,
      amountCents: 100_00,
      frequency: "weekly",
      startDate: "2026-03-12",
    });
    const cancel = await sai.post(`/api/scheduled/${created.body.scheduled.id}/cancel`);
    expect(cancel.body.scheduled.status).toBe("cancelled");

    bank.advanceDays(20);
    await sai.signIn();
    expect(runDueSchedules(bank.ctx)).toEqual({ paid: 0, failed: 0 });
    expect((await sai.balances()).everyday).toBe(2_500_00);
  });

  it("won't delete a payee that still has an active schedule", async () => {
    const bank = createBank();
    const sai = await signUp(bank, "Sai");
    const payee = await sai
      .post("/api/payees")
      .send({ nickname: "Landlord", accountName: "Acme", bsb: "063-112", number: "10457783" });
    const created = await sai.post("/api/scheduled").send({
      kind: "payment",
      fromAccountId: sai.everyday.id,
      payeeId: payee.body.payee.id,
      amountCents: 600_00,
      frequency: "fortnightly",
      startDate: "2026-03-15",
      pin: PIN,
    });
    const del = () => sai.agent.delete(`/api/payees/${payee.body.payee.id}`).set("X-Requested-With", "larkspur-web");

    expect((await del()).status).toBe(409);
    await sai.post(`/api/scheduled/${created.body.scheduled.id}/cancel`);
    expect((await del()).status).toBe(204);
    // The cancelled schedule still names who it was for.
    expect((await sai.agent.get("/api/scheduled")).body.scheduled[0].toLabel).toBe("Landlord");
  });
});
