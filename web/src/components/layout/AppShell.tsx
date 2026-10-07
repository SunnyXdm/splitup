import { useState, type ReactNode } from 'react';
import { Link, matchPath, useLocation } from 'react-router';
import {
  Activity as ActivityIcon,
  CircleUserRound,
  Plus,
  Search,
  UserRound,
  Users,
} from 'lucide-react';
import ExpenseForm from '@/components/expense/ExpenseForm';
import ThemeToggle from '@/components/layout/ThemeToggle';
import { Button } from '@/components/ui/button';
import { useSyncData } from '@/lib/queries';
import { cn } from '@/lib/utils';

const TABS = [
  { to: '/', label: 'Groups', icon: Users },
  { to: '/friends', label: 'Friends', icon: UserRound },
  { to: '/activity', label: 'Activity', icon: ActivityIcon },
  { to: '/account', label: 'Account', icon: CircleUserRound },
] as const;

function isTabActive(to: string, pathname: string): boolean {
  if (to === '/') return pathname === '/' || pathname.startsWith('/groups');
  return pathname === to || pathname.startsWith(`${to}/`);
}

export default function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const [expenseOpen, setExpenseOpen] = useState(false);

  const { data: sync } = useSyncData();
  const incomingRequests = sync?.friendRequests?.incoming.length ?? 0;

  // The global "+" adds to whatever the current page is about: the group on a
  // group page, a 1:1 expense with that friend on a friend page.
  const routeId = (pattern: string) => {
    const match = matchPath(pattern, pathname);
    const parsed = match ? Number(match.params.id) : NaN;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  };
  const groupId = routeId('/groups/:id');
  const routeFriendId = routeId('/friends/:id');
  const friendId =
    routeFriendId !== null && sync?.friendIds.includes(routeFriendId) ? routeFriendId : undefined;
  const tabLabel = (to: string, label: string) =>
    to === '/friends' && incomingRequests > 0
      ? `${label}, ${incomingRequests} friend request${incomingRequests === 1 ? '' : 's'}`
      : undefined;

  return (
    <div className="min-h-svh bg-background">
      {/* Desktop: floating white pill nav */}
      <header className="pointer-events-none fixed inset-x-0 top-6 z-40 hidden justify-center px-4 md:flex">
        <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-card py-2 pr-2 pl-6 shadow-[0_4px_24px_rgba(0,0,0,0.04)]">
          <Link
            to="/"
            className="flex items-center gap-1 text-lg font-semibold tracking-tight text-foreground"
          >
            Splitup
            <span aria-hidden="true" className="size-1.5 rounded-full bg-signal" />
          </Link>
          <nav aria-label="Primary" className="flex items-center gap-1 px-3">
            {TABS.map(({ to, label }) => {
              const active = isTabActive(to, pathname);
              return (
                <Link
                  key={to}
                  to={to}
                  aria-current={active ? 'page' : undefined}
                  aria-label={tabLabel(to, label)}
                  className={cn(
                    'relative rounded-full px-3 py-1.5 text-sm transition-colors',
                    active
                      ? 'font-medium text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                  {to === '/friends' ? <RequestBadge count={incomingRequests} /> : null}
                </Link>
              );
            })}
          </nav>
          <Button className="rounded-full px-4" onClick={() => setExpenseOpen(true)}>
            <Plus data-icon="inline-start" aria-hidden="true" />
            Add expense
          </Button>
        </div>
      </header>

      {/* Desktop: search + theme toggle float beside the pill nav */}
      <div className="fixed top-7 right-6 z-40 hidden items-center gap-2 md:flex">
        <SearchButton active={pathname === '/search'} />
        <ThemeToggle />
      </div>

      {/* Mobile: slim in-flow header — wordmark left, search + theme toggle right */}
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))] md:hidden">
        <Link
          to="/"
          className="flex items-center gap-1 text-lg font-semibold tracking-tight text-foreground"
        >
          Splitup
          <span aria-hidden="true" className="size-1.5 rounded-full bg-signal" />
        </Link>
        <div className="flex items-center gap-2">
          <SearchButton active={pathname === '/search'} />
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl px-4 pt-6 pb-[calc(7.5rem+env(safe-area-inset-bottom))] md:pt-28 md:pb-16">
        {children}
      </main>

      {/* Mobile: bottom tab bar + raised FAB */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_24px_rgba(0,0,0,0.04)] md:hidden"
      >
        <div className="relative mx-auto grid max-w-md grid-cols-5">
          {TABS.map(({ to, label, icon: Icon }, i) => {
            const active = isTabActive(to, pathname);
            return (
              <Link
                key={to}
                to={to}
                aria-current={active ? 'page' : undefined}
                aria-label={tabLabel(to, label)}
                className={cn(
                  'relative flex min-h-14 flex-col items-center justify-center gap-1 py-2 transition-colors',
                  // leave the center column free for the FAB
                  i === 2 && 'col-start-4',
                  active ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                <span className="relative">
                  <Icon className="size-5" aria-hidden="true" />
                  {to === '/friends' ? <RequestBadge count={incomingRequests} /> : null}
                </span>
                <span className="text-[11px] leading-none">{label}</span>
              </Link>
            );
          })}
          <button
            type="button"
            aria-label="Add expense"
            onClick={() => setExpenseOpen(true)}
            className="absolute top-0 left-1/2 flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_4px_24px_rgba(0,0,0,0.08)] outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-[calc(-50%+1px)]"
          >
            <Plus className="size-6" aria-hidden="true" />
          </button>
        </div>
      </nav>

      <ExpenseForm
        open={expenseOpen}
        onOpenChange={setExpenseOpen}
        groupId={groupId}
        friendId={friendId}
      />
    </div>
  );
}

/** Round search entry, sized and styled to sit beside the theme toggle. */
function SearchButton({ active }: { active: boolean }) {
  return (
    <Link
      to="/search"
      aria-label="Search all expenses"
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex size-11 items-center justify-center rounded-full bg-card text-foreground shadow-[0_4px_24px_rgba(0,0,0,0.04)] outline-none transition-colors hover:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
        active && 'bg-primary text-primary-foreground hover:text-primary-foreground/80',
      )}
    >
      <Search className="size-5" aria-hidden="true" />
    </Link>
  );
}

/** Count of incoming friend requests, pinned to the Friends tab. */
function RequestBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span
      aria-hidden="true"
      className="absolute -top-1.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-signal px-1 text-[10px] leading-none font-semibold text-white tabular-nums"
    >
      {count > 9 ? '9+' : count}
    </span>
  );
}
