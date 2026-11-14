import { existsSync } from "node:fs";
import path from "node:path";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { z, ZodError } from "zod";
import type { Context } from "./context.js";
import { isIsoDate, todayIn } from "./dates.js";
import { AppError, badRequest, forbidden, unauthorized } from "./errors.js";
import { getUser, issueSession, login, readSession, register, verifyPin } from "./services/auth.js";
import {
  addPayee,
  listAccounts,
  listBillers,
  listHistory,
  listPayees,
  payBill,
  payPayee,
  removePayee,
  transferBetweenOwn,
} from "./services/payments.js";
import { cancelSchedule, createSchedule, listSchedules } from "./services/schedules.js";

const COOKIE = "larkspur_session";

const cents = z.number().int().positive();
const pin = z.string().regex(/^\d{4}$/, "Enter your 4-digit PIN.");
const note = z.string().trim().max(60).optional();
const isoDate = z.string().refine(isIsoDate, "Use a valid date.");
const billerReference = z.string().regex(/^\d{6,20}$/, "The reference is 6 to 20 digits.");

const schemas = {
  register: z.object({
    email: z.string().trim().email().max(200),
    name: z.string().trim().min(1).max(80),
    password: z.string().min(10, "Use at least 10 characters.").max(200),
    pin,
  }),
  login: z.object({ email: z.string().trim().min(1).max(200), password: z.string().min(1).max(200) }),
  transfer: z.object({ fromAccountId: z.string(), toAccountId: z.string(), amountCents: cents, description: note }),
  payment: z.object({ fromAccountId: z.string(), payeeId: z.string(), amountCents: cents, description: note, pin }),
  bill: z.object({
    fromAccountId: z.string(),
    billerCode: z.string().regex(/^\d{4,6}$/),
    reference: billerReference,
    amountCents: cents,
    pin,
  }),
  payee: z.object({
    nickname: z.string().trim().min(1).max(40),
    accountName: z.string().trim().min(1).max(80),
    bsb: z.string().regex(/^\d{3}-?\d{3}$/, "A BSB is 6 digits."),
    number: z.string().regex(/^\d{6,9}$/, "An account number is 6 to 9 digits."),
  }),
  schedule: z.object({
    kind: z.enum(["transfer", "payment", "bill"]),
    fromAccountId: z.string(),
    toAccountId: z.string().optional(),
    payeeId: z.string().optional(),
    billerCode: z.string().optional(),
    billerReference: billerReference.optional(),
    amountCents: cents,
    description: note,
    frequency: z.enum(["once", "weekly", "fortnightly", "monthly"]),
    startDate: isoDate,
    endDate: isoDate.optional(),
    pin: pin.optional(),
  }),
  history: z.object({
    accountId: z.string().optional(),
    q: z.string().max(60).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    direction: z.enum(["in", "out"]).optional(),
    cursor: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
};

type Authed = Request & { userId: string };

export function createApp(ctx: Context) {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        // Plain-HTTP localhost in development must not be upgraded to HTTPS.
        directives: ctx.config.secureCookies ? {} : { "upgrade-insecure-requests": null },
      },
    }),
  );
  app.use(express.json({ limit: "10kb" }));
  app.use(cookieParser());

  const setSession = (res: Response, userId: string) => {
    res.cookie(COOKIE, issueSession(ctx, userId), {
      httpOnly: true, // not readable from JavaScript
      sameSite: "strict", // never sent on cross-site requests
      secure: ctx.config.secureCookies,
      maxAge: ctx.config.sessionMinutes * 60_000,
      path: "/api",
    });
  };

  // CSRF defence in depth: browsers can't add a custom header to a cross-site request
  // without a CORS preflight, and this API allows no cross-origin callers.
  app.use("/api", (req, _res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("X-Requested-With") !== "larkspur-web") {
      return next(forbidden("csrf", "This request didn't come from the Larkspur app."));
    }
    next();
  });

  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    const session = readSession(ctx, req.cookies?.[COOKIE]);
    if (!session || !getUser(ctx, session.userId)) return next(unauthorized("Your session has ended. Sign in again."));
    (req as Authed).userId = session.userId;
    setSession(res, session.userId); // sliding expiry: each request restarts the inactivity window
    next();
  };

  const idempotencyKey = (req: Request): string | undefined => {
    const key = req.get("Idempotency-Key");
    if (key === undefined) return undefined;
    if (!/^[\w-]{8,100}$/.test(key))
      throw badRequest("invalid_idempotency_key", "Idempotency-Key must be 8 to 100 letters, digits, - or _.");
    return `api:${key}`;
  };

  const api = express.Router();

  api.get("/health", (_req, res) => res.json({ ok: true }));

  // ---------- Auth ----------
  api.post("/auth/register", (req, res) => {
    const user = register(ctx, schemas.register.parse(req.body));
    setSession(res, user.id);
    res.status(201).json({ user });
  });

  api.post("/auth/login", (req, res) => {
    const { email, password } = schemas.login.parse(req.body);
    const user = login(ctx, email, password);
    setSession(res, user.id);
    res.json({ user });
  });

  api.post("/auth/logout", (_req, res) => {
    res.clearCookie(COOKIE, { path: "/api" });
    res.status(204).end();
  });

  api.use(requireAuth);
  const uid = (req: Request) => (req as Authed).userId;

  api.get("/me", (req, res) => {
    res.json({
      user: getUser(ctx, uid(req)),
      sessionMinutes: ctx.config.sessionMinutes,
      today: todayIn(ctx.config.timezone, ctx.now()),
    });
  });

  // ---------- Accounts and history ----------
  api.get("/accounts", (req, res) => res.json({ accounts: listAccounts(ctx, uid(req)) }));

  api.get("/transactions", (req, res) => {
    res.json(listHistory(ctx, uid(req), schemas.history.parse(req.query)));
  });

  // ---------- Moving money ----------
  api.post("/transfers", (req, res) => {
    const body = schemas.transfer.parse(req.body);
    const receipt = transferBetweenOwn(ctx, uid(req), { ...body, idempotencyKey: idempotencyKey(req) });
    res.status(receipt.replayed ? 200 : 201).json({ receipt });
  });

  api.post("/payments", (req, res) => {
    const { pin: enteredPin, ...body } = schemas.payment.parse(req.body);
    const key = idempotencyKey(req);
    verifyPin(ctx, uid(req), enteredPin);
    const receipt = payPayee(ctx, uid(req), { ...body, idempotencyKey: key });
    res.status(receipt.replayed ? 200 : 201).json({ receipt });
  });

  api.post("/bills", (req, res) => {
    const { pin: enteredPin, ...body } = schemas.bill.parse(req.body);
    const key = idempotencyKey(req);
    verifyPin(ctx, uid(req), enteredPin);
    const receipt = payBill(ctx, uid(req), { ...body, idempotencyKey: key });
    res.status(receipt.replayed ? 200 : 201).json({ receipt });
  });

  // ---------- Payees and billers ----------
  api.get("/payees", (req, res) => res.json({ payees: listPayees(ctx, uid(req)) }));
  api.post("/payees", (req, res) => {
    res.status(201).json({ payee: addPayee(ctx, uid(req), schemas.payee.parse(req.body)) });
  });
  api.delete("/payees/:id", (req, res) => {
    removePayee(ctx, uid(req), String(req.params.id));
    res.status(204).end();
  });
  api.get("/billers", (_req, res) => res.json({ billers: listBillers(ctx) }));

  // ---------- Scheduled payments ----------
  api.get("/scheduled", (req, res) => res.json({ scheduled: listSchedules(ctx, uid(req)) }));
  api.post("/scheduled", (req, res) => {
    const { pin: enteredPin, ...body } = schemas.schedule.parse(req.body);
    // Money leaving to someone else needs the PIN, now or later. Moving it between your own accounts doesn't.
    if (body.kind !== "transfer") verifyPin(ctx, uid(req), enteredPin);
    res.status(201).json({ scheduled: createSchedule(ctx, uid(req), body) });
  });
  api.post("/scheduled/:id/cancel", (req, res) => {
    res.json({ scheduled: cancelSchedule(ctx, uid(req), String(req.params.id)) });
  });

  app.use("/api", api);
  app.use("/api", (_req, _res, next) => next(new AppError(404, "not_found", "No such endpoint.")));

  // In production the API also serves the built web app.
  const webDist = path.resolve(import.meta.dirname, "../../web/dist");
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const field = first?.path.join(".");
      return res.status(400).json({
        error: {
          code: "invalid_request",
          message: first ? `${field ? `${field}: ` : ""}${first.message}` : "Invalid request.",
        },
      });
    }
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof SyntaxError && "body" in err) {
      return res.status(400).json({ error: { code: "invalid_json", message: "The request body isn't valid JSON." } });
    }
    console.error(err);
    res
      .status(500)
      .json({
        error: { code: "internal", message: "Something went wrong on our side. Nothing was charged twice; try again." },
      });
  });

  return app;
}
