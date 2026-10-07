import { useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from "react"

import { prefersReducedMotion } from "@/lib/motion"
import { cn } from "@/lib/utils"

const DURATION_MS = 400

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
 * Animated number. Mount shows the value (or counts up once, with
 * `animateOnMount`); afterwards it eases from what is on screen to the new
 * value — only when the value actually changes, never on a plain re-render.
 * A change interrupted mid-count continues from the number currently shown.
 * Off-screen, hidden-tab and reduced-motion changes jump straight to the end.
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
  const fmtRef = useRef(fmt)

  useLayoutEffect(() => {
    fmtRef.current = fmt
  })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const render = (v: number) => {
      const rounded = Number(v.toFixed(decimalPlaces))
      el.textContent = fmtRef.current(rounded)
    }
    const from = shown.current
    const to = value
    if (from === to) {
      render(to)
      return
    }
    const rect = el.getBoundingClientRect()
    const onScreen =
      rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 0
    if (prefersReducedMotion() || document.visibilityState !== "visible" || !onScreen) {
      shown.current = to
      render(to)
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
    return () => cancelAnimationFrame(raf)
  }, [value, decimalPlaces])

  // A new format (e.g. currency) redraws whatever number is on screen.
  useLayoutEffect(() => {
    if (ref.current) {
      ref.current.textContent = fmt(Number(shown.current.toFixed(decimalPlaces)))
    }
  }, [fmt, decimalPlaces])

  return (
    <span ref={ref} className={cn("inline-block tabular-nums", className)} {...props}>
      {fmt(initial)}
    </span>
  )
}
