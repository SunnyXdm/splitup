import { ExpirationPlugin } from "workbox-expiration"
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching"
import { NavigationRoute, registerRoute } from "workbox-routing"
import { CacheFirst } from "workbox-strategies"

declare const self: ServiceWorkerGlobalScope

// --- Offline shell (same behavior as the former generateSW config) ---------

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// SPA navigations fall back to the precached shell; the API never does.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: [/^\/api\//],
  })
)

// Google profile pictures: cache-first, bounded.
registerRoute(
  ({ url }) => /^https:\/\/[^/]+\.googleusercontent\.com\/.*/i.test(url.href),
  new CacheFirst({
    cacheName: "avatars",
    plugins: [new ExpirationPlugin({ maxEntries: 50, maxAgeSeconds: 2592000 })],
  })
)

// --- Prompt-to-update (registerType: 'prompt') -----------------------------
// No skipWaiting on install: a new build waits until the "Refresh" toast's
// updateSW(true), which (via workbox-window) posts this message.
self.addEventListener("message", (event) => {
  if ((event.data as { type?: string } | null)?.type === "SKIP_WAITING")
    void self.skipWaiting()
})

// --- Web Push ---------------------------------------------------------------

interface PushPayload {
  title?: string
  body?: string
  url?: string
  tag?: string
}

/** Only same-origin paths are navigable from a notification. */
function safePath(url: unknown): string {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//")
    ? url
    : "/"
}

self.addEventListener("push", (event) => {
  let data: PushPayload
  try {
    data = (event.data?.json() as PushPayload | undefined) ?? {}
  } catch {
    data = { body: event.data?.text() }
  }
  const title = data.title || "Splitup"
  const options: NotificationOptions = {
    body: data.body ?? "",
    icon: "/pwa-192.png",
    badge: "/pwa-192.png",
    data: { url: safePath(data.url) },
  }
  if (data.tag) options.tag = data.tag
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const path = safePath(
    (event.notification.data as { url?: unknown } | null)?.url
  )
  const target = new URL(path, self.location.origin).href
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      })
      // Prefer an already-open Splitup window: focus it and let the app route
      // in place (lib/push-hooks.ts) — no full reload of the SPA.
      const client = windows.find(
        (c) => new URL(c.url).origin === self.location.origin
      )
      if (client) {
        await client.focus().catch(() => undefined)
        client.postMessage({ type: "splitup:navigate", url: path })
        return
      }
      await self.clients.openWindow(target)
    })()
  )
})
