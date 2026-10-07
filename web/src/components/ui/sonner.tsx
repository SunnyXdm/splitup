import { useSyncExternalStore } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"
import { useTheme } from "@/components/theme-provider"

const DESKTOP_QUERY = "(min-width: 768px)"

function subscribeDesktop(onChange: () => void) {
  const media = window.matchMedia(DESKTOP_QUERY)
  media.addEventListener("change", onChange)
  return () => media.removeEventListener("change", onChange)
}

/** Above the bottom tab bar (3.5rem) and its raised FAB. */
const ABOVE_NAV = "calc(env(safe-area-inset-bottom) + 5.5rem)"

/**
 * Toasts: top-center on desktop (beside the floating nav pill); on mobile at
 * the bottom, above the tab bar — never over the title of a sheet that just
 * opened at the top of the screen.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { resolved } = useTheme()
  const desktop = useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true
  )

  return (
    <Sonner
      theme={resolved === "light" ? "light" : "dark"}
      className="toaster group"
      position={desktop ? "top-center" : "bottom-center"}
      offset={desktop ? undefined : { bottom: ABOVE_NAV }}
      mobileOffset={{ bottom: ABOVE_NAV, left: 16, right: 16 }}
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
          // Compact action pill, full 44px tap target.
          actionButton: "relative hit-area",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
