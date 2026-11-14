import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { Icon } from "./components/Icon";
import { AccountPage } from "./pages/Account";
import { Home } from "./pages/Home";
import { PayPage } from "./pages/Pay";
import { PayeesPage } from "./pages/Payees";
import { ScheduledPage } from "./pages/Scheduled";
import { SignIn } from "./pages/SignIn";
import { useSession } from "./session";

export function Wordmark() {
  return (
    <span className="wordmark">
      <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
        <rect width="32" height="32" rx="9" fill="currentColor" className="mark-bg" />
        <path
          d="M11 8v16h11"
          stroke="#fff"
          strokeWidth="3.4"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Larkspur
    </span>
  );
}

const NAV = [
  { to: "/", label: "Accounts", icon: "home" },
  { to: "/pay", label: "Pay & transfer", icon: "pay" },
  { to: "/scheduled", label: "Scheduled", icon: "calendar" },
  { to: "/payees", label: "Payees", icon: "people" },
] as const;

export function App() {
  const { user, loading, signOut } = useSession();

  if (loading)
    return (
      <div className="splash" aria-busy="true">
        <Wordmark />
      </div>
    );
  if (!user) return <SignIn />;

  return (
    <div className="shell">
      <header className="rail">
        <Wordmark />
        <nav aria-label="Main">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === "/"}>
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="rail-foot">
          <span className="who">{user.name}</span>
          <button className="btn quiet small" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/accounts/:id" element={<AccountPage />} />
          <Route path="/pay" element={<PayPage />} />
          <Route path="/scheduled" element={<ScheduledPage />} />
          <Route path="/payees" element={<PayeesPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <p className="demo-note">Larkspur is a demonstration bank. Accounts and money here are simulated.</p>
      </main>
    </div>
  );
}
