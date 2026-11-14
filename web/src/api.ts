export interface User {
  id: string;
  email: string;
  name: string;
}
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
export interface Biller {
  code: string;
  name: string;
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
export interface Receipt {
  transactionId: string;
  createdAt: string;
  replayed: boolean;
  amountCents: number;
  fromAccountId: string;
  to: string;
}
export type Frequency = "once" | "weekly" | "fortnightly" | "monthly";
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

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Called when the server says the session is over, so the app can return to the sign-in screen. */
let onSignedOut: () => void = () => {};
export const setSignedOutHandler = (fn: () => void) => (onSignedOut = fn);

async function call<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${url}`, {
      method,
      credentials: "same-origin",
      headers: {
        "X-Requested-With": "larkspur-web",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network", "Can't reach Larkspur right now. Check your connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith("/auth/")) onSignedOut();
    throw new ApiError(
      res.status,
      data?.error?.code ?? "unknown",
      data?.error?.message ?? "Something went wrong. Try again.",
    );
  }
  return data as T;
}

const query = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

/** A fresh key per payment attempt. Retrying with the same key can never pay twice. */
export const newIdempotencyKey = () => crypto.randomUUID();
const keyed = (key: string) => ({ "Idempotency-Key": key });

export const api = {
  me: () => call<{ user: User; sessionMinutes: number; today: string }>("GET", "/me"),
  login: (email: string, password: string) => call<{ user: User }>("POST", "/auth/login", { email, password }),
  register: (input: { email: string; name: string; password: string; pin: string }) =>
    call<{ user: User }>("POST", "/auth/register", input),
  logout: () => call<void>("POST", "/auth/logout"),

  accounts: () => call<{ accounts: Account[] }>("GET", "/accounts").then((r) => r.accounts),
  history: (filters: {
    accountId?: string;
    q?: string;
    from?: string;
    to?: string;
    direction?: string;
    cursor?: number;
    limit?: number;
  }) => call<{ items: HistoryItem[]; nextCursor: number | null }>("GET", `/transactions${query(filters)}`),

  payees: () => call<{ payees: Payee[] }>("GET", "/payees").then((r) => r.payees),
  addPayee: (input: { nickname: string; accountName: string; bsb: string; number: string }) =>
    call<{ payee: Payee }>("POST", "/payees", input).then((r) => r.payee),
  removePayee: (id: string) => call<void>("DELETE", `/payees/${id}`),
  billers: () => call<{ billers: Biller[] }>("GET", "/billers").then((r) => r.billers),

  transfer: (
    key: string,
    input: { fromAccountId: string; toAccountId: string; amountCents: number; description?: string },
  ) => call<{ receipt: Receipt }>("POST", "/transfers", input, keyed(key)).then((r) => r.receipt),
  pay: (
    key: string,
    input: { fromAccountId: string; payeeId: string; amountCents: number; description?: string; pin: string },
  ) => call<{ receipt: Receipt }>("POST", "/payments", input, keyed(key)).then((r) => r.receipt),
  payBill: (
    key: string,
    input: { fromAccountId: string; billerCode: string; reference: string; amountCents: number; pin: string },
  ) => call<{ receipt: Receipt }>("POST", "/bills", input, keyed(key)).then((r) => r.receipt),

  scheduled: () => call<{ scheduled: Schedule[] }>("GET", "/scheduled").then((r) => r.scheduled),
  schedule: (input: Record<string, unknown>) =>
    call<{ scheduled: Schedule }>("POST", "/scheduled", input).then((r) => r.scheduled),
  cancelSchedule: (id: string) =>
    call<{ scheduled: Schedule }>("POST", `/scheduled/${id}/cancel`).then((r) => r.scheduled),
};
