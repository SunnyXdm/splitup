import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useShooAuth } from '@shoojs/react';
import { CloudAlert } from 'lucide-react';
import { toast } from 'sonner';
import { OfflineBanner } from '@/components/layout/OfflineBanner';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { ApiError } from '@/lib/api';
import {
  clearSignedOut,
  isSignedOut,
  onSignOutBroadcast,
  subscribeSignedOut,
} from '@/lib/auth-session';
import { discardCachedData, useExchangeSession, useSyncData } from '@/lib/queries';
import SignIn from '@/screens/SignIn';
import { AuthActionsContext, type AuthActions } from './auth-context';

function Splash() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background">
      <Spinner className="size-8 text-muted-foreground" />
    </div>
  );
}

function SyncError({
  title = 'Couldn’t load your data',
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CloudAlert aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{message}</EmptyDescription>
        </EmptyHeader>
        <Button className="rounded-full px-6" onClick={onRetry}>
          Try again
        </Button>
      </Empty>
    </div>
  );
}

const is401 = (err: unknown) => err instanceof ApiError && err.status === 401;

/**
 * Session gate. Renders the app once the sync query has data (persisted cache
 * counts — that is offline mode), otherwise drives the shoo-token → session
 * cookie exchange and falls back to the SignIn screen.
 *
 * Exchange states, explicitly:
 * - idle / pending for the current token → splash;
 * - succeeded → the sync refetch decides (a lingering 401 → sign in);
 * - failed with 401 (bad shoo token) → sign in;
 * - failed transiently (network / 5xx / 429) → a retry screen (never an
 *   endless splash), unless cached data can be shown meanwhile.
 * After an EXPLICIT sign-out no exchange runs at all until the user signs in.
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const shoo = useShooAuth({ requestPii: true, autoSessionMonitor: false });
  const sync = useSyncData();
  const exchange = useExchangeSession();
  const signedOut = useSyncExternalStore(subscribeSignedOut, isSignedOut);
  // Effect-only latch so StrictMode double effects / re-renders never fire a
  // second automatic exchange for the same token.
  const autoExchanged = useRef<string | null>(null);

  const token = shoo.identity.token;
  // A 401 is definitive even while stale data is showing: the session is dead.
  // It must trigger re-auth, not silently render weeks-old data as current.
  const unauthorized = is401(sync.error);

  const exchangedThisToken = token !== undefined && exchange.variables === token;
  const exchangeFailedTransiently =
    exchangedThisToken && exchange.isError && !is401(exchange.error);

  const { mutate: runExchange } = exchange;
  useEffect(() => {
    if (!unauthorized || !token || signedOut || autoExchanged.current === token) return;
    autoExchanged.current = token;
    runExchange(token, {
      onError: (err) => toast.error(err.message || 'Sign-in failed, please try again'),
    });
  }, [unauthorized, token, signedOut, runExchange]);

  // Another tab signed out: drop this tab's data and identity too.
  const { clearIdentity, signIn } = shoo;
  useEffect(
    () =>
      onSignOutBroadcast(() => {
        qc.clear();
        clearIdentity();
        window.location.assign('/');
      }),
    [qc, clearIdentity],
  );

  // The cached dataset belongs to a different account than the one shoo says
  // is signed in (e.g. a session swapped without an explicit sign-out): never
  // render it — wipe memory + disk and refetch.
  const claimedEmail = shoo.claims?.email?.toLowerCase();
  const cachedEmail = sync.data?.me.email?.toLowerCase();
  const foreignCache = Boolean(claimedEmail && cachedEmail && claimedEmail !== cachedEmail);
  useEffect(() => {
    if (foreignCache) void discardCachedData(qc);
  }, [foreignCache, qc]);

  const actions = useMemo<AuthActions>(
    () => ({
      signIn: () => {
        clearSignedOut();
        return signIn();
      },
      clearIdentity,
    }),
    [signIn, clearIdentity],
  );

  // Session is dead and no silent recovery is possible → the user must sign in
  // again. Persisted data stays intact for after the round-trip.
  const needsSignIn =
    unauthorized &&
    !exchange.isPending &&
    (!token ||
      signedOut ||
      (exchangedThisToken &&
        (exchange.isSuccess ? !sync.isFetching : is401(exchange.error))));

  let content: ReactNode;
  if (foreignCache) {
    content = <Splash />;
  } else if (needsSignIn) {
    content = <SignIn sessionExpired={sync.data !== undefined && !signedOut} />;
  } else if (unauthorized && sync.data && !exchangeFailedTransiently) {
    // Re-establishing the session: hold the splash rather than render data
    // the exchange may reveal to belong to someone else.
    content = <Splash />;
  } else if (sync.data) {
    // Data (fresh or persisted) wins — a failing refetch without a 401 just
    // means offline or a transient server error.
    content = children;
  } else if (exchangeFailedTransiently) {
    content = (
      <SyncError
        title="Couldn’t sign you in"
        message={exchange.error?.message || 'Check your connection and try again.'}
        onRetry={() => token && runExchange(token)}
      />
    );
  } else if (shoo.loading || sync.isPending || sync.isFetching || exchange.isPending) {
    content = <Splash />;
  } else if (unauthorized) {
    // 401 with an exchange about to fire (effect above) → keep the splash.
    content = <Splash />;
  } else if (sync.isError) {
    content = <SyncError message={sync.error.message} onRetry={() => void sync.refetch()} />;
  } else {
    content = <Splash />;
  }

  return (
    <AuthActionsContext.Provider value={actions}>
      {content}
      <OfflineBanner />
    </AuthActionsContext.Provider>
  );
}
