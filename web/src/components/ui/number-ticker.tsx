import { useEffect, useRef, type ComponentPropsWithoutRef } from "react"

import { cn } from "@/lib/utils"

const DURATION_MS = 900

interface NumberTickerProps extends ComponentPropsWithoutRef<"span"> {
  value: number
  startValue?: number
  direction?: "up" | "down"
  /** Seconds before the animation starts. */
  delay?: number
  decimalPlaces?: number
  /** Custom display formatting (e.g. currency); receives the animated value. */
  format?: (value: number) => string
}

/**
 * Count-up display. A fixed-duration ease-out (not a spring): springs scale
 * their settling time with the value, which made large money amounts crawl
 * for seconds. This always lands on the exact final value in under a second.
 */
export function NumberTicker({
  value,
  startValue = 0,
  direction = "up",
  delay = 0,
  className,
  decimalPlaces = 0,
  format,
  ...props
}: NumberTickerProps) {
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const from = direction === "down" ? value : startValue
    const to = direction === "down" ? startValue : value
    const render = (current: number) => {
      if (!ref.current) return
      const rounded = Number(current.toFixed(decimalPlaces))
      ref.current.textContent = format
        ? format(rounded)
        : Intl.NumberFormat("en-US", {
            minimumFractionDigits: decimalPlaces,
            maximumFractionDigits: decimalPlaces,
          }).format(rounded)
    }

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      render(to)
      return
    }

    let raf = 0
    let startTime: number | null = null
    const tick = (now: number) => {
      if (startTime === null) startTime = now
      const progress = Math.min(1, (now - startTime) / DURATION_MS)
      const eased = 1 - (1 - progress) ** 3
      render(from + (to - from) * eased)
      if (progress < 1) raf = requestAnimationFrame(tick)
    }
    render(from)
    const timer = setTimeout(() => {
      raf = requestAnimationFrame(tick)
    }, delay * 1000)

    return () => {
      clearTimeout(timer)
      cancelAnimationFrame(raf)
    }
  }, [value, startValue, direction, delay, decimalPlaces, format])

  return (
    <span
      ref={ref}
      className={cn("inline-block tabular-nums", className)}
      {...props}
    >
      {format ? format(startValue) : startValue}
    </span>
  )
}
