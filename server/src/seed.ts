/**
 * Fills a fresh database with two demo customers and a few weeks of history.
 * Run with: npm run seed
 */
import { loadConfig } from "./config.js";
import type { Context } from "./context.js";
import { openDb, SYSTEM } from "./db.js";
import { addDays, todayIn } from "./dates.js";
import { deposit, register } from "./services/auth.js";
import { postTransaction } from "./services/ledger.js";
import { type Account, addPayee, listAccounts, payBill, payPayee, transferBetweenOwn } from "./services/payments.js";
import { createSchedule } from "./services/schedules.js";

const config = loadConfig({ bcryptRounds: 10 });
const db = openDb(config.dbPath);

if (db.prepare("SELECT 1 FROM users LIMIT 1").get()) {
  console.log("The database already has customers. Delete larkspur.db to seed again.");
  process.exit(0);
}

// A movable clock lets the seed write history in the past.
let clock = new Date();
const ctx: Context = { db, config, now: () => clock };
const daysAgo = (days: number, hour = 10) => {
  clock = new Date(Date.now() - days * 86_400_000);
  clock.setHours(hour, (days * 7) % 60, 0, 0);
};

const PASSWORD = "demo-password-1";
const PIN = "1234";

daysAgo(42);
const alex = register(ctx, { email: "alex@larkspur.test", name: "Alex Nguyen", password: PASSWORD, pin: PIN });
const priya = register(ctx, { email: "priya@larkspur.test", name: "Priya Sharma", password: PASSWORD, pin: PIN });

const [alexEveryday, alexSaver] = listAccounts(ctx, alex.id) as [Account, Account];
const [priyaEveryday] = listAccounts(ctx, priya.id) as [Account];

const priyaPayee = addPayee(ctx, alex.id, {
  nickname: "Priya",
  accountName: "Priya Sharma",
  bsb: priyaEveryday.bsb,
  number: priyaEveryday.number,
});
const landlord = addPayee(ctx, alex.id, {
  nickname: "Landlord",
  accountName: "Carlton Property Group",
  bsb: "063-112",
  number: "10457783",
});
const alexPayee = addPayee(ctx, priya.id, {
  nickname: "Alex",
  accountName: "Alex Nguyen",
  bsb: alexEveryday.bsb,
  number: alexEveryday.number,
});

/** A card purchase: money leaving to a merchant at another bank. */
const spend = (amountCents: number, merchant: string) =>
  postTransaction(ctx, {
    kind: "payment",
    initiatedBy: alex.id,
    legs: [
      { accountId: alexEveryday.id, amountCents: -amountCents, description: merchant },
      { accountId: SYSTEM.clearing, amountCents, description: `Card purchase: ${merchant}` },
    ],
  });

const history: Array<[number, () => unknown]> = [
  [40, () => spend(84_35, "Queen Vic Market")],
  [
    38,
    () =>
      payPayee(ctx, alex.id, {
        fromAccountId: alexEveryday.id,
        payeeId: landlord.id,
        amountCents: 620_00,
        description: "Rent",
      }),
  ],
  [36, () => spend(5_20, "Seven Seeds Coffee")],
  [35, () => deposit(ctx, alexEveryday.id, 1_840_00, "Salary: Brightside Analytics")],
  [
    34,
    () =>
      transferBetweenOwn(ctx, alex.id, {
        fromAccountId: alexEveryday.id,
        toAccountId: alexSaver.id,
        amountCents: 400_00,
        description: "Holiday fund",
      }),
  ],
  [
    31,
    () =>
      payBill(ctx, alex.id, {
        fromAccountId: alexEveryday.id,
        billerCode: "45093",
        reference: "88104523",
        amountCents: 45_00,
      }),
  ],
  [29, () => spend(62_10, "Coles Carlton")],
  [
    27,
    () =>
      payPayee(ctx, priya.id, {
        fromAccountId: priyaEveryday.id,
        payeeId: alexPayee.id,
        amountCents: 38_50,
        description: "Dinner split",
      }),
  ],
  [
    24,
    () =>
      payPayee(ctx, alex.id, {
        fromAccountId: alexEveryday.id,
        payeeId: landlord.id,
        amountCents: 620_00,
        description: "Rent",
      }),
  ],
  [22, () => spend(18_90, "Myki top up")],
  [21, () => deposit(ctx, alexEveryday.id, 1_840_00, "Salary: Brightside Analytics")],
  [
    19,
    () =>
      payBill(ctx, alex.id, {
        fromAccountId: alexEveryday.id,
        billerCode: "20417",
        reference: "30077219",
        amountCents: 132_48,
      }),
  ],
  [16, () => spend(27_00, "Readings Books")],
  [
    13,
    () =>
      payPayee(ctx, alex.id, {
        fromAccountId: alexEveryday.id,
        payeeId: priyaPayee.id,
        amountCents: 25_00,
        description: "Movie tickets",
      }),
  ],
  [
    10,
    () =>
      payPayee(ctx, alex.id, {
        fromAccountId: alexEveryday.id,
        payeeId: landlord.id,
        amountCents: 620_00,
        description: "Rent",
      }),
  ],
  [7, () => deposit(ctx, alexEveryday.id, 1_840_00, "Salary: Brightside Analytics")],
  [
    6,
    () =>
      transferBetweenOwn(ctx, alex.id, {
        fromAccountId: alexEveryday.id,
        toAccountId: alexSaver.id,
        amountCents: 400_00,
        description: "Holiday fund",
      }),
  ],
  [4, () => spend(71_65, "Coles Carlton")],
  [2, () => spend(4_80, "Seven Seeds Coffee")],
  [1, () => deposit(ctx, alexSaver.id, 21_37, "Interest")],
];
for (const [days, run] of history) {
  daysAgo(days, 8 + (days % 10));
  run();
}

clock = new Date();
const today = todayIn(config.timezone, clock);
createSchedule(ctx, alex.id, {
  kind: "payment",
  fromAccountId: alexEveryday.id,
  payeeId: landlord.id,
  amountCents: 620_00,
  description: "Rent",
  frequency: "fortnightly",
  startDate: addDays(today, 4),
});
createSchedule(ctx, alex.id, {
  kind: "transfer",
  fromAccountId: alexEveryday.id,
  toAccountId: alexSaver.id,
  amountCents: 100_00,
  description: "Holiday fund",
  frequency: "weekly",
  startDate: addDays(today, 2),
});
createSchedule(ctx, alex.id, {
  kind: "bill",
  fromAccountId: alexEveryday.id,
  billerCode: "67340",
  billerReference: "55120094",
  amountCents: 79_00,
  frequency: "monthly",
  startDate: addDays(today, 9),
});

console.log(`Seeded ${config.dbPath}
  alex@larkspur.test  / ${PASSWORD} / PIN ${PIN}
  priya@larkspur.test / ${PASSWORD} / PIN ${PIN}`);
