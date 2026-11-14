import { type FormEvent, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useLoad } from "../useLoad";

const EMPTY = { nickname: "", accountName: "", bsb: "", number: "" };

export function PayeesPage() {
  const [params] = useSearchParams();
  const payees = useLoad(() => api.payees(), []);
  const [adding, setAdding] = useState(params.get("add") === "1");
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const set =
    (key: keyof typeof EMPTY, digitsOnly = false) =>
    (e: { target: { value: string } }) =>
      setForm({ ...form, [key]: digitsOnly ? e.target.value.replace(/[^\d-]/g, "") : e.target.value });

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form.nickname.trim() || !form.accountName.trim()) return setError("Enter a nickname and the account name.");
    if (!/^\d{3}-?\d{3}$/.test(form.bsb)) return setError("A BSB is 6 digits, like 063-112.");
    if (!/^\d{6,9}$/.test(form.number)) return setError("An account number is 6 to 9 digits.");
    setBusy(true);
    setError(null);
    try {
      await api.addPayee(form);
      setForm(EMPTY);
      setAdding(false);
      payees.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await api.removePayee(id);
      payees.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="narrow">
      <div className="title-row">
        <h1>Payees</h1>
        {!adding && (
          <button className="btn primary" onClick={() => setAdding(true)}>
            Add payee
          </button>
        )}
      </div>
      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}

      {adding && (
        <form className="panel" onSubmit={save} noValidate>
          <h2>Add a payee</h2>
          <label className="field">
            <span>Nickname</span>
            <input value={form.nickname} onChange={set("nickname")} maxLength={40} autoFocus />
            <small>What you'll see in your lists, like "Landlord".</small>
          </label>
          <label className="field">
            <span>Account name</span>
            <input value={form.accountName} onChange={set("accountName")} maxLength={80} />
          </label>
          <div className="pair">
            <label className="field">
              <span>BSB</span>
              <input
                className="num"
                inputMode="numeric"
                placeholder="000-000"
                value={form.bsb}
                onChange={set("bsb", true)}
                maxLength={7}
              />
            </label>
            <label className="field">
              <span>Account number</span>
              <input
                className="num"
                inputMode="numeric"
                value={form.number}
                onChange={set("number", true)}
                maxLength={9}
              />
            </label>
          </div>
          <div className="actions">
            <button className="btn primary" disabled={busy}>
              {busy ? "Saving…" : "Save payee"}
            </button>
            <button
              type="button"
              className="btn quiet"
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {payees.data?.length === 0 && !adding && (
        <p className="empty">No payees yet. Add someone's BSB and account number to pay them.</p>
      )}
      <ul className="rows">
        {payees.data?.map((p) => (
          <li key={p.id} className="row">
            <span>
              {p.nickname}
              <span className="muted">
                {p.accountName},{" "}
                <span className="num">
                  {p.bsb} {p.number}
                </span>
              </span>
            </span>
            {removing === p.id ? (
              <span className="row-actions">
                <button className="btn danger small" onClick={() => void remove(p.id)}>
                  Remove {p.nickname}
                </button>
                <button className="btn quiet small" onClick={() => setRemoving(null)}>
                  Keep
                </button>
              </span>
            ) : (
              <span className="row-actions">
                <Link className="btn small" to={`/pay?mode=payment&payee=${p.id}`}>
                  Pay
                </Link>
                <button className="btn quiet small" onClick={() => setRemoving(p.id)}>
                  Remove
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
