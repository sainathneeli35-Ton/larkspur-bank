import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError, type Frequency, newIdempotencyKey, type Receipt, type Schedule } from "../api";
import { Icon } from "../components/Icon";
import { dateLabel, frequencyLabel, money, parseAmount } from "../format";
import { useSession } from "../session";
import { useLoad } from "../useLoad";

type Mode = "transfer" | "payment" | "bill";
type When = "now" | "later" | "repeat";

const MODES: Array<{ id: Mode; label: string }> = [
  { id: "payment", label: "Pay someone" },
  { id: "transfer", label: "Between my accounts" },
  { id: "bill", label: "Pay a bill" },
];

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export function PayPage() {
  const { today } = useSession();
  const [params, setParams] = useSearchParams();
  const mode = (MODES.find((m) => m.id === params.get("mode"))?.id ?? "payment") as Mode;

  const accounts = useLoad(() => api.accounts(), []);
  const payees = useLoad(() => api.payees(), []);
  const billers = useLoad(() => api.billers(), []);

  const [fromId, setFromId] = useState(params.get("from") ?? "");
  const [toAccountId, setToAccountId] = useState("");
  const [payeeId, setPayeeId] = useState(params.get("payee") ?? "");
  const [billerCode, setBillerCode] = useState("");
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [when, setWhen] = useState<When>("now");
  const [startDate, setStartDate] = useState("");
  const [frequency, setFrequency] = useState<Exclude<Frequency, "once">>("fortnightly");
  const [endDate, setEndDate] = useState("");
  const [pin, setPin] = useState("");

  const [step, setStep] = useState<"form" | "review" | "done">("form");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ receipt?: Receipt; schedule?: Schedule } | null>(null);
  // One key per reviewed payment: pressing Confirm twice, or retrying after a dropped connection, pays once.
  const idempotencyKey = useRef("");
  const heading = useRef<HTMLHeadingElement>(null);

  const tomorrow = today ? addDays(today, 1) : "";
  const from = accounts.data?.find((a) => a.id === fromId);
  const cents = parseAmount(amount);
  const needsPin = mode !== "transfer";

  // Sensible defaults once the accounts arrive.
  useEffect(() => {
    if (!accounts.data?.length) return;
    const first = accounts.data.find((a) => a.id === fromId) ?? accounts.data[0]!;
    if (first.id !== fromId) setFromId(first.id);
    if (!toAccountId || toAccountId === first.id) {
      setToAccountId(accounts.data.find((a) => a.id !== first.id)?.id ?? "");
    }
  }, [accounts.data, fromId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (when !== "now" && !startDate && tomorrow) setStartDate(tomorrow);
  }, [when, startDate, tomorrow]);

  useEffect(() => heading.current?.focus(), [step]);

  const toLabel = useMemo(() => {
    if (mode === "transfer") return accounts.data?.find((a) => a.id === toAccountId)?.name ?? "";
    if (mode === "payment") return payees.data?.find((p) => p.id === payeeId)?.nickname ?? "";
    return billers.data?.find((b) => b.code === billerCode)?.name ?? "";
  }, [mode, accounts.data, payees.data, billers.data, toAccountId, payeeId, billerCode]);

  function switchMode(next: Mode) {
    setParams({ mode: next }, { replace: true });
    setError(null);
    setStep("form");
  }

  function review(e: FormEvent) {
    e.preventDefault();
    const problem = (() => {
      if (!from) return "Choose an account to pay from.";
      if (mode === "transfer" && !toAccountId) return "Choose an account to transfer to.";
      if (mode === "transfer" && toAccountId === fromId) return "Choose two different accounts.";
      if (mode === "payment" && !payeeId) return "Choose who to pay.";
      if (mode === "bill" && !billerCode) return "Choose a biller.";
      if (mode === "bill" && !/^\d{6,20}$/.test(reference))
        return "Enter the reference number from your bill (6 to 20 digits).";
      if (cents === null || cents <= 0) return "Enter an amount, like 25 or 25.50.";
      if (when === "now" && cents > from.balanceCents)
        return `You have ${money(from.balanceCents)} available in ${from.name}.`;
      if (when !== "now" && (!startDate || startDate < tomorrow)) return "Choose a date from tomorrow onwards.";
      if (when === "repeat" && endDate && endDate < startDate) return "The last payment date must be after the first.";
      return null;
    })();
    if (problem) return setError(problem);
    setError(null);
    setPin("");
    idempotencyKey.current = newIdempotencyKey();
    setStep("review");
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (needsPin && !/^\d{4}$/.test(pin)) return setError("Enter your 4-digit PIN.");
    setBusy(true);
    setError(null);
    const amountCents = cents!;
    const note = description.trim() || undefined;
    try {
      if (when === "now") {
        const receipt =
          mode === "transfer"
            ? await api.transfer(idempotencyKey.current, {
                fromAccountId: fromId,
                toAccountId,
                amountCents,
                description: note,
              })
            : mode === "payment"
              ? await api.pay(idempotencyKey.current, {
                  fromAccountId: fromId,
                  payeeId,
                  amountCents,
                  description: note,
                  pin,
                })
              : await api.payBill(idempotencyKey.current, {
                  fromAccountId: fromId,
                  billerCode,
                  reference,
                  amountCents,
                  pin,
                });
        setResult({ receipt });
      } else {
        const schedule = await api.schedule({
          kind: mode,
          fromAccountId: fromId,
          ...(mode === "transfer"
            ? { toAccountId }
            : mode === "payment"
              ? { payeeId }
              : { billerCode, billerReference: reference }),
          amountCents,
          description: mode === "bill" ? undefined : note,
          frequency: when === "later" ? "once" : frequency,
          startDate,
          endDate: when === "repeat" && endDate ? endDate : undefined,
          pin: needsPin ? pin : undefined,
        });
        setResult({ schedule });
      }
      setStep("done");
    } catch (err) {
      setError((err as Error).message);
      setPin("");
      // Anything but a wrong PIN sends the customer back to fix the details.
      if (!(err instanceof ApiError && ["wrong_pin", "locked", "network"].includes(err.code))) setStep("form");
    } finally {
      setBusy(false);
    }
  }

  function startAgain() {
    setAmount("");
    setDescription("");
    setReference("");
    setWhen("now");
    setStartDate("");
    setEndDate("");
    setResult(null);
    setStep("form");
    accounts.reload();
  }

  const verb = mode === "transfer" ? "Transfer" : "Pay";
  const whenSummary =
    when === "now"
      ? "Now"
      : when === "later"
        ? dateLabel(startDate || tomorrow)
        : `${frequencyLabel[frequency]} from ${dateLabel(startDate || tomorrow)}${endDate ? ` until ${dateLabel(endDate)}` : ""}`;

  if (step === "done" && result) {
    const paid = result.receipt;
    return (
      <div className="receipt">
        <span className="tick">
          <Icon name="check" size={30} />
        </span>
        <h1 ref={heading} tabIndex={-1}>
          {paid
            ? `${mode === "transfer" ? "Transferred" : "Paid"} ${money(paid.amountCents)} to ${paid.to}`
            : `Scheduled ${money(result.schedule!.amountCents)} to ${result.schedule!.toLabel}`}
        </h1>
        <dl className="summary">
          <div>
            <dt>From</dt>
            <dd>{from?.name}</dd>
          </div>
          <div>
            <dt>When</dt>
            <dd>{paid ? "Just now" : whenSummary}</dd>
          </div>
          {description.trim() && mode !== "bill" && (
            <div>
              <dt>Description</dt>
              <dd>{description.trim()}</dd>
            </div>
          )}
          {mode === "bill" && (
            <div>
              <dt>Reference</dt>
              <dd className="num">{reference}</dd>
            </div>
          )}
          {paid && (
            <div>
              <dt>Receipt</dt>
              <dd className="num">{paid.transactionId.slice(0, 8).toUpperCase()}</dd>
            </div>
          )}
        </dl>
        <div className="actions">
          <Link className="btn primary" to={paid ? `/accounts/${fromId}` : "/scheduled"}>
            {paid ? "View transactions" : "View scheduled"}
          </Link>
          <button className="btn" onClick={startAgain}>
            Make another payment
          </button>
        </div>
      </div>
    );
  }

  if (step === "review") {
    return (
      <form className="narrow" onSubmit={confirm}>
        <button
          type="button"
          className="back"
          onClick={() => {
            setStep("form");
            setError(null);
          }}
        >
          <Icon name="back" size={16} /> Edit details
        </button>
        <h1 ref={heading} tabIndex={-1}>
          Check the details
        </h1>
        {error && (
          <p className="banner error" role="alert">
            {error}
          </p>
        )}
        <p className="review-amount num">{money(cents!)}</p>
        <dl className="summary">
          <div>
            <dt>From</dt>
            <dd>{from?.name}</dd>
          </div>
          <div>
            <dt>To</dt>
            <dd>{toLabel}</dd>
          </div>
          {mode === "bill" && (
            <div>
              <dt>Reference</dt>
              <dd className="num">{reference}</dd>
            </div>
          )}
          {description.trim() && mode !== "bill" && (
            <div>
              <dt>Description</dt>
              <dd>{description.trim()}</dd>
            </div>
          )}
          <div>
            <dt>When</dt>
            <dd>{whenSummary}</dd>
          </div>
        </dl>
        {needsPin && (
          <label className="field">
            <span>Payment PIN</span>
            <input
              className="pin"
              type="password"
              inputMode="numeric"
              maxLength={4}
              autoComplete="off"
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            />
          </label>
        )}
        <button className="btn primary wide" disabled={busy}>
          {busy ? "Working…" : when === "now" ? `${verb} ${money(cents!)}` : "Schedule payment"}
        </button>
      </form>
    );
  }

  return (
    <form className="narrow" onSubmit={review} noValidate>
      <h1 ref={heading} tabIndex={-1}>
        Pay & transfer
      </h1>
      <div className="segmented" role="tablist" aria-label="Type of payment">
        {MODES.map((m) => (
          <button key={m.id} type="button" role="tab" aria-selected={mode === m.id} onClick={() => switchMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}

      <label className="field">
        <span>From</span>
        <select value={fromId} onChange={(e) => setFromId(e.target.value)}>
          {accounts.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({money(a.balanceCents)} available)
            </option>
          ))}
        </select>
      </label>

      {mode === "transfer" && (
        <label className="field">
          <span>To</span>
          <select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>
            {accounts.data
              ?.filter((a) => a.id !== fromId)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
      )}

      {mode === "payment" &&
        (payees.data && payees.data.length === 0 ? (
          <p className="empty">
            You haven't saved anyone to pay yet. <Link to="/payees?add=1">Add a payee</Link> with their BSB and account
            number.
          </p>
        ) : (
          <label className="field">
            <span>To</span>
            <select value={payeeId} onChange={(e) => setPayeeId(e.target.value)}>
              <option value="">Choose a payee</option>
              {payees.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nickname} ({p.bsb} {p.number})
                </option>
              ))}
            </select>
            <small>
              <Link to="/payees?add=1">Add a new payee</Link>
            </small>
          </label>
        ))}

      {mode === "bill" && (
        <>
          <label className="field">
            <span>Biller</span>
            <select value={billerCode} onChange={(e) => setBillerCode(e.target.value)}>
              <option value="">Choose a biller</option>
              {billers.data?.map((b) => (
                <option key={b.code} value={b.code}>
                  {b.name} (code {b.code})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Reference number</span>
            <input
              inputMode="numeric"
              value={reference}
              onChange={(e) => setReference(e.target.value.replace(/\D/g, ""))}
              maxLength={20}
            />
            <small>Printed on your bill, next to the biller code.</small>
          </label>
        </>
      )}

      <label className="field">
        <span>Amount</span>
        <span className="amount-input">
          <span aria-hidden="true">$</span>
          <input
            className="num"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label="Amount in dollars"
          />
        </span>
      </label>

      {mode !== "bill" && (
        <label className="field">
          <span>
            Description <em>optional</em>
          </span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={60} />
          {mode === "payment" && <small>The person you pay sees this too.</small>}
        </label>
      )}

      <fieldset className="field">
        <legend>When</legend>
        <div className="segmented small">
          {(
            [
              ["now", "Now"],
              ["later", "On a date"],
              ["repeat", "Repeating"],
            ] as const
          ).map(([id, label]) => (
            <label key={id} className={when === id ? "on" : ""}>
              <input type="radio" name="when" checked={when === id} onChange={() => setWhen(id)} />
              {label}
            </label>
          ))}
        </div>
        {when !== "now" && (
          <div className="when-grid">
            {when === "repeat" && (
              <label className="mini">
                <span>How often</span>
                <select value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)}>
                  <option value="weekly">Every week</option>
                  <option value="fortnightly">Every fortnight</option>
                  <option value="monthly">Every month</option>
                </select>
              </label>
            )}
            <label className="mini">
              <span>{when === "repeat" ? "First payment" : "Date"}</span>
              <input type="date" value={startDate} min={tomorrow} onChange={(e) => setStartDate(e.target.value)} />
            </label>
            {when === "repeat" && (
              <label className="mini">
                <span>
                  Last payment <em>optional</em>
                </span>
                <input
                  type="date"
                  value={endDate}
                  min={startDate || tomorrow}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </label>
            )}
          </div>
        )}
      </fieldset>

      <button className="btn primary wide">Continue</button>
    </form>
  );
}
