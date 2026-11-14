import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type HistoryItem } from "../api";
import { Icon } from "../components/Icon";
import { TransactionList } from "../components/TransactionList";
import { accountNumber, money } from "../format";
import { useLoad } from "../useLoad";

const NO_FILTERS = { q: "", direction: "", from: "", to: "" };

export function AccountPage() {
  const { id } = useParams();
  const accounts = useLoad(() => api.accounts(), []);
  const account = accounts.data?.find((a) => a.id === id);

  const [filters, setFilters] = useState(NO_FILTERS);
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const filtering = Object.values(filters).some(Boolean);

  // Reload from the top whenever the filters change. Typing in search waits a moment first.
  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      api.history({ accountId: id, ...filters, limit: 25 }).then(
        (page) => {
          if (!current) return;
          setItems(page.items);
          setCursor(page.nextCursor);
          setError(null);
        },
        (e: Error) => current && setError(e.message),
      );
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [id, filters]);

  async function showMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await api.history({ accountId: id, ...filters, limit: 25, cursor });
      setItems((prev) => [...(prev ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  const set = (key: keyof typeof NO_FILTERS) => (e: { target: { value: string } }) =>
    setFilters({ ...filters, [key]: e.target.value });

  return (
    <>
      <Link to="/" className="back">
        <Icon name="back" size={16} /> Accounts
      </Link>
      <header className="page-head">
        <p className="hello">{account?.name ?? " "}</p>
        <h1 className="total num">{account ? money(account.balanceCents) : " "}</h1>
        <p className="muted num">{account && `BSB and account ${accountNumber(account.bsb, account.number)}`}</p>
      </header>

      <div className="quick">
        <Link className="btn primary" to={`/pay?mode=payment&from=${id}`}>
          Pay someone
        </Link>
        <Link className="btn" to={`/pay?mode=transfer&from=${id}`}>
          Transfer
        </Link>
      </div>

      <section className="block">
        <div className="block-head">
          <h2>Transactions</h2>
        </div>
        <form className="filters" onSubmit={(e) => e.preventDefault()} role="search">
          <label className="search">
            <Icon name="search" size={18} />
            <input
              type="search"
              placeholder="Search transactions"
              aria-label="Search transactions"
              value={filters.q}
              onChange={set("q")}
            />
          </label>
          <label className="mini">
            <span>Show</span>
            <select value={filters.direction} onChange={set("direction")}>
              <option value="">Money in and out</option>
              <option value="in">Money in</option>
              <option value="out">Money out</option>
            </select>
          </label>
          <label className="mini">
            <span>From</span>
            <input type="date" value={filters.from} max={filters.to || undefined} onChange={set("from")} />
          </label>
          <label className="mini">
            <span>To</span>
            <input type="date" value={filters.to} min={filters.from || undefined} onChange={set("to")} />
          </label>
          {filtering && (
            <button type="button" className="link" onClick={() => setFilters(NO_FILTERS)}>
              Clear filters
            </button>
          )}
        </form>

        {error && (
          <p className="banner error" role="alert">
            {error}
          </p>
        )}
        {items && items.length === 0 && (
          <p className="empty">
            {filtering
              ? "No transactions match those filters."
              : "No transactions yet. Money you move will show up here."}
          </p>
        )}
        {items && <TransactionList items={items} showBalance />}
        {cursor && (
          <button className="btn wide" onClick={showMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Show older transactions"}
          </button>
        )}
      </section>
    </>
  );
}
