/* eslint-disable react-refresh/only-export-components */
import { useSyncExternalStore } from 'react';
import { WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';

function subscribe(callback: () => void) {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}

/**
 * Slim in-flow strip shown while offline. AppShell renders it at the top of
 * <main>, under the header, so it never floats over content or actions.
 */
export function OfflineBanner({ className }: { className?: string }) {
  const online = useOnline();
  if (online) return null;
  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-2.5 rounded-full bg-muted px-4 py-2 text-sm text-muted-foreground',
        className,
      )}
    >
      <WifiOff className="size-4 shrink-0" aria-hidden="true" />
      <span>
        <span className="font-medium text-foreground">You&rsquo;re offline</span> — showing saved
        data. New expenses are saved as drafts.
      </span>
    </div>
  );
}
