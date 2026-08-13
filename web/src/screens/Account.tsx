import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { LogOut, Monitor, Moon, MoonStar, Sun } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthActions } from '@/components/auth/auth-context';
import { useOnline } from '@/components/layout/OfflineBanner';
import { useTheme, type Theme } from '@/components/theme-provider';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PickerSelect } from '@/components/ui/picker-select';
import { currencyPickerOptions } from '@/components/common/currency-options';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useSignOut, useSyncData, useUpdateMe } from '@/lib/queries';

export default function Account() {
  const sync = useSyncData();
  const me = sync.data?.me;
  const online = useOnline();
  const updateMe = useUpdateMe();
  const signOut = useSignOut();
  const { clearIdentity } = useAuthActions();
  const { theme, setTheme } = useTheme();
  const [name, setName] = useState(me?.name ?? '');
  const [signingOut, setSigningOut] = useState(false);

  if (!me) return null; // AuthGate guarantees sync data before rendering screens

  const trimmed = name.trim();
  const canSaveName =
    trimmed.length > 0 &&
    trimmed.length <= 80 &&
    trimmed !== me.name &&
    online &&
    !updateMe.isPending;

  const saveName = () => {
    updateMe.mutate(
      { name: trimmed },
      {
        onSuccess: () => toast.success('Name updated'),
        onError: (err) => toast.error(err.message),
      },
    );
  };

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

  const lastSynced = sync.dataUpdatedAt
    ? formatDistanceToNow(sync.dataUpdatedAt, { addSuffix: true })
    : 'never';

  return (
    <div className="flex flex-col gap-6">
      <span className="eyebrow">Account</span>

      <div className="flex items-center gap-4 rounded-[28px] bg-card p-6">
        <UserAvatar user={me} size="lg" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="truncate text-xl">{me.name}</h1>
          {me.email ? (
            <p className="truncate text-sm text-muted-foreground">{me.email}</p>
          ) : null}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="account-name">Name</FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="account-name"
                  value={name}
                  maxLength={80}
                  autoComplete="name"
                  className="h-11"
                  disabled={!online || updateMe.isPending}
                  onChange={(e) => setName(e.target.value)}
                />
                <Button
                  className="h-11 rounded-full px-5"
                  disabled={!canSaveName}
                  onClick={saveName}
                >
                  {updateMe.isPending ? <Spinner data-icon="inline-start" /> : null}
                  Save
                </Button>
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="account-currency">Default currency</FieldLabel>
              <PickerSelect
                id="account-currency"
                title="Default currency"
                value={me.defaultCurrency}
                onValueChange={changeCurrency}
                disabled={!online || updateMe.isPending}
                options={currencyPickerOptions()}
              />
              <FieldDescription>
                Used for new groups and non-group expenses.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Works offline — it's a local preference, so no online gating. */}
          <ToggleGroup
            value={[theme]}
            onValueChange={(v) => {
              if (v[0]) setTheme(v[0] as Theme);
            }}
            className="w-full"
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
                className="h-11 min-w-0 flex-1 rounded-full aria-pressed:border-primary"
              >
                <Icon aria-hidden="true" />
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Offline data</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">
            Your data is saved on this device so Splitup works offline, read-only.
          </p>
          <p className="text-sm">Last synced {lastSynced}.</p>
        </CardContent>
      </Card>

      <Button
        variant="outline"
        className="h-11 self-start rounded-full px-6"
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
  );
}
