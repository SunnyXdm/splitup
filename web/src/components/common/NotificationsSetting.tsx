import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { useOnline } from "@/components/layout/OfflineBanner"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import {
  currentSubscription,
  disablePush,
  enablePush,
  notificationPermission,
  pushSupport,
  PushPermissionError,
} from "@/lib/push"

type State =
  | { kind: "checking" }
  | { kind: "unsupported" }
  | { kind: "ios-needs-install" }
  | { kind: "denied" }
  | { kind: "ready"; subscribed: boolean }

const isAndroid = () => /Android/i.test(navigator.userAgent)

function deniedHelp(): string {
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
    return "Notifications are blocked. Turn them on in Settings → Notifications → Splitup."
  }
  if (isAndroid()) {
    return "Notifications are blocked. Long-press the Splitup icon → App info → Notifications to allow them."
  }
  return "Notifications are blocked. Allow them for this site in your browser’s site settings."
}

async function readState(): Promise<State> {
  const support = pushSupport()
  if (support !== "supported") return { kind: support }
  if (notificationPermission() === "denied") return { kind: "denied" }
  try {
    // App.tsx's PushReconcile already re-registers it with the server.
    return { kind: "ready", subscribed: (await currentSubscription()) !== null }
  } catch {
    return { kind: "ready", subscribed: false }
  }
}

/** Account → Notifications: per-device Web Push on/off. */
export function NotificationsSetting() {
  const online = useOnline()
  const [state, setState] = useState<State>({ kind: "checking" })
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    void readState().then(setState)
  }, [])

  useEffect(() => {
    refresh()
    // Permission may be changed in system settings while we're backgrounded.
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [refresh])

  const toggle = (checked: boolean) => {
    if (busy) return
    setBusy(true)
    // enablePush() calls Notification.requestPermission() synchronously,
    // inside this click — browsers (iOS especially) require the gesture.
    const work = checked ? enablePush() : disablePush()
    work
      .then(() => {
        setState({ kind: "ready", subscribed: checked })
        if (checked) toast.success("Notifications are on for this device")
      })
      .catch((err: unknown) => {
        if (err instanceof PushPermissionError) {
          setState(
            notificationPermission() === "denied"
              ? { kind: "denied" }
              : { kind: "ready", subscribed: false }
          )
          return
        }
        toast.error(
          err instanceof Error && err.message
            ? err.message
            : "Couldn’t change notifications"
        )
        refresh()
      })
      .finally(() => setBusy(false))
  }

  const checked = state.kind === "ready" && state.subscribed
  const disabled = state.kind !== "ready" || busy || !online

  let description: string
  switch (state.kind) {
    case "checking":
      description = "Checking this device…"
      break
    case "unsupported":
      description = "This browser doesn’t support notifications."
      break
    case "ios-needs-install":
      description =
        "On iPhone, add Splitup to your Home Screen first (Share → Add to Home Screen), then turn this on from there."
      break
    case "denied":
      description = deniedHelp()
      break
    case "ready":
      description = checked
        ? "You’ll hear about new expenses, payments and friend requests on this device."
        : "Get notified about new expenses, payments and friend requests on this device."
      break
  }

  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor="account-notifications">Notifications</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <Switch
        id="account-notifications"
        checked={checked}
        disabled={disabled}
        onCheckedChange={toggle}
      />
    </Field>
  )
}
