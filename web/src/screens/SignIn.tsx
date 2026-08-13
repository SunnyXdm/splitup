import { useState } from 'react';
import { toast } from 'sonner';
import { useAuthActions } from '@/components/auth/auth-context';
import { useOnline } from '@/components/layout/OfflineBanner';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

/** Decorative orbital arc + white satellite circle (DESIGN.md motif). */
function OrbitalArc() {
  return (
    <svg viewBox="0 0 280 120" className="mx-auto w-56 max-w-full" aria-hidden="true">
      {/* circle center (140, 208), r = 160 → arc peak at y = 48 */}
      <path
        d="M12 112 A 160 160 0 0 1 268 112"
        fill="none"
        stroke="var(--signal)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle
        cx="243"
        cy="85"
        r="7"
        fill="#ffffff"
        stroke="var(--signal)"
        strokeWidth="1.5"
      />
      <circle cx="140" cy="48" r="3" fill="var(--foreground)" />
    </svg>
  );
}

export default function SignIn({ sessionExpired = false }: { sessionExpired?: boolean }) {
  const { signIn } = useAuthActions();
  const online = useOnline();
  const [busy, setBusy] = useState(false);

  const handleSignIn = async () => {
    setBusy(true);
    try {
      await signIn(); // redirects away on success
    } catch {
      toast.error('Could not start sign-in, please try again');
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-10 bg-background px-6 py-10">
      <div className="flex w-full max-w-md flex-col items-center gap-6 text-center">
        <OrbitalArc />
        <span className="eyebrow">Splitup</span>
        <h1 className="text-4xl text-balance md:text-5xl">
          {sessionExpired ? 'Welcome back' : 'Split fairly. Settle simply.'}
        </h1>
        {sessionExpired ? (
          <p className="text-sm text-muted-foreground">
            Your session expired — sign in again to continue. Your data is safe.
          </p>
        ) : null}
        <p className="max-w-sm text-balance text-muted-foreground">
          Track shared expenses with friends and groups, see who owes what, and
          settle up in a tap — even offline.
        </p>
        <Button
          size="lg"
          className="h-12 rounded-full px-8"
          disabled={busy || !online}
          onClick={handleSignIn}
        >
          {busy ? <Spinner data-icon="inline-start" /> : null}
          Continue with Google
        </Button>
        {!online ? (
          <p className="text-xs text-muted-foreground">
            You&rsquo;re offline — connect to sign in.
          </p>
        ) : null}
      </div>
      <p className="max-w-sm text-center text-xs text-balance text-muted-foreground">
        Sign-in is Google-only, powered by shoo.dev (early-stage service).
      </p>
    </div>
  );
}
