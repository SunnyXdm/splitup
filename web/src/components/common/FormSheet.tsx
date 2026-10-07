import type { FormEvent, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

interface FormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Submit handler; the sheet wraps its body in a <form>, so Enter submits. */
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  /** The single primary action's label ("Create group", "Save changes"). */
  submitLabel: ReactNode;
  submitDisabled?: boolean;
  /** Shows a spinner in the primary action. */
  pending?: boolean;
  /** Extra footer content under the primary action (a ghost button, a hint). */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * A short form as a bottom sheet — the one modal shape on mobile (DESIGN.md
 * §4 "Action language"). Scrollable body, sticky footer with one ink pill
 * (h-12), safe-area padding; Back closes it (Sheet's history dismiss).
 * Dismiss with the close button, the scrim or Back — no Cancel button.
 */
export function FormSheet({
  open,
  onOpenChange,
  title,
  description,
  onSubmit,
  submitLabel,
  submitDisabled = false,
  pending = false,
  footer,
  children,
  className,
}: FormSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className={cn('mx-auto max-h-[92dvh] w-full max-w-xl gap-0 rounded-t-[28px]', className)}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(e);
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <SheetHeader className="pr-14">
            <SheetTitle className="text-xl">{title}</SheetTitle>
            {description ? <SheetDescription>{description}</SheetDescription> : null}
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-1 pb-2">{children}</div>
          <SheetFooter className="pt-2 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
            <Button type="submit" size="cta" className="w-full" disabled={submitDisabled}>
              {pending ? <Spinner data-icon="inline-start" /> : null}
              {submitLabel}
            </Button>
            {footer}
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
