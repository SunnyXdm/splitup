import { UserRound } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { isGuest } from '@/lib/guests';
import { cn } from '@/lib/utils';
import type { User } from '@/lib/types';

const sizeClass = { sm: 'size-7', md: 'size-9', lg: 'size-12' } as const;
const iconClass = { sm: 'size-3.5', md: 'size-4', lg: 'size-6' } as const;

export function UserAvatar({
  user,
  size = 'md',
  className,
}: {
  user?: User;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  // Guests get a neutral, dashed placeholder instead of initials, so a
  // tracked-by-hand person never reads as someone with an account.
  if (isGuest(user)) {
    return (
      <Avatar
        className={cn(
          sizeClass[size],
          'after:border-dashed after:border-muted-foreground/60',
          className,
        )}
      >
        <AvatarFallback className="bg-background">
          <UserRound className={iconClass[size]} aria-label={`${user?.name} (guest)`} />
        </AvatarFallback>
      </Avatar>
    );
  }
  const initials = (user?.name ?? '?')
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <Avatar className={cn(sizeClass[size], className)}>
      {user?.picture ? <AvatarImage src={user.picture} alt={user.name} /> : null}
      <AvatarFallback>{initials}</AvatarFallback>
    </Avatar>
  );
}

/** Small "Guest" label next to a guest's name. */
export function GuestPill({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border border-border px-2 py-0.5 text-[11px] leading-none font-medium text-muted-foreground',
        className,
      )}
    >
      Guest
    </span>
  );
}
