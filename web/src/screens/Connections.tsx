import { useState, type ReactNode } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Check, Copy, KeyRound, Plus, PlugZap } from 'lucide-react';
import { toast } from 'sonner';
import { FormSheet } from '@/components/common/FormSheet';
import { useOnline } from '@/components/layout/OfflineBanner';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  clientSnippets,
  scopeLabel,
  useConnections,
  useCreateToken,
  useRevokeApp,
  useRevokeToken,
  type CreatedToken,
} from '@/lib/connections';

const ago = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true });

/**
 * Account → Connected apps & MCP: the MCP server URL for connectors, the apps
 * connected through OAuth, and personal access tokens for CLI tools.
 */
export default function Connections() {
  const connections = useConnections();
  const online = useOnline();
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [revoking, setRevoking] = useState<{
    kind: 'app' | 'token';
    id: number;
    name: string;
  } | null>(null);
  const revokeApp = useRevokeApp();
  const revokeToken = useRevokeToken();
  const data = connections.data;

  const confirmRevoke = () => {
    if (!revoking) return;
    const mutation = revoking.kind === 'app' ? revokeApp : revokeToken;
    mutation.mutate(revoking.id, {
      onSuccess: () => {
        toast.success(`${revoking.name} can no longer access your Splitup`);
        setRevoking(null);
      },
      onError: (err) => toast.error(err.message),
    });
  };

  return (
    <div className="flex flex-col gap-8 pb-6">
      <PageHeader
        title="Connected apps & MCP"
        description="Let AI assistants like Claude and ChatGPT read your balances and add expenses for you."
      />

      <Section title="MCP server">
        <div className="flex flex-col gap-3 rounded-card bg-card p-5">
          {data ? (
            <CopyField value={data.mcpUrl} label="MCP server URL" />
          ) : (
            <Skeleton className="h-11 w-full rounded-full" />
          )}
          <p className="text-sm text-muted-foreground">
            In Claude (Settings → Connectors → Add custom connector) or ChatGPT (add a custom MCP
            connector), paste this URL. You&rsquo;ll sign in here and choose what it may do. For
            Claude Code, Codex, Cursor and other CLI tools, create a token below.
          </p>
        </div>
      </Section>

      <Section title="Connected apps">
        {!data ? (
          <Skeleton className="h-20 w-full rounded-card" />
        ) : data.apps.length === 0 ? (
          <p className="rounded-card bg-card p-5 text-sm text-muted-foreground">
            No apps connected yet.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border/60 rounded-card bg-card">
            {data.apps.map((app) => (
              <Row
                key={app.id}
                icon={<PlugZap className="size-5" aria-hidden="true" />}
                title={app.name}
                detail={`${scopeLabel(app.scopes)} · connected ${ago(app.connectedAt)}${
                  app.lastUsedAt ? ` · used ${ago(app.lastUsedAt)}` : ''
                }`}
                action={
                  <Button
                    variant="outline"
                    size="pill"
                    disabled={!online}
                    onClick={() => setRevoking({ kind: 'app', id: app.id, name: app.name })}
                  >
                    Disconnect
                  </Button>
                }
              />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Personal access tokens"
        action={
          <Button
            variant="outline"
            size="pill"
            disabled={!online || !data}
            onClick={() => setCreateOpen(true)}
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            Create token
          </Button>
        }
      >
        {!data ? (
          <Skeleton className="h-20 w-full rounded-card" />
        ) : data.tokens.length === 0 ? (
          <p className="rounded-card bg-card p-5 text-sm text-muted-foreground">
            Tokens let command-line tools such as Claude Code or Codex use Splitup. Treat them like
            passwords.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border/60 rounded-card bg-card">
            {data.tokens.map((t) => (
              <Row
                key={t.id}
                icon={<KeyRound className="size-5" aria-hidden="true" />}
                title={t.name}
                detail={`spu_…${t.hint} · ${scopeLabel(t.scopes)} · created ${ago(t.createdAt)} · ${
                  t.lastUsedAt ? `used ${ago(t.lastUsedAt)}` : 'never used'
                }`}
                action={
                  <Button
                    variant="outline"
                    size="pill"
                    disabled={!online}
                    onClick={() => setRevoking({ kind: 'token', id: t.id, name: t.name })}
                  >
                    Revoke
                  </Button>
                }
              />
            ))}
          </ul>
        )}
      </Section>

      <CreateTokenSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(token) => {
          setCreateOpen(false);
          setCreated(token);
        }}
      />
      {data ? (
        <TokenCreatedSheet token={created} mcpUrl={data.mcpUrl} onClose={() => setCreated(null)} />
      ) : null}

      <AlertDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {revoking?.kind === 'app' ? 'Disconnect' : 'Revoke'} {revoking?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              It stops working immediately. Changes it already made stay in your history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full">Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="rounded-full"
              disabled={!online || revokeApp.isPending || revokeToken.isPending}
              onClick={confirmRevoke}
            >
              {revoking?.kind === 'app' ? 'Disconnect' : 'Revoke'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = `connections-${title.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex min-h-11 items-center justify-between gap-3 px-1">
        <h2 id={id} className="text-sm font-medium text-muted-foreground">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Row({
  icon,
  title,
  detail,
  action,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  action: ReactNode;
}) {
  return (
    <li className="flex min-h-16 flex-wrap items-center gap-4 px-5 py-3">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-background text-foreground/70">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium break-words">{title}</span>
        <span className="text-sm text-muted-foreground">{detail}</span>
      </span>
      {action}
    </li>
  );
}

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => toast.error('Couldn’t copy — select the text and copy it instead'),
    );
  };
  return [copied, copy];
}

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, copy] = useCopy();
  return (
    <div className="flex items-center gap-2 rounded-full bg-background py-1 pr-1 pl-4">
      <code className="min-w-0 flex-1 truncate font-mono text-sm" title={value}>
        {value}
      </code>
      <Button
        variant="ghost"
        size="icon"
        className="size-11 shrink-0 rounded-full"
        aria-label={`Copy ${label}`}
        onClick={() => copy(value)}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Button>
    </div>
  );
}

function CodeBlock({ code, label }: { code: string; label: string }) {
  const [copied, copy] = useCopy();
  return (
    <div className="relative rounded-panel bg-background">
      <pre className="overflow-x-auto p-4 pr-14 font-mono text-xs leading-relaxed whitespace-pre">
        {code}
      </pre>
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-1.5 right-1.5 size-11 rounded-full"
        aria-label={`Copy ${label}`}
        onClick={() => copy(code)}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Button>
    </div>
  );
}

function CreateTokenSheet({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (token: CreatedToken) => void;
}) {
  const online = useOnline();
  const create = useCreateToken();
  const [name, setName] = useState('');
  const [write, setWrite] = useState(true);
  const trimmed = name.trim();

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setName('');
      setWrite(true);
    }
    onOpenChange(next);
  };

  const submit = () => {
    if (!trimmed || create.isPending) return;
    create.mutate(
      {
        name: trimmed,
        scopes: write ? ['splitup.read', 'splitup.write'] : ['splitup.read'],
      },
      { onSuccess: onCreated, onError: (err) => toast.error(err.message) },
    );
  };

  return (
    <FormSheet
      open={open}
      onOpenChange={handleOpenChange}
      title="Create a token"
      description="For Claude Code, Codex, Cursor and other tools that connect with a token."
      onSubmit={submit}
      submitLabel="Create token"
      pending={create.isPending}
      submitDisabled={!trimmed || !online}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="token-name">Name</FieldLabel>
          <Input
            id="token-name"
            value={name}
            maxLength={60}
            placeholder="Claude Code on my laptop"
            className="h-11"
            onChange={(e) => setName(e.target.value)}
          />
          <FieldDescription>Shown in Activity as “via {trimmed || 'this name'}”.</FieldDescription>
        </Field>
        <Field orientation="horizontal">
          <span className="flex flex-1 flex-col gap-0.5">
            <FieldLabel htmlFor="token-write">Allow changes</FieldLabel>
            <FieldDescription>
              Add, edit and delete expenses and record payments. Off = read only.
            </FieldDescription>
          </span>
          <Switch id="token-write" checked={write} onCheckedChange={setWrite} />
        </Field>
      </FieldGroup>
    </FormSheet>
  );
}

function TokenCreatedSheet({
  token,
  mcpUrl,
  onClose,
}: {
  token: CreatedToken | null;
  mcpUrl: string;
  onClose: () => void;
}) {
  const snippets = token ? clientSnippets(mcpUrl, token.token) : [];
  return (
    <Sheet open={token !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[92dvh] w-full max-w-xl gap-0 rounded-t-card"
      >
        <SheetHeader className="pr-14">
          <SheetTitle className="text-xl">Copy your token now</SheetTitle>
          <SheetDescription>
            This is the only time it&rsquo;s shown. Anyone with it can{' '}
            {token?.scopes.includes('splitup.write') ? 'see and change' : 'see'} your Splitup.
          </SheetDescription>
        </SheetHeader>
        {token ? (
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4">
            <CopyField value={token.token} label="token" />
            <Tabs defaultValue={snippets[0].id} className="gap-3">
              <TabsList className="w-full rounded-full p-1">
                {snippets.map((s) => (
                  <TabsTrigger key={s.id} value={s.id} className="rounded-full text-xs sm:text-sm">
                    {s.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              {snippets.map((s) => (
                <TabsContent key={s.id} value={s.id} className="flex flex-col gap-2">
                  <p className="text-sm text-muted-foreground">{s.where}</p>
                  <CodeBlock code={s.code} label={`${s.label} setup`} />
                </TabsContent>
              ))}
            </Tabs>
          </div>
        ) : null}
        <SheetFooter className="pb-[max(1rem,env(safe-area-inset-bottom))]">
          <Button size="cta" className="w-full" onClick={onClose}>
            Done
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
