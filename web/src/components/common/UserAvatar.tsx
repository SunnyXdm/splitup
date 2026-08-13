import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import type { User } from '@/lib/types';

const sizeClass = { sm: 'size-7', md: 'size-9', lg: 'size-12' } as const;

export function UserAvatar({
  user,
  size = 'md',
  className,
}: {
  user?: User;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
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
