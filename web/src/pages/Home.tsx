import { Link } from "react-router-dom";
import { api } from "../api";
import { TransactionList } from "../components/TransactionList";
import { accountNumber, dateLabel, money } from "../format";
import { useSession } from "../session";
import { useLoad } from "../useLoad";

export function Home() {
  const { user } = useSession();
  const accounts = useLoad(() => api.accounts(), []);
  const recent = useLoad(() => api.history({ limit: 8 }), []);
  const scheduled = useLoad(() => api.scheduled(), []);

  const total = accounts.data?.reduce((sum, a) => sum + a.balanceCents, 0) ?? 0;
  const upcoming = scheduled.data?.filter((s) => s.status === "active" && s.nextRunDate).slice(0, 3) ?? [];
  const firstName = user!.name.split(" ")[0];

  return (
    <>
      <header className="page-head">
        <p className="hello">Hi {firstName}</p>
        <h1 className="total num" aria-label={`Total across accounts ${money(total)}`}>
          {accounts.data ? money(total) : " "}
        </h1>
        <p className="muted">across {accounts.data?.length ?? 2} accounts</p>
      </header>

      {accounts.error && (
        <p className="banner error" role="alert">
          {accounts.error}
        </p>
      )}

      <ul className="accounts">
        {accounts.data?.map((a) => (
          <li key={a.id}>
            <Link to={`/accounts/${a.id}`} className={`account ${a.type}`}>
              <span className="account-name">
                {a.name}
                <span className="muted num">{accountNumber(a.bsb, a.number)}</span>
              </span>
              <span className="account-balance num">{money(a.balanceCents)}</span>
            </Link>
          </li>
        ))}
      </ul>

      <div className="quick">
        <Link className="btn primary" to="/pay?mode=payment">
          Pay someone
        </Link>
        <Link className="btn" to="/pay?mode=transfer">
          Transfer
        </Link>
        <Link className="btn" to="/pay?mode=bill">
          Pay a bill
        </Link>
      </div>

      {upcoming.length > 0 && (
        <section className="block">
          <div className="block-head">
            <h2>Coming up</h2>
            <Link to="/scheduled">All scheduled</Link>
          </div>
          <ul className="rows">
            {upcoming.map((s) => (
              <li key={s.id} className="row">
                <span>
                  {s.toLabel}
                  <span className="muted">{dateLabel(s.nextRunDate!)}</span>
                </span>
                <span className="num">{money(s.amountCents)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="block">
        <div className="block-head">
          <h2>Recent activity</h2>
        </div>
        {recent.data && <TransactionList items={recent.data.items} showAccount />}
      </section>
    </>
  );
}
