import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronRight, Plus, UserRoundPlus } from 'lucide-react';
import { AnimatedMoney } from '@/components/common/MoneyText';
import { Button } from '@/components/ui/button';
import { orderByCurrency, type GrossBalance } from '@/lib/balances';
import { formatMoney } from '@/lib/money';
import { useEntrance } from '@/lib/motion';
import { cn } from '@/lib/utils';

interface Amount {
  currency: string;
  cents: number;
}

/**
 * The ink stadium at the top of Home. Two separate, tappable totals — what
 * I'm owed and what I owe, summed per person (gross) — so opposite debts
 * never hide each other behind a net. Each opens Friends filtered to that
 * direction. The default currency leads; other currencies are small chips.
 */
export function BalanceHero({
  gross,
  defaultCurrency,
}: {
  gross: GrossBalance[];
  defaultCurrency: string;
}) {
  // The count-up is a first-visit moment; later visits show the number and
  // only animate when it actually changes.
  const countUp = useEntrance('home-hero');
  const ordered = orderByCurrency(gross, defaultCurrency);
  const owed = ordered
    .filter((g) => g.owedCents > 0)
    .map((g) => ({ currency: g.currency, cents: g.owedCents }));
  const owing = ordered
    .filter((g) => g.owingCents > 0)
    .map((g) => ({ currency: g.currency, cents: g.owingCents }));
  // Net, only where it adds something: a currency with both directions open.
  const nets = ordered.filter((g) => g.owedCents > 0 && g.owingCents > 0);

  return (
    <HeroFrame labelledBy="balances-title">
      <h2 id="balances-title" className="text-sm text-ink-surface-muted">
        Your balances
      </h2>
      {owed.length === 0 && owing.length === 0 ? (
        <div className="flex flex-col gap-1 pt-3 pb-1">
          <p className="text-[28px] leading-tight font-medium tracking-[-0.02em]">
            You&rsquo;re all settled up
          </p>
          <p className="text-sm text-ink-surface-muted">
            Nobody owes anybody — new expenses will show up here.
          </p>
        </div>
      ) : (
        <div className="-mx-3 mt-1 flex flex-col">
          <BalanceLine
            label="You’re owed"
            amounts={owed}
            to="/friends?show=owed"
            linkLabel="See who owes you"
            countUp={countUp}
            emptyText="Nobody owes you"
          />
          <div aria-hidden="true" className="mx-3 h-px bg-current opacity-10" />
          <BalanceLine
            label="You owe"
            amounts={owing}
            to="/friends?show=owe"
            linkLabel="See who you owe"
            countUp={countUp}
            emptyText="You don’t owe anyone"
          />
        </div>
      )}
      {nets.length > 0 ? (
        <p className="mt-1 text-sm text-ink-surface-muted">
          {'Net: '}
          {nets.map((g, i) => {
            const net = g.owedCents - g.owingCents;
            const money = formatMoney(Math.abs(net), g.currency);
            return (
              <span key={g.currency}>
                {i > 0 ? ' · ' : null}
                {net === 0 ? (
                  `${g.currency} evens out`
                ) : net > 0 ? (
                  <>
                    <span className="tabular-nums">{money}</span> in your favour
                  </>
                ) : (
                  <>
                    you owe <span className="tabular-nums">{money}</span> overall
                  </>
                )}
              </span>
            );
          })}
        </p>
      ) : null}
    </HeroFrame>
  );
}

/** First-run hero: no groups, friends or expenses yet. */
export function WelcomeHero({
  onNewGroup,
  onAddFriend,
}: {
  onNewGroup: () => void;
  onAddFriend: () => void;
}) {
  return (
    <HeroFrame labelledBy="welcome-title">
      <div className="flex flex-col gap-2 pr-16">
        <h2
          id="welcome-title"
          className="text-[28px] leading-tight font-medium tracking-[-0.02em] sm:text-[32px]"
        >
          Split your first bill
        </h2>
        <p className="text-base text-ink-surface-muted">
          Start a group for your flat or a trip, or add a friend to split things one-to-one.
        </p>
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        <Button
          size="cta"
          className="bg-ink-surface-foreground text-ink-surface hover:bg-ink-surface-foreground/90"
          onClick={onNewGroup}
        >
          <Plus data-icon="inline-start" aria-hidden="true" />
          New group
        </Button>
        <Button
          size="cta"
          variant="outline"
          className="border-ink-surface-foreground/40 bg-transparent text-ink-surface-foreground hover:bg-ink-surface-foreground/10 hover:text-ink-surface-foreground dark:border-ink-surface-foreground/40 dark:bg-transparent dark:hover:bg-ink-surface-foreground/10"
          onClick={onAddFriend}
        >
          <UserRoundPlus data-icon="inline-start" aria-hidden="true" />
          Add friend
        </Button>
      </div>
    </HeroFrame>
  );
}

function HeroFrame({ labelledBy, children }: { labelledBy: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={labelledBy}
      className="relative overflow-hidden rounded-hero px-6 pt-6 pb-5 ink-surface sm:px-8 sm:pt-7"
    >
      {/* One thin orbit arc, tucked into the top-right corner — behind no text. */}
      <svg
        className="pointer-events-none absolute top-0 right-0 h-20 w-36"
        viewBox="0 0 144 80"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M 40 -6 C 70 30, 104 44, 152 40"
          stroke="var(--signal)"
          strokeWidth="1.5"
          strokeLinecap="round"
          opacity="0.9"
        />
        <circle cx="122" cy="38" r="3" fill="var(--signal)" />
      </svg>
      <div className="relative">{children}</div>
    </section>
  );
}

function BalanceLine({
  label,
  amounts,
  to,
  linkLabel,
  countUp,
  emptyText,
}: {
  label: string;
  amounts: Amount[];
  to: string;
  linkLabel: string;
  countUp: boolean;
  emptyText: string;
}) {
  const [lead, ...rest] = amounts;
  if (!lead) {
    return (
      <div className="flex min-h-16 flex-col justify-center px-3 py-3">
        <span className="text-sm text-ink-surface-muted">{label}</span>
        <span className="text-lg text-ink-surface-muted">{emptyText}</span>
      </div>
    );
  }
  const spoken = amounts.map((a) => formatMoney(a.cents, a.currency)).join(', ');
  return (
    <Link
      to={to}
      aria-label={`${label} ${spoken}. ${linkLabel}`}
      className="group/line flex min-h-16 items-center gap-3 rounded-panel px-3 py-3 outline-none hover:bg-ink-surface-foreground/5 focus-visible:ring-3 focus-visible:ring-focus-ring"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm text-ink-surface-muted">{label}</span>
        <AnimatedMoney
          cents={lead.cents}
          currency={lead.currency}
          animateOnMount={countUp}
          className="text-[28px] leading-tight font-medium tracking-[-0.02em] sm:text-[32px]"
        />
        {rest.length > 0 ? (
          <span className="mt-1 flex flex-wrap gap-1.5">
            {rest.map((a) => (
              <span
                key={a.currency}
                className="rounded-full bg-ink-surface-foreground/10 px-2.5 py-0.5 text-sm tabular-nums"
              >
                + {formatMoney(a.cents, a.currency)}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      <ChevronRight
        className={cn(
          'size-5 shrink-0 text-ink-surface-muted transition-transform',
          'group-hover/line:translate-x-0.5',
        )}
        aria-hidden="true"
      />
    </Link>
  );
}
