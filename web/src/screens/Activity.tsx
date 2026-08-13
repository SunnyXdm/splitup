import { format, formatDistanceToNow, isToday, isYesterday } from 'date-fns';
import {
  CalendarClock,
  HandCoins,
  HeartHandshake,
  PencilLine,
  ReceiptText,
  Sparkles,
  Trash2,
  UserRoundMinus,
  UserRoundPlus,
  type LucideIcon,
} from 'lucide-react';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { useSyncData } from '@/lib/queries';
import type { ActivityItem, ActivityType } from '@/lib/types';

const TYPE_ICON: Record<ActivityType, LucideIcon> = {
  expense_added: ReceiptText,
  expense_updated: PencilLine,
  expense_deleted: Trash2,
  payment_added: HandCoins,
  group_created: Sparkles,
  group_renamed: PencilLine,
  member_joined: UserRoundPlus,
  member_removed: UserRoundMinus,
  friend_added: HeartHandshake,
};

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (isToday(d)) return 'Today';
  if (isYesterday(d)) return 'Yesterday';
  return format(d, 'MMMM d, yyyy');
}

export default function Activity() {
  const { data: sync } = useSyncData();

  if (!sync) return <ActivitySkeleton />;

  const sorted = [...sync.activity].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const days: { label: string; items: ActivityItem[] }[] = [];
  for (const item of sorted) {
    const label = dayLabel(item.createdAt);
    const last = days[days.length - 1];
    if (last && last.label === label) last.items.push(item);
    else days.push({ label, items: [item] });
  }

  return (
    <div className="flex flex-col gap-4 pb-6">
      <span className="eyebrow">Activity</span>
      {days.length === 0 ? (
        <Empty className="rounded-[28px] bg-card py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="rounded-full">
              <CalendarClock />
            </EmptyMedia>
            <EmptyTitle>No activity yet</EmptyTitle>
            <EmptyDescription>
              Expenses, payments, and group changes will show up here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-6">
          {days.map(({ label, items }) => (
            <section key={label} className="flex flex-col gap-2">
              <h2 className="px-1 text-sm font-medium text-muted-foreground">{label}</h2>
              <div className="flex flex-col divide-y divide-border/60 rounded-[28px] bg-card px-4">
                {items.map((item) => {
                  const Icon = TYPE_ICON[item.type] ?? ReceiptText;
                  return (
                    <div key={item.id} className="flex min-h-16 items-center gap-3 py-3">
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-background">
                        <Icon className="size-4 text-foreground/70" aria-hidden="true" />
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <p className="text-sm">{item.summary}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function ActivitySkeleton() {
  return (
    <div className="flex flex-col gap-4 pb-6">
      <Skeleton className="h-4 w-24 rounded-full" />
      <Skeleton className="h-48 rounded-[28px]" />
      <Skeleton className="h-48 rounded-[28px]" />
    </div>
  );
}
