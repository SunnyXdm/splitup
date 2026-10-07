import { useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from "react"

import { prefersReducedMotion } from "@/lib/motion"
import { cn } from "@/lib/utils"

/** Count duration — short, so a balance never lingers on in-between values. */
const DURATION_MS = 350
/** Crossfade used instead of counting (direction or currency changed). */
const SWAP_MS = 180

interface NumberTickerProps extends ComponentPropsWithoutRef<"span"> {
  value: number
  /** Count up from `startValue` on mount (otherwise mount shows `value` as is). */
  animateOnMount?: boolean
  startValue?: number
  decimalPlaces?: number
  /** Custom display formatting (e.g. currency); receives the animated value. */
  format?: (value: number) => string
}

const defaultFormats = new Map<number, (v: number) => string>()
function defaultFormat(decimalPlaces: number) {
  let f = defaultFormats.get(decimalPlaces)
  if (!f) {
    const nf = Intl.NumberFormat("en-US", {
      minimumFractionDigits: decimalPlaces,
      maximumFractionDigits: decimalPlaces,
    })
    f = (v: number) => nf.format(v)
    defaultFormats.set(decimalPlaces, f)
  }
  return f
}

/**
 * True when counting from `from` to `to` would pass through values that mean
 * something different: the sign flips (a debt turning into a credit — every
 * in-between number would sit under the wrong "you owe"/"owed" wording).
 * Counting up from (or down to) zero keeps one direction, so it's allowed.
 */
function crossesDirection(from: number, to: number): boolean {
  return (from < 0 && to > 0) || (from > 0 && to < 0)
}

/**
 * Animated number. Mount shows the value (or counts up once, with
 * `animateOnMount`); afterwards it eases from what is on screen to the new
 * value — only when the value actually changes, never on a plain re-render.
 * A change interrupted mid-count continues from the number currently shown.
 *
 * Money must never show a misleading in-between value, so it counts only
 * while the direction (sign) and the format (currency) stay the same. A sign
 * flip or a new currency swaps straight to the final value with a short
 * crossfade instead. Off-screen, hidden-tab and reduced-motion changes jump
 * straight to the end, without the fade.
 *
 * Text is written straight to the DOM from a rAF loop: no React renders per
 * frame, and no layout reads inside the loop (one rect check per change).
 */
export function NumberTicker({
  value,
  animateOnMount = false,
  startValue = 0,
  className,
  decimalPlaces = 0,
  format,
  ...props
}: NumberTickerProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const [initial] = useState(() => (animateOnMount ? startValue : value))
  // The number currently on screen (mid-animation values included).
  const shown = useRef(initial)
  const fmt = format ?? defaultFormat(decimalPlaces)
  // The format the on-screen text was drawn with.
  const shownFmt = useRef(fmt)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const render = (v: number) => {
      el.textContent = fmt(Number(v.toFixed(decimalPlaces)))
    }
    const from = shown.current
    const to = value
    const formatChanged = shownFmt.current !== fmt
    shownFmt.current = fmt
    if (from === to && !formatChanged) {
      render(to)
      return
    }
    const rect = el.getBoundingClientRect()
    const onScreen = rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 0
    const still = prefersReducedMotion() || document.visibilityState !== "visible" || !onScreen

    if (still || formatChanged || crossesDirection(from, to)) {
      const before = el.textContent
      shown.current = to
      render(to)
      // Swap the whole value at once; fade it in so the change is noticed.
      if (!still && el.textContent !== before && typeof el.animate === "function") {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SWAP_MS, easing: "ease-out" })
      }
      return
    }

    let raf = 0
    let startTime: number | null = null
    const tick = (now: number) => {
      if (startTime === null) startTime = now
      const progress = Math.min(1, (now - startTime) / DURATION_MS)
      // Expo-out, matching --ease-out-expo's feel.
      const eased = progress === 1 ? 1 : 1 - 2 ** (-10 * progress)
      shown.current = from + (to - from) * eased
      render(shown.current)
      if (progress < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
    }
  }, [value, fmt, decimalPlaces])

  return (
    <span ref={ref} className={cn("inline-block tabular-nums", className)} {...props}>
      {fmt(initial)}
    </span>
  )
}
