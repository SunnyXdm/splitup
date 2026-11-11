import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { CloudAlert, Eye, PencilLine, PlugZap, TicketX } from 'lucide-react';
import { toast } from 'sonner';
import { useOnline } from '@/components/layout/OfflineBanner';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { ApiError } from '@/lib/api';
import { useAnswerOAuthRequest, useOAuthRequest, type McpScope } from '@/lib/connections';
import { useSyncData } from '@/lib/queries';

/**
 * OAuth consent for an MCP connector (Claude, ChatGPT, …): the server's
 * /oauth/authorize sends the browser here, AuthGate signs the user in first
 * if needed, and Allow/Deny hands the browser back to the app's redirect URI.
 * Chromeless, like the invite pages.
 */
export default function OAuthConsent() {
  return (
    <div className="flex flex-col gap-6 pb-6">
      <PageHeader title="Connect an app" back={false} />
      <ConsentBody />
    </div>
  );
}

function ConsentBody() {
  const [params] = useSearchParams();
  const id = params.get('request') ?? '';
  const online = useOnline();
  const me = useSyncData().data?.me;
  const request = useOAuthRequest(id);
  const answer = useAnswerOAuthRequest();
  const [allowWrite, setAllowWrite] = useState(true);
  const [leaving, setLeaving] = useState(false);

  if (request.isPending && request.fetchStatus !== 'idle') {
    return (
      <Card>
        <Skeleton className="size-20 rounded-full" />
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-12 w-full rounded-full" />
      </Card>
    );
  }

  const gone =
    !request.data &&
    (request.fetchStatus === 'idle' ||
      (request.error instanceof ApiError && request.error.status === 404));
  if (gone) {
    return (
      <div className="flex justify-center">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TicketX aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>This connection request has expired</EmptyTitle>
            <EmptyDescription>
              Go back to the app you were connecting and start again.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const data = request.data;
  if (!data) {
    return (
      <div className="flex justify-center">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CloudAlert aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>Couldn&rsquo;t load this request</EmptyTitle>
            <EmptyDescription>
              {online ? 'Something went wrong — try again.' : 'You’re offline — reconnect first.'}
            </EmptyDescription>
          </EmptyHeader>
          <Button className="rounded-full px-6" onClick={() => void request.refetch()}>
            Try again
          </Button>
        </Empty>
      </div>
    );
  }

  const wantsWrite = data.scopes.includes('splitup.write');
  const respond = (allow: boolean) => {
    const scopes: McpScope[] =
      wantsWrite && allowWrite ? ['splitup.read', 'splitup.write'] : ['splitup.read'];
    answer.mutate(
      { id, allow, scopes },
      {
        onSuccess: ({ redirectTo }) => {
          setLeaving(true);
          window.location.assign(redirectTo);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };
  const busy = answer.isPending || leaving;
  const returnTo = data.client.loopback ? 'the app on this device' : data.client.redirectHost;

  return (
    <Card>
      <span className="flex size-20 items-center justify-center rounded-full bg-background">
        <PlugZap className="size-9 text-foreground/80" aria-hidden="true" />
      </span>
      <div className="flex flex-col gap-2">
        <span className="eyebrow self-center">MCP connection</span>
        <h2 className="text-2xl text-balance">Allow {data.client.name} to access your Splitup?</h2>
        {me ? (
          <p className="text-sm text-muted-foreground">
            Signed in as {me.name}
            {me.email ? ` (${me.email})` : ''}
          </p>
        ) : null}
      </div>

      <ul className="flex w-full flex-col divide-y divide-border/60 rounded-panel bg-background text-left">
        <li className="flex items-start gap-3 p-4">
          <Eye className="mt-0.5 size-5 shrink-0 text-foreground/70" aria-hidden="true" />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">See your Splitup</span>
            <span className="text-sm text-muted-foreground">
              Groups, friends, expenses, balances and activity.
            </span>
          </span>
        </li>
        {wantsWrite ? (
          <li className="flex items-start gap-3 p-4">
            <PencilLine className="mt-0.5 size-5 shrink-0 text-foreground/70" aria-hidden="true" />
            <label htmlFor="consent-write" className="flex flex-1 flex-col gap-0.5">
              <span className="font-medium">Make changes for you</span>
              <span className="text-sm text-muted-foreground">
                Add, edit and delete expenses and record payments. Every change shows in Activity
                and can be undone.
              </span>
            </label>
            <Switch
              id="consent-write"
              className="mt-1"
              checked={allowWrite}
              onCheckedChange={setAllowWrite}
              aria-label="Allow changes"
            />
          </li>
        ) : null}
      </ul>

      <p className="text-sm text-muted-foreground">
        You&rsquo;ll go back to <span className="font-medium text-foreground">{returnTo}</span>.
        Disconnect any time in Account → Connected apps &amp; MCP.
      </p>

      <div className="flex w-full flex-col gap-2">
        <Button
          size="cta"
          className="w-full"
          disabled={!online || busy}
          onClick={() => respond(true)}
        >
          {busy && answer.variables?.allow !== false ? <Spinner data-icon="inline-start" /> : null}
          Allow
        </Button>
        <Button
          variant="outline"
          size="pill"
          className="w-full"
          disabled={!online || busy}
          onClick={() => respond(false)}
        >
          Deny
        </Button>
      </div>
    </Card>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-center">
      <div className="flex w-full max-w-md flex-col items-center gap-5 rounded-card bg-card p-8 text-center">
        {children}
      </div>
    </div>
  );
}
