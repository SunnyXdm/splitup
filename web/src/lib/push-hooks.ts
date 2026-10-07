import { useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router"
import { pushSupport, reconcilePush } from "@/lib/push"
import { SYNC_KEY } from "@/lib/queries"

type NavigateMessage = { type: "splitup:navigate"; url: string }

const isNavigateMessage = (data: unknown): data is NavigateMessage =>
  typeof data === "object" &&
  data !== null &&
  (data as NavigateMessage).type === "splitup:navigate" &&
  typeof (data as NavigateMessage).url === "string"

/**
 * A notification tapped while Splitup is already open: the service worker
 * focuses this window and posts the deep link (sw.ts). Route in place and
 * refresh, since the notification means something changed server-side.
 */
export function useNotificationNavigation(): void {
  const navigate = useNavigate()
  const qc = useQueryClient()
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return
    const onMessage = (event: MessageEvent) => {
      if (!isNavigateMessage(event.data)) return
      const { url } = event.data
      if (!url.startsWith("/") || url.startsWith("//")) return
      navigate(url)
      void qc.invalidateQueries({ queryKey: SYNC_KEY })
    }
    navigator.serviceWorker.addEventListener("message", onMessage)
    return () =>
      navigator.serviceWorker.removeEventListener("message", onMessage)
  }, [navigate, qc])
}

/**
 * Once per signed-in user per app start: re-register this device's existing
 * subscription (if any) for the CURRENT account, so a session swap on a shared
 * device re-binds it instead of notifying the previous account. Never prompts.
 */
export function usePushReconcile(userId: number | undefined): void {
  useEffect(() => {
    if (userId === undefined || pushSupport() !== "supported") return
    void reconcilePush().catch(() => undefined)
  }, [userId])
}
