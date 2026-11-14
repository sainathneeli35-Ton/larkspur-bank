import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type Schedule } from "../api";
import { dateLabel, frequencyLabel, money } from "../format";
import { useLoad } from "../useLoad";

function describe(s: Schedule): string {
  if (s.status === "cancelled") return "Cancelled";
  if (s.status === "completed") {
    return s.lastRunStatus === "failed"
      ? `Not paid on ${dateLabel(s.lastRunDate!)}`
      : `Finished ${dateLabel(s.lastRunDate!)}`;
  }
  const next = `Next on ${dateLabel(s.nextRunDate!)}`;
  if (s.frequency === "once") return dateLabel(s.nextRunDate!);
  return `${frequencyLabel[s.frequency]}. ${next}${s.endDate ? `, ends ${dateLabel(s.endDate)}` : ""}`;
}

export function ScheduledPage() {
  const scheduled = useLoad(() => api.scheduled(), []);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active = scheduled.data?.filter((s) => s.status === "active") ?? [];
  const past = scheduled.data?.filter((s) => s.status !== "active") ?? [];

  async function cancel(id: string) {
    setError(null);
    try {
      await api.cancelSchedule(id);
      scheduled.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCancelling(null);
    }
  }

  const row = (s: Schedule) => (
    <li key={s.id} className="row tall">
      <span>
        {s.toLabel}
        {s.description && `: ${s.description}`}
        <span className="muted">
          {describe(s)}. From {s.fromAccountName}
        </span>
        {s.lastRunStatus === "failed" && s.status === "active" && (
          <span className="warn">
            Missed on {dateLabel(s.lastRunDate!)}: {s.lastError}
          </span>
        )}
        {s.lastRunStatus === "failed" && s.status === "completed" && <span className="warn">{s.lastError}</span>}
      </span>
      <span className="row-end">
        <span className="num">{money(s.amountCents)}</span>
        {s.status === "active" &&
          (cancelling === s.id ? (
            <span className="row-actions">
              <button className="btn danger small" onClick={() => void cancel(s.id)}>
                Cancel payment
              </button>
              <button className="btn quiet small" onClick={() => setCancelling(null)}>
                Keep
              </button>
            </span>
          ) : (
            <button className="btn quiet small" onClick={() => setCancelling(s.id)}>
              Cancel
            </button>
          ))}
      </span>
    </li>
  );

  return (
    <div className="narrow">
      <div className="title-row">
        <h1>Scheduled</h1>
        <Link className="btn primary" to="/pay">
          Schedule a payment
        </Link>
      </div>
      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}
      {scheduled.data && active.length === 0 && (
        <p className="empty">
          Nothing scheduled. Choose "On a date" or "Repeating" when you make a payment to set one up.
        </p>
      )}
      <ul className="rows">{active.map(row)}</ul>
      {past.length > 0 && (
        <section className="block">
          <div className="block-head">
            <h2>Finished and cancelled</h2>
          </div>
          <ul className="rows faded">{past.map(row)}</ul>
        </section>
      )}
    </div>
  );
}
