import { type FormEvent, useState } from "react";
import { api } from "../api";
import { Wordmark } from "../App";
import { useSession } from "../session";

export function SignIn() {
  const { signedIn, notice } = useSession();
  const [mode, setMode] = useState<"signin" | "join">("signin");
  const [form, setForm] = useState({ name: "", email: "", password: "", pin: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "join" && !/^\d{4}$/.test(form.pin)) return setError("Choose a 4-digit PIN.");
    setBusy(true);
    try {
      const { user } = mode === "signin" ? await api.login(form.email, form.password) : await api.register(form);
      await signedIn(user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <aside className="gate-brand">
        <Wordmark />
        <p className="gate-line">Move your money in a few taps, and see exactly where it went.</p>
        <p className="gate-small">A demonstration bank. Accounts and money here are simulated.</p>
      </aside>

      <main className="gate-form">
        <form onSubmit={submit} noValidate>
          <h1>{mode === "signin" ? "Sign in" : "Open an account"}</h1>
          {notice && mode === "signin" && (
            <p className="banner info" role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className="banner error" role="alert">
              {error}
            </p>
          )}

          {mode === "join" && (
            <label className="field">
              <span>Your name</span>
              <input value={form.name} onChange={set("name")} autoComplete="name" required />
            </label>
          )}
          <label className="field">
            <span>Email</span>
            <input type="email" value={form.email} onChange={set("email")} autoComplete="username" required autoFocus />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={form.password}
              onChange={set("password")}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              required
            />
            {mode === "join" && <small>At least 10 characters.</small>}
          </label>
          {mode === "join" && (
            <label className="field">
              <span>Payment PIN</span>
              <input
                className="pin"
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={form.pin}
                onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, "") })}
                autoComplete="off"
                required
              />
              <small>4 digits. You'll enter it to confirm payments to other people.</small>
            </label>
          )}

          <button className="btn primary wide" disabled={busy}>
            {busy ? "One moment…" : mode === "signin" ? "Sign in" : "Open account"}
          </button>
          <p className="switch">
            {mode === "signin" ? "New to Larkspur?" : "Already with Larkspur?"}{" "}
            <button
              type="button"
              className="link"
              onClick={() => {
                setMode(mode === "signin" ? "join" : "signin");
                setError(null);
              }}
            >
              {mode === "signin" ? "Open an account" : "Sign in"}
            </button>
          </p>
        </form>
      </main>
    </div>
  );
}
