import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { setActiveOrganizationId, trpc } from "./trpc";
import {
  clearOutboxForSignOut,
  resetOutboxScope,
  setOutboxScope,
  startOutboxSync,
} from "./outbox-client";
import { registerForPushNotifications } from "./push";

interface Membership {
  organizationId: string;
  organizationName: string;
  roleName: string;
  status: string;
}

interface SessionValue {
  session: Session | null;
  loading: boolean;
  membership: Membership | null;
  permissions: string[];
  /** Connectivity + queue depth, surfaced in the header so a driver can see unsent work. */
  online: boolean;
  pending: number;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside <SessionProvider>");
  return value;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [membership, setMembership] = useState<Membership | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  /** False until the stored session has been read — gates the outbox. */
  const [scopeReady, setScopeReady] = useState(false);

  useEffect(() => {
    // Scope the outbox before anything can read, write or replay it.
    const adopt = (next: Session | null) => {
      setOutboxScope(next?.user.id ?? null);
      setSession(next);
      setScopeReady(true);
      setLoading(false);
    };
    void supabase.auth.getSession().then(({ data }) => adopt(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => adopt(next));
    return () => {
      data.subscription.unsubscribe();
      resetOutboxScope();
    };
  }, []);

  /**
   * Connectivity tracking and the launch-time replay start only once the scope
   * is known, and are re-armed on every sign-in/sign-out, so the first flush
   * always targets the signed-in driver's own queue. Signed out there is no
   * token to replay with, so the sync stays off.
   */
  const userId = session?.user.id ?? null;
  useEffect(() => {
    if (!scopeReady || !userId) {
      setPending(0);
      return;
    }
    return startOutboxSync(({ online: isOnline, pending: queued }) => {
      setOnline(isOnline);
      setPending(queued);
    });
  }, [scopeReady, userId]);

  // Resolve the driver's org once signed in: the header pins every later call
  // to it, and push registration needs an active org to attach the device to.
  useEffect(() => {
    if (!session) {
      setMembership(null);
      setPermissions([]);
      setActiveOrganizationId(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const me = await trpc.organization.me.query();
        if (cancelled) return;
        const active =
          me.memberships.find((m) => m.organizationId === me.activeOrganizationId) ??
          me.memberships.find((m) => m.status === "active") ??
          null;
        setActiveOrganizationId(active?.organizationId ?? null);
        setMembership(active);
        setPermissions(me.permissions);
        await registerForPushNotifications();
      } catch {
        // Offline sign-in resume: the cached session still works, and the org
        // is resolved again on the next successful request.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
  }, []);

  const signOut = useCallback(async () => {
    // Drain then clear *before* the token goes away: whatever is left must not
    // be inherited by the next driver to sign in on this handset.
    await clearOutboxForSignOut();
    setPending(0);
    await supabase.auth.signOut();
    setActiveOrganizationId(null);
  }, []);

  const value = useMemo<SessionValue>(
    () => ({ session, loading, membership, permissions, online, pending, signIn, signOut }),
    [session, loading, membership, permissions, online, pending, signIn, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
