import { registerSW } from 'virtual:pwa-register';
import { toast } from 'sonner';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Service-worker registration with a visible update path: when a new build is
 * waiting, show a persistent toast whose action swaps the worker and reloads —
 * no more "reload twice and hope" to pick up a deploy.
 */
export function setupPwaUpdates(): void {
  const updateSW = registerSW({
    onNeedRefresh() {
      toast('A new version of Splitup is ready', {
        id: 'pwa-update',
        duration: Infinity,
        action: {
          label: 'Refresh',
          onClick: () => void updateSW(true),
        },
      });
    },
    onRegisteredSW(_url, registration) {
      // Long-lived PWA sessions: check for a new build every hour.
      if (registration) {
        setInterval(() => void registration.update(), HOUR_MS);
      }
    },
  });
}
