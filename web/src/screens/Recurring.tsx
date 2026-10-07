import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  CalendarClock,
  EllipsisVertical,
  Pause,
  PencilLine,
  Play,
  Plus,
  Repeat,
  Trash2,
} from 'lucide-react';
import { CategoryIcon } from '@/components/common/CategoryIcon';
import ExpenseForm from '@/components/expense/ExpenseForm';
import { todayISO } from '@/components/expense/money-input';
import { useOnline } from '@/components/layout/OfflineBanner';
import { PageHeader } from '@/components/layout/PageHeader';
import { DueBillsRow } from '@/components/recurring/DueToAdd';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { useDeleteRecurring, useSyncData, useUpdateRecurring } from '@/lib/queries';
import { cadenceLabel, ruleBlocker, scopeLabel, shortDate } from '@/lib/recurring';
import type { RecurringRule, SyncData } from '@/lib/types';

/**
 * Recurring bills: /recurring (all of mine + my groups'), or
 * /recurring?group=ID for one group. Only the person who set a bill up can
 * change it; everyone else in the group sees it read-only.
 */
export default function Recurring() {
  const { data: sync } = useSyncData();
  const [params] = useSearchParams();
  const [editing, setEditing] = useState<RecurringRule | undefined>();
  const [editOpen, setEditOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [deleting, setDeleting] = useState<RecurringRule | null>(null);

  if (!sync) {
    return (
      <div className="flex flex-col gap-4 pb-6">
        <Skeleton className="h-11 w-56 rounded-full" />
        <Skeleton className="h-24 rounded-card" />
      </div>
    );
  }

  const groupParam = Number(params.get('group'));
  const group = Number.isInteger(groupParam)
    ? sync.groups.find((g) => g.id === groupParam)
    : undefined;
  const rules = (sync.recurring?.rules ?? []).filter((r) => !group || r.groupId === group.id);
  const mine = rules.filter((r) => r.createdBy === sync.me.id);
  const others = rules.filter((r) => r.createdBy !== sync.me.id);

  const edit = (rule: RecurringRule) => {
    setEditing(rule);
    setEditOpen(true);
  };

  return (
    <div className="flex flex-col gap-6 pb-6">
      <PageHeader
        eyebrow={group ? `${group.emoji} ${group.name}` : undefined}
        title="Recurring bills"
        actions={
          <Button variant="outline" size="pill" onClick={() => setNewOpen(true)}>
            <Plus data-icon="inline-start" aria-hidden="true" />
            New
          </Button>
        }
        description={
          <>
            Rent, utilities and subscriptions. When one falls due it waits under &ldquo;Bills
            due&rdquo; on Home — nothing is recorded without you.
            {group ? (
              <>
                {' '}
                <Link to="/recurring" className="text-foreground underline underline-offset-4">
                  Show all recurring bills
                </Link>
              </>
            ) : null}
          </>
        }
      />

      <DueBillsRow sync={sync} showManageLink={false} />

      {rules.length === 0 ? (
        <Empty className="rounded-card bg-card py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="rounded-full">
              <Repeat />
            </EmptyMedia>
            <EmptyTitle>No recurring bills yet</EmptyTitle>
            <EmptyDescription>
              Tap <strong>New</strong>, then set <strong>Repeat</strong> to weekly, monthly or
              yearly — rent, utilities and subscriptions then show up here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {mine.length > 0 ? (
            <RuleList
              title="Set up by you"
              rules={mine}
              sync={sync}
              onEdit={edit}
              onDelete={setDeleting}
            />
          ) : null}
          {others.length > 0 ? (
            <RuleList title="Set up by others" rules={others} sync={sync} />
          ) : null}
        </>
      )}

      <ExpenseForm
        open={editOpen}
        onOpenChange={setEditOpen}
        groupId={editing?.groupId ?? null}
        rule={editing}
      />
      {/* TODO(expense-form owner): open this with Repeat preset to "monthly"
          (e.g. a `defaultRepeat` prop on ExpenseForm). Until then "New" opens
          the regular add-expense form and the person picks Repeat themselves. */}
      <ExpenseForm open={newOpen} onOpenChange={setNewOpen} groupId={group?.id ?? null} />
      <DeleteRuleDialog rule={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

function RuleList({
  title,
  rules,
  sync,
  onEdit,
  onDelete,
}: {
  title: string;
  rules: RecurringRule[];
  sync: SyncData;
  onEdit?: (rule: RecurringRule) => void;
  onDelete?: (rule: RecurringRule) => void;
}) {
  const today = todayISO();
  return (
    <section className="flex flex-col gap-3">
      <h2 className="px-1 text-sm font-medium text-muted-foreground">{title}</h2>
      <ul className="flex flex-col divide-y divide-border/60 rounded-card bg-card">
        {rules.map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            sync={sync}
            today={today}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </ul>
    </section>
  );
}

function RuleRow({
  rule,
  sync,
  today,
  onEdit,
  onDelete,
}: {
  rule: RecurringRule;
  sync: SyncData;
  today: string;
  onEdit?: (rule: RecurringRule) => void;
  onDelete?: (rule: RecurringRule) => void;
}) {
  const online = useOnline();
  const update = useUpdateRecurring();
  const t = rule.template;
  const owner = sync.users.find((u) => u.id === rule.createdBy)?.name ?? 'Someone';
  const blocker = ruleBlocker(rule, sync);
  const editable = onEdit !== undefined;
  // Occurrences that fell due but aren't recorded yet (only mine reach my inbox).
  const waiting = (sync.recurring?.pending ?? [])
    .filter((p) => p.ruleId === rule.id)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));

  const togglePause = () => {
    update.mutate(
      { id: rule.id, paused: !rule.paused },
      {
        onSuccess: () =>
          toast(rule.paused ? `${t.description} resumed` : `${t.description} paused`),
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  return (
    <li className="flex items-start gap-3 p-4">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-background">
        <CategoryIcon category={t.category} className="size-5 text-foreground/70" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-start gap-3">
          <p className="min-w-0 flex-1 font-medium break-words">{t.description}</p>
          <p className="shrink-0 font-medium tabular-nums">
            {formatMoney(t.amountCents, t.currency)}
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          {cadenceLabel(rule.cadence, rule.interval)} · {scopeLabel(rule, sync)}
          {!editable ? ` · set up by ${owner}` : null}
        </p>
        {waiting.length > 0 ? (
          <p className="flex items-center gap-1.5 text-sm font-medium text-warning">
            <CalendarClock className="size-4 shrink-0" aria-hidden="true" />
            Not recorded yet · due{' '}
            {waiting.map((p) => shortDate(p.dueDate, today)).join(', ')}
          </p>
        ) : null}
        <p className="text-sm">
          {rule.paused ? (
            <span className="font-medium text-muted-foreground">Paused</span>
          ) : (
            <>
              <span className="text-muted-foreground">Next on </span>
              {shortDate(rule.nextDue, today)}
            </>
          )}
        </p>
        {editable && blocker ? <p className="text-sm text-warning">{blocker}</p> : null}
      </div>
      {editable ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-lg"
                className="-mt-1 size-11 shrink-0 rounded-full"
                disabled={!online || update.isPending}
              />
            }
          >
            {update.isPending ? <Spinner /> : <EllipsisVertical aria-hidden="true" />}
            <span className="sr-only">Options for {t.description}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuItem disabled={blocker !== null} onClick={() => onEdit?.(rule)}>
              <PencilLine aria-hidden="true" /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={togglePause}>
              {rule.paused ? (
                <>
                  <Play aria-hidden="true" /> Resume
                </>
              ) : (
                <>
                  <Pause aria-hidden="true" /> Pause
                </>
              )}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => onDelete?.(rule)}>
              <Trash2 aria-hidden="true" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}

function DeleteRuleDialog({ rule, onClose }: { rule: RecurringRule | null; onClose: () => void }) {
  const remove = useDeleteRecurring();
  const confirm = () => {
    if (!rule) return;
    remove.mutate(rule.id, {
      onSuccess: () => {
        toast(`${rule.template.description} deleted`);
        onClose();
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };
  return (
    <AlertDialog open={rule !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this recurring bill?</AlertDialogTitle>
          <AlertDialogDescription>
            “{rule?.template.description}” stops repeating and its due items leave your inbox.
            Expenses already added stay as they are.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="rounded-full">Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className="rounded-full"
            disabled={remove.isPending}
            onClick={confirm}
          >
            {remove.isPending ? <Spinner data-icon="inline-start" /> : null}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
