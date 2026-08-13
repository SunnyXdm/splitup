import { toast } from 'sonner';
import { formatMoney } from './money';

export function reminderText(name: string, cents: number, currency: string, context: string): string {
  return `Hey ${name}! Friendly reminder from Splitup — you owe me ${formatMoney(cents, currency)} ${context}. Settle up here: ${window.location.origin}`;
}

/**
 * Nudge a friend about a debt: the OS share sheet where available (WhatsApp
 * et al. one tap away), clipboard otherwise. No server infrastructure needed.
 */
export async function sendReminder(text: string): Promise<void> {
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return; // user closed the sheet
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Reminder copied — paste it in your chat');
  } catch {
    toast.message('Reminder', { description: text });
  }
}
