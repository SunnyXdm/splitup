import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { formatDistanceToNow } from 'date-fns';
import {
  Archive,
  ChevronRight,
  CloudOff,
  Download,
  LogOut,
  Monitor,
  Moon,
  MoonStar,
  PencilLine,
  Repeat,
  Sun,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuthActions } from '@/components/auth/auth-context';
import { useOnline } from '@/components/layout/OfflineBanner';
import { PageHeader } from '@/components/layout/PageHeader';
import { useTheme, type Theme } from '@/components/theme-provider';
import { FormSheet } from '@/components/common/FormSheet';
import { NotificationsSetting } from '@/components/common/NotificationsSetting';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PickerSelect } from '@/components/ui/picker-select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { currencyPickerOptions } from '@/components/common/currency-options';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { archivedGroups } from '@/lib/archive';
import { buildGroupCsv, downloadCsv } from '@/lib/export-csv';
import { useSignOut, useSyncData, useUpdateMe } from '@/lib/queries';
import type { Group, SyncData } from '@/lib/types';

/**
 * Account: who you are (once), your preferences, then the places you manage
 * things from (recurring bills, archived groups, export), then the device's
 * offline data and sign-out.
 */
export default function Account() {
  const sync = useSyncData();
  const me = sync.data?.me;
  const online = useOnline();
  const updateMe = useUpdateMe();
  const signOut = useSignOut();
  const { clearIdentity } = useAuthActions();
  const { theme, setTheme } = useTheme();
  const [nameOpen, setNameOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  if (!me || !sync.data) return null; // AuthGate guarantees sync data before rendering screens
  const data = sync.data;

  const changeCurrency = (value: unknown) => {
    if (typeof value !== 'string' || value === me.defaultCurrency) return;
    updateMe.mutate(
      { defaultCurrency: value },
      {
        onSuccess: () => toast.success(`Default currency set to ${value}`),
        onError: (err) => toast.error(err.message),
      },
    );
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut.mutateAsync();
      clearIdentity();
      window.location.assign('/');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sign-out failed');
      setSigningOut(false);
    }
  };

  const recurringCount = data.recurring?.rules.length ?? 0;
  const archivedCount = archivedGroups(data.groups).length;
  const lastSynced = sync.dataUpdatedAt
    ? formatDistanceToNow(sync.dataUpdatedAt, { addSuffix: true })
    : 'never';

  return (
    <div className="flex flex-col gap-8 pb-6">
      <PageHeader title="Account" />

      {/* Profile: the identity block, shown once, with its one editable field. */}
      <section aria-label="Profile" className="flex items-center gap-4 rounded-card bg-card p-5">
        <UserAvatar user={me} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-xl font-medium tracking-[-0.02em] break-words">{me.name}</p>
          {me.email ? (
            <p className="text-sm break-all text-muted-foreground">{me.email}</p>
          ) : null}
        </div>
        <Button
          variant="outline"
          size="pill"
          className="self-center"
          disabled={!online}
          onClick={() => setNameOpen(true)}
          aria-label="Edit your name"
        >
          <PencilLine data-icon="inline-start" aria-hidden="true" />
          Edit
        </Button>
      </section>

      <Section title="Preferences">
        <div className="flex flex-col divide-y divide-border/60 rounded-card bg-card">
          <SettingBlock label="Appearance" htmlFor={undefined}>
            {/* Works offline — it's a local preference, so no online gating. */}
            <ToggleGroup
              value={[theme]}
              onValueChange={(v) => {
                if (v[0]) setTheme(v[0] as Theme);
              }}
              className="grid w-full grid-cols-2 gap-2 sm:grid-cols-4"
              aria-label="Theme"
            >
              {(
                [
                  ['system', 'System', Monitor],
                  ['light', 'Light', Sun],
                  ['dark', 'Dark', Moon],
                  ['amoled', 'AMOLED', MoonStar],
                ] as const
              ).map(([value, label, Icon]) => (
                <ToggleGroupItem
                  key={value}
                  value={value}
                  variant="outline"
                  className="h-11 min-w-0 rounded-full aria-pressed:border-primary aria-pressed:bg-muted"
                >
                  <Icon aria-hidden="true" />
                  {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </SettingBlock>
          <SettingBlock label="Default currency" htmlFor="account-currency">
            <PickerSelect
              id="account-currency"
              title="Default currency"
              value={me.defaultCurrency}
              onValueChange={changeCurrency}
              disabled={!online || updateMe.isPending}
              options={currencyPickerOptions()}
            />
            <p className="text-sm text-muted-foreground">
              Used for new groups and non-group expenses, and shown first in your totals.
            </p>
          </SettingBlock>
          <div className="p-5">
            <NotificationsSetting />
          </div>
        </div>
      </Section>

      <Section title="Manage">
        <ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-card bg-card">
          <li>
            <NavRow
              to="/recurring"
              icon={<Repeat className="size-5" aria-hidden="true" />}
              title="Recurring bills"
              detail={
                recurringCount === 0
                  ? 'Rent, utilities, subscriptions'
                  : recurringCount === 1
                    ? '1 bill'
                    : `${recurringCount} bills`
              }
            />
          </li>
          <li>
            <NavRow
              to="/groups/archived"
              icon={<Archive className="size-5" aria-hidden="true" />}
              title="Archived groups"
              detail={archivedCount === 0 ? 'None' : `${archivedCount} hidden from Home`}
            />
          </li>
          {data.groups.length > 0 ? (
            <li>
              <ExportRow sync={data} />
            </li>
          ) : null}
        </ul>
      </Section>

      <Section title="This device">
        <div className="flex flex-col gap-4 rounded-card bg-card p-5">
          <div className="flex items-start gap-3">
            <CloudOff className="mt-0.5 size-5 shrink-0 text-foreground/70" aria-hidden="true" />
            <div className="flex flex-col gap-1">
              <p>
                Splitup works offline — new expenses are saved as drafts and you add them when
                you&rsquo;re back online.
              </p>
              <p className="text-sm text-muted-foreground">Last synced {lastSynced}.</p>
            </div>
          </div>
          <Button
            variant="outline"
            size="pill"
            className="self-start"
            disabled={!online || signingOut}
            onClick={handleSignOut}
          >
            {signingOut ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <LogOut data-icon="inline-start" aria-hidden="true" />
            )}
            Sign out
          </Button>
        </div>
      </Section>

      <EditNameSheet open={nameOpen} onOpenChange={setNameOpen} current={me.name} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = `account-${title.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="px-1 text-sm font-medium text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function SettingBlock({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 p-5">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="font-medium">
          {label}
        </label>
      ) : (
        <p className="font-medium">{label}</p>
      )}
      {children}
    </div>
  );
}

const rowClass =
  'flex min-h-16 w-full items-center gap-4 px-5 py-3 text-left transition-colors outline-none hover:bg-secondary focus-visible:ring-3 focus-visible:ring-focus-ring focus-visible:ring-inset';

function NavRow({
  to,
  icon,
  title,
  detail,
}: {
  to: string;
  icon: ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <Link to={to} className={rowClass}>
      <RowContent icon={icon} title={title} detail={detail} />
      <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </Link>
  );
}

function RowContent({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <>
      <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-background text-foreground/70">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">{title}</span>
        <span className="text-sm text-muted-foreground">{detail}</span>
      </span>
    </>
  );
}

/** "Export expenses" — pick a group; its expenses download as CSV. */
function ExportRow({ sync }: { sync: SyncData }) {
  const [open, setOpen] = useState(false);
  const groups = [...sync.groups].sort((a, b) => a.name.localeCompare(b.name));
  const exportGroup = (group: Group) => {
    downloadCsv(`${group.name}.csv`, buildGroupCsv(sync, group.id));
    toast.success(`Exported ${group.name}`);
    setOpen(false);
  };
  return (
    <>
      <button type="button" className={rowClass} onClick={() => setOpen(true)}>
        <RowContent
          icon={<Download className="size-5" aria-hidden="true" />}
          title="Export expenses"
          detail="Download a group’s expenses as a CSV file"
        />
        <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="mx-auto max-h-[80dvh] w-full max-w-xl rounded-t-card"
        >
          <SheetHeader className="pr-14">
            <SheetTitle className="text-xl">Export which group?</SheetTitle>
            <SheetDescription>Works offline — it uses the data on this device.</SheetDescription>
          </SheetHeader>
          <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {groups.map((g) => (
              <li key={g.id}>
                <button
                  type="button"
                  onClick={() => exportGroup(g)}
                  className="flex min-h-12 w-full items-center gap-3 rounded-panel px-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  <span className="flex size-8 items-center justify-center text-xl" aria-hidden="true">
                    {g.emoji}
                  </span>
                  <span className="min-w-0 flex-1 font-medium break-words">{g.name}</span>
                  <Download className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </SheetContent>
      </Sheet>
    </>
  );
}

function EditNameSheet({
  open,
  onOpenChange,
  current,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: string;
}) {
  const online = useOnline();
  const updateMe = useUpdateMe();
  const [name, setName] = useState(current);
  const trimmed = name.trim();
  const canSave =
    trimmed.length > 0 && trimmed.length <= 80 && trimmed !== current && online && !updateMe.isPending;

  const handleOpenChange = (next: boolean) => {
    if (next) setName(current);
    onOpenChange(next);
  };

  const save = () => {
    if (!canSave) return;
    updateMe.mutate(
      { name: trimmed },
      {
        onSuccess: () => {
          toast.success('Name updated');
          onOpenChange(false);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };

  return (
    <FormSheet
      open={open}
      onOpenChange={handleOpenChange}
      title="Your name"
      description="This is how you appear to friends and in groups."
      onSubmit={save}
      submitLabel="Save name"
      pending={updateMe.isPending}
      submitDisabled={!canSave}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="account-name">Name</FieldLabel>
          <Input
            id="account-name"
            value={name}
            maxLength={80}
            autoComplete="name"
            className="h-11"
            onChange={(e) => setName(e.target.value)}
          />
          <FieldDescription>Up to 80 characters.</FieldDescription>
        </Field>
      </FieldGroup>
    </FormSheet>
  );
}
