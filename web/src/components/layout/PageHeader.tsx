import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { isTabRoot, useBack, useDocumentTitle } from '@/lib/back-nav';
import { cn } from '@/lib/utils';

/**
 * Round back chevron for pushed pages. Goes back in history when the previous
 * entry is in-app, else to `fallback` (default: the page's parent tab).
 */
export function BackButton({
  fallback,
  label = 'Back',
  className,
}: {
  fallback?: string;
  label?: string;
  className?: string;
}) {
  const back = useBack(fallback);
  return (
    <Button
      variant="outline"
      size="icon"
      className={cn('size-11 shrink-0 rounded-full bg-card dark:bg-card', className)}
      aria-label={label}
      onClick={back}
    >
      <ChevronLeft className="size-5" aria-hidden="true" />
    </Button>
  );
}

interface PageHeaderProps {
  /** The page's H1 (24px / 500 / −2%). */
  title: ReactNode;
  /** Optional uppercase kicker above the title, with the signal dot. */
  eyebrow?: ReactNode;
  /**
   * Back chevron. Default: shown on every page that isn't a bottom-nav tab
   * root. Pass a path to override where Back falls back to, or false to hide.
   */
  back?: boolean | string;
  /** Trailing actions (an outline pill, a ⋯ menu, icon buttons). */
  actions?: ReactNode;
  /** Muted paragraph under the title row. */
  description?: ReactNode;
  className?: string;
  titleClassName?: string;
  /** document.title for the page ("<title> · Splitup"). Default: `title` when it's a string. */
  documentTitle?: string;
}

/**
 * The one page skeleton (DESIGN.md §4 "Page header"): [‹] eyebrow / H1 … actions.
 * Tab roots (Home, Friends, Activity, Account) render it without back; every
 * pushed page gets the chevron.
 */
export function PageHeader({
  title,
  eyebrow,
  back,
  actions,
  description,
  className,
  titleClassName,
  documentTitle,
}: PageHeaderProps) {
  const { pathname } = useLocation();
  useDocumentTitle(documentTitle ?? (typeof title === 'string' ? title : undefined));
  const showBack = back === undefined ? !isTabRoot(pathname) : back !== false;
  const fallback = typeof back === 'string' ? back : undefined;
  return (
    <header className={cn('flex flex-col gap-2', className)}>
      <div className="flex min-h-11 items-center gap-3">
        {showBack ? <BackButton fallback={fallback} /> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
          <h1
            tabIndex={-1}
            className={cn(
              'text-2xl leading-tight font-medium tracking-[-0.02em] text-balance break-words',
              titleClassName,
            )}
          >
            {title}
          </h1>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
    </header>
  );
}
