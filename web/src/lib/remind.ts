import { toast } from 'sonner';

/**
 * `amountText` is preformatted — a single amount or "₹500 + $20" for
 * multi-currency. A guest can't sign in, so their reminder is plain text with
 * no link to an app they can't use (`withLink: false`).
 */
export function reminderText(
  name: string,
  amountText: string,
  context: string,
  { withLink = true }: { withLink?: boolean } = {},
): string {
  const text = `Hey ${name}! Friendly reminder — you owe me ${amountText} ${context}.`;
  return withLink
    ? `Hey ${name}! Friendly reminder from Splitup — you owe me ${amountText} ${context}. Settle up here: ${window.location.origin}`
    : text;
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
