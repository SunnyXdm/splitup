import * as React from "react"
import { CheckIcon, ChevronDownIcon } from "lucide-react"

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
}: PickerSelectProps) {
  const [open, setOpen] = React.useState(false)
  const selected = options.find((o) => o.value === value)

  return (
    <>
      <button
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={cn(
          "flex h-11 w-full items-center justify-between gap-2 rounded-full border border-input bg-transparent px-4 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
      >
        <span className={cn("truncate", !selected && "text-muted-foreground")}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="mx-auto max-h-[80dvh] w-full max-w-xl rounded-t-[28px]"
        >
          <SheetHeader className="pb-0">
            <SheetTitle className="text-xl">{title}</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <div className="flex flex-col gap-1">
              {options.map((option) => {
                const isSelected = option.value === value
                return (
                  <button
                    key={option.value}
                    type="button"
                    disabled={option.disabled}
                    onClick={() => {
                      onValueChange(option.value)
                      setOpen(false)
                    }}
                    className={cn(
                      "flex min-h-12 w-full items-center gap-3 rounded-2xl px-3 text-left text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50",
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
