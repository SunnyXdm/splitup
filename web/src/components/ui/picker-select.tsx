import * as React from "react"
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react"

import { matchesQuery } from "@/lib/picker-match"
import { cn } from "@/lib/utils"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"

export interface PickerOption {
  value: string
  label: string
  sublabel?: string
  leading?: React.ReactNode
  disabled?: boolean
}

interface PickerSelectProps {
  value: string | null
  onValueChange: (value: string) => void
  options: PickerOption[]
  /** Sheet title, e.g. "Currency" or "Who paid?". */
  title: string
  placeholder?: string
  disabled?: boolean
  id?: string
  /** Trigger styling override (e.g. the compact in-input variant). */
  className?: string
  /** id of a visible label element (for triggers without a <label for>). */
  "aria-labelledby"?: string
  /** Accessible name when there is no visible label at all. */
  "aria-label"?: string
  /** Trigger text override (e.g. a filter chip reading "Paid by" at its default). */
  displayLabel?: string
  /** Show a search field above long lists (matches label, sublabel and value). */
  searchable?: boolean
}

/**
 * A select rendered as a bottom-sheet picker — the mobile-native pattern.
 * Floating dropdown popups are a desktop affordance that kept breaking on
 * mobile (positioning, scroll-lock, reopen state); the Sheet primitive is
 * already battle-tested here, gets Back-button dismissal for free, and mounts
 * fresh on every open so no state survives between opens.
 */
function PickerSelect({
  value,
  onValueChange,
  options,
  title,
  placeholder = "Choose…",
  disabled = false,
  id,
  className,
  "aria-labelledby": labelledBy,
  "aria-label": ariaLabel,
  displayLabel,
  searchable = false,
}: PickerSelectProps) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const popupRef = React.useRef<HTMLDivElement>(null)
  const shown = searchable
    ? options.filter((o) => matchesQuery(o, query))
    : options
  const selected = options.find((o) => o.value === value)
  const valueId = React.useId()
  const nameId = React.useId()
  // Name = the label PLUS the current value ("Paid by, You"), so a screen
  // reader announces both; aria-labelledby alone would drop the value.
  const nameRef = labelledBy ?? (ariaLabel ? nameId : undefined)

  return (
    <>
      <button
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-labelledby={nameRef ? `${nameRef} ${valueId}` : undefined}
        onClick={() => {
          setQuery("")
          setOpen(true)
        }}
        className={cn(
          "relative flex h-11 w-full items-center justify-between gap-2 rounded-full border border-input bg-transparent px-4 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
      >
        {ariaLabel && !labelledBy ? (
          <span id={nameId} className="sr-only">
            {ariaLabel}
          </span>
        ) : null}
        <span id={valueId} className={cn("truncate", !selected && "text-muted-foreground")}>
          {displayLabel ?? (selected ? selected.label : placeholder)}
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          ref={popupRef}
          // Touch: don't jump into the search field (the keyboard would cover
          // the list); keyboard users land on it as the first control.
          initialFocus={(type) => (type === "keyboard" ? true : popupRef.current)}
          side="bottom"
          className="mx-auto max-h-[80dvh] w-full max-w-xl rounded-t-[28px] outline-none"
        >
          <SheetHeader className="pb-0">
            <SheetTitle className="text-xl">{title}</SheetTitle>
          </SheetHeader>
          {searchable ? (
            <div className="px-4 pb-2">
              <label className="relative block">
                <span className="sr-only">Search {title.toLowerCase()}</span>
                <SearchIcon
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search"
                  autoComplete="off"
                  enterKeyHint="search"
                  onKeyDown={(e) => {
                    // Enter picks the single (or first) match.
                    if (e.key === "Enter" && shown[0] && !shown[0].disabled) {
                      e.preventDefault()
                      onValueChange(shown[0].value)
                      setOpen(false)
                    }
                  }}
                  className="h-11 w-full rounded-full border border-input bg-transparent pr-4 pl-10 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-focus-ring md:text-sm [&::-webkit-search-cancel-button]:appearance-none"
                />
              </label>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <div className="flex flex-col gap-1">
              {searchable && shown.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  Nothing matches “{query.trim()}”.
                </p>
              ) : null}
              {shown.map((option) => {
                const isSelected = option.value === value
                return (
                  <button
                    key={option.value}
                    type="button"
                    disabled={option.disabled}
                    aria-pressed={isSelected}
                    onClick={() => {
                      onValueChange(option.value)
                      setOpen(false)
                    }}
                    className={cn(
                      "flex min-h-12 w-full items-center gap-3 rounded-2xl px-3 text-left text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50",
                      isSelected && "bg-accent"
                    )}
                  >
                    {option.leading}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium">{option.label}</span>
                      {option.sublabel ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {option.sublabel}
                        </span>
                      ) : null}
                    </span>
                    {isSelected ? (
                      <CheckIcon aria-hidden="true" className="size-4 shrink-0" />
                    ) : null}
                  </button>
                )
              })}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

export { PickerSelect }
