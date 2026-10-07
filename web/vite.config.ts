import { readFileSync } from "fs"
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { VitePWA } from "vite-plugin-pwa"

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    // Persisted-cache buster (main.tsx): bump the version to drop old caches.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      injectRegister: false,
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Splitup",
        short_name: "Splitup",
        description: "Split expenses with friends",
        display: "standalone",
        start_url: "/",
        theme_color: "#f3f0ee",
        background_color: "#f3f0ee",
        icons: [
          { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      // Custom worker (src/sw.ts): the same precache / SPA fallback / avatar
      // cache the generated one had, plus Web Push handlers.
      injectManifest: {
        globPatterns: ["**/*.{js,css,html}"],
      },
      // Opt-in SW in `vite dev` (SW_DEV=1 npm run dev) for testing push locally;
      // off by default so dev never serves from a stale cache.
      devOptions: {
        enabled: process.env.SW_DEV === "1",
        type: "module",
        navigateFallback: "index.html",
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8790",
    },
  },
})
