import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, setSignedOutHandler, type User } from "./api";

interface SessionState {
  user: User | null;
  today: string;
  loading: boolean;
  /** Why the last session ended, shown on the sign-in screen. */
  notice: string | null;
  signedIn: (user: User) => Promise<void>;
  signOut: (notice?: string) => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);
export const useSession = () => useContext(SessionContext)!;

const WARNING_SECONDS = 60;
const KEEP_ALIVE_MS = 4 * 60_000;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [today, setToday] = useState("");
  const [sessionMinutes, setSessionMinutes] = useState(15);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  const lastActivity = useRef(Date.now());
  const lastPing = useRef(Date.now());

  const load = useCallback(async () => {
    try {
      const me = await api.me();
      setUser(me.user);
      setToday(me.today);
      setSessionMinutes(me.sessionMinutes);
      lastActivity.current = lastPing.current = Date.now();
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async (why?: string) => {
    await api.logout().catch(() => {});
    setUser(null);
    setSecondsLeft(null);
    setNotice(why ?? null);
  }, []);

  useEffect(() => {
    setSignedOutHandler(() => {
      setUser((current) => {
        if (current) setNotice("Your session ended. Sign in again to continue.");
        return null;
      });
      setSecondsLeft(null);
    });
    void load();
  }, [load]);

  // Inactivity timeout. Using the app keeps the server session alive; walking away ends it.
  useEffect(() => {
    if (!user) return;
    const idleLimitMs = sessionMinutes * 60_000 - WARNING_SECONDS * 1000;

    const onActivity = () => {
      if (secondsLeftRef.current !== null) return; // while the warning is up, only the button counts
      lastActivity.current = Date.now();
      if (Date.now() - lastPing.current > KEEP_ALIVE_MS) {
        lastPing.current = Date.now();
        void api.me().catch(() => {});
      }
    };
    const events = ["pointerdown", "keydown", "scroll"] as const;
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));

    const tick = window.setInterval(() => {
      const idle = Date.now() - lastActivity.current;
      if (idle < idleLimitMs) return setSecondsLeft(null);
      const left = Math.ceil((idleLimitMs + WARNING_SECONDS * 1000 - idle) / 1000);
      if (left <= 0) void signOut("You were signed out after a period of inactivity.");
      else setSecondsLeft(left);
    }, 1000);

    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity));
      window.clearInterval(tick);
    };
  }, [user, sessionMinutes, signOut]);

  const secondsLeftRef = useRef<number | null>(null);
  secondsLeftRef.current = secondsLeft;

  const stay = () => {
    lastActivity.current = lastPing.current = Date.now();
    setSecondsLeft(null);
    void api.me().catch(() => {});
  };

  const signedIn = async (u: User) => {
    setNotice(null);
    setUser(u);
    await load();
  };

  return (
    <SessionContext.Provider value={{ user, today, loading, notice, signedIn, signOut }}>
      {children}
      {user && secondsLeft !== null && (
        <div className="scrim" role="alertdialog" aria-modal="true" aria-labelledby="idle-title">
          <div className="dialog">
            <h2 id="idle-title">Still there?</h2>
            <p>
              For your security you'll be signed out in <strong className="num">{secondsLeft}</strong> second
              {secondsLeft === 1 ? "" : "s"}.
            </p>
            <div className="actions">
              <button className="btn primary" onClick={stay} autoFocus>
                Stay signed in
              </button>
              <button className="btn quiet" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </SessionContext.Provider>
  );
}
