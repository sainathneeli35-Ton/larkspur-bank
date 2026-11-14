import type { HistoryItem } from "../api";
import { dayLabel, money, signedMoney, timeLabel } from "../format";

/** History grouped by day. Shows the running balance when the list is for a single account. */
export function TransactionList({
  items,
  showAccount,
  showBalance,
}: {
  items: HistoryItem[];
  showAccount?: boolean;
  showBalance?: boolean;
}) {
  const groups: Array<{ day: string; items: HistoryItem[] }> = [];
  for (const item of items) {
    const day = dayLabel(item.createdAt);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }

  return (
    <div className="txns">
      {groups.map((group) => (
        <section key={group.day}>
          <h3 className="day">{group.day}</h3>
          <ul>
            {group.items.map((t) => (
              <li key={t.id} className="txn">
                <div className="txn-what">
                  <span className="txn-desc">{t.description}</span>
                  <span className="txn-meta">
                    {timeLabel(t.createdAt)}
                    {showAccount && `, ${t.accountName}`}
                    {t.scheduled && <span className="tag">Scheduled</span>}
                  </span>
                </div>
                <div className="txn-amount">
                  <span className={`num ${t.amountCents > 0 ? "in" : ""}`}>{signedMoney(t.amountCents)}</span>
                  {showBalance && <span className="txn-meta num">{money(t.balanceAfterCents)}</span>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
