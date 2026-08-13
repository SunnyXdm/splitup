import { useEffect, useMemo, useRef, type ReactNode } from 'react';
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
import { useExchangeSession, useSyncData } from '@/lib/queries';
import SignIn from '@/screens/SignIn';
import { AuthActionsContext, type AuthActions } from './auth-context';

function Splash() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background">
      <Spinner className="size-8 text-muted-foreground" />
    </div>
  );
}

function SyncError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CloudAlert aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Couldn&rsquo;t load your data</EmptyTitle>
          <EmptyDescription>{message}</EmptyDescription>
        </EmptyHeader>
        <Button className="rounded-full px-6" onClick={onRetry}>
          Try again
        </Button>
      </Empty>
    </div>
  );
}

/**
 * Session gate. Renders the app once the sync query has data (persisted cache
 * counts — that is offline mode), otherwise drives the shoo-token → session
 * cookie exchange and falls back to the SignIn screen.
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  const shoo = useShooAuth({ requestPii: true, autoSessionMonitor: false });
  const sync = useSyncData();
  const exchange = useExchangeSession();
  // Keyed by token so a fresh sign-in always gets a new exchange attempt.
  const attemptedToken = useRef<string | null>(null);

  const token = shoo.identity.token;
  // A 401 is definitive even while stale data is showing: the session is dead.
  // It must trigger re-auth, not silently render weeks-old data as current.
  const unauthorized = sync.error instanceof ApiError && sync.error.status === 401;

  const { mutate: runExchange } = exchange;
  useEffect(() => {
    if (!unauthorized || !token || attemptedToken.current === token) return;
    attemptedToken.current = token;
    runExchange(token, {
      onError: (err) => {
        toast.error(err.message || 'Sign-in failed, please try again');
        // Transient failure (network/5xx/429): allow a retry on the next 401.
        // A 401 from the exchange itself means the shoo token is bad — keep
        // the latch so we fall through to the SignIn screen.
        if (!(err instanceof ApiError && err.status === 401)) {
          attemptedToken.current = null;
        }
      },
    });
  }, [unauthorized, token, runExchange]);

  const { signIn, clearIdentity } = shoo;
  const actions = useMemo<AuthActions>(
    () => ({ signIn: () => signIn(), clearIdentity }),
    [signIn, clearIdentity],
  );

  // Session is dead and no silent recovery is possible → the user must sign in
  // again. Persisted data stays intact for after the round-trip.
  const needsSignIn =
    unauthorized &&
    !exchange.isPending &&
    (!token || (attemptedToken.current === token && !exchange.isSuccess));

  let content: ReactNode;
  if (sync.data && !needsSignIn) {
    // Data (fresh or persisted) wins — a failing refetch without a 401 just
    // means offline or a transient server error.
    content = children;
  } else if (needsSignIn) {
    content = <SignIn sessionExpired={sync.data !== undefined} />;
  } else if (shoo.loading || sync.isPending || sync.isFetching || exchange.isPending) {
    content = <Splash />;
  } else if (unauthorized) {
    // 401 with an exchange about to fire (effect above) → keep the splash.
    content = <Splash />;
  } else if (sync.isError) {
    content = (
      <SyncError message={sync.error.message} onRetry={() => void sync.refetch()} />
    );
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
