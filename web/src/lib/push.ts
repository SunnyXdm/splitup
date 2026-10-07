import { api } from "@/lib/api"

/**
 * Web Push on this device. The browser holds the subscription (one per
 * service-worker registration); the server stores it per user so it can send.
 */

export type PushSupport =
  /** No service worker / PushManager / Notification API (or no SW in dev). */
  | "unsupported"
  /** iOS only delivers Web Push to apps added to the Home Screen. */
  | "ios-needs-install"
  | "supported"

function isIos(): boolean {
  const ua = navigator.userAgent
  // iPadOS 13+ reports itself as a Mac; touch gives it away.
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  )
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported"
  if (isIos() && !isStandalone()) return "ios-needs-install"
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return "unsupported"
  }
  return "supported"
}

export function notificationPermission(): NotificationPermission {
  return "Notification" in window ? Notification.permission : "default"
}

/** The active registration, or null (none yet / dev without SW_DEV). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) return null
  if (reg.active) return reg
  // Installing on first visit: wait briefly for it to activate.
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
  ])
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registration()
  return reg ? reg.pushManager.getSubscription() : null
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (value.length % 4)) % 4)
  const raw = atob((value + pad).replace(/-/g, "+").replace(/_/g, "/"))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function sameKey(sub: PushSubscription, key: Uint8Array): boolean {
  const current = sub.options.applicationServerKey
  if (!current) return false
  const a = new Uint8Array(current)
  return a.length === key.length && a.every((b, i) => b === key[i])
}

const saveSubscription = (sub: PushSubscription) =>
  api<void>("/api/push/subscriptions", { method: "POST", body: sub.toJSON() })

const deleteSubscription = (endpoint: string) =>
  api<void>("/api/push/subscriptions", { method: "DELETE", body: { endpoint } })

export class PushPermissionError extends Error {
  constructor() {
    super("Notifications are blocked for Splitup")
    this.name = "PushPermissionError"
  }
}

/**
 * Turn push on. MUST be called straight from a click handler: the permission
 * prompt needs the user gesture (iOS refuses it after any earlier await).
 */
export async function enablePush(): Promise<PushSubscription> {
  const permission = await Notification.requestPermission()
  if (permission !== "granted") throw new PushPermissionError()
  const reg = await registration()
  if (!reg)
    throw new Error(
      "Notifications aren’t available yet — reload and try again."
    )
  const { publicKey } = await api<{ publicKey: string }>("/api/push/key")
  const key = base64UrlToBytes(publicKey)
  let sub = await reg.pushManager.getSubscription()
  // A subscription made with an older server key can't receive; replace it.
  if (sub && !sameKey(sub, key)) {
    await sub.unsubscribe().catch(() => false)
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  })
  await saveSubscription(sub)
  return sub
}

/** Turn push off for this device: browser first, then the server row. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription()
  if (!sub) return
  const { endpoint } = sub
  await sub.unsubscribe().catch(() => false)
  await deleteSubscription(endpoint)
}

/**
 * On mount: make sure a live browser subscription is registered with the
 * server for the signed-in user (e.g. the server lost it, or keys rotated).
 * Returns whether this device is subscribed afterwards.
 */
export async function reconcilePush(): Promise<boolean> {
  const sub = await currentSubscription()
  if (!sub) return false
  if (notificationPermission() !== "granted") {
    const { endpoint } = sub
    await sub.unsubscribe().catch(() => false)
    await deleteSubscription(endpoint).catch(() => undefined)
    return false
  }
  try {
    const { publicKey } = await api<{ publicKey: string }>("/api/push/key")
    if (!sameKey(sub, base64UrlToBytes(publicKey))) {
      await sub.unsubscribe().catch(() => false)
      return false
    }
    await saveSubscription(sub)
  } catch {
    // offline — the browser subscription still stands
  }
  return true
}

/**
 * Sign-out cleanup (best effort, bounded): stop this device receiving the
 * account's notifications. Runs BEFORE the session is cleared, since the
 * server DELETE needs it.
 */
export async function unsubscribeOnSignOut(timeoutMs = 3000): Promise<void> {
  if (pushSupport() !== "supported") return
  const work = (async () => {
    const sub = await currentSubscription()
    if (!sub) return
    const { endpoint } = sub
    await Promise.allSettled([sub.unsubscribe(), deleteSubscription(endpoint)])
  })().catch(() => undefined)
  await Promise.race([
    work,
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}
