import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// The native Android/iOS builds must NOT ship a service worker.
//
// Two separate failures traced back to it:
//  1. A stale precached bundle being served after an APK update installed
//     over a previous one (app data, and with it the Cache Storage, survives
//     an update install) — the app kept running old JS no matter how many
//     times it was rebuilt.
//  2. Worse: the runtimeCaching rule below intercepted the `participants`
//     query with NetworkFirst and no networkTimeoutSeconds, which per
//     Workbox's own docs waits for the network *indefinitely*. App.jsx
//     awaits that query inside loadParticipant(), so a stalled (not failed)
//     request left the app frozen on its loading spinner forever, right
//     after a successful sign-in.
//
// A native build gains nothing from it either: the web assets are already
// bundled into the APK/IPA, and offline session storage is handled by
// SQLite + Preferences. Set BUILD_TARGET=native (see `npm run build:native`).
const IS_NATIVE_BUILD = process.env.BUILD_TARGET === 'native'

export default defineConfig({
  plugins: [
    react(),
    // Web/PWA build only (Vercel — also what Bluefy loads on iOS).
    ...(IS_NATIVE_BUILD
      ? []
      : [
          VitePWA({
            registerType: 'autoUpdate',
            includeAssets: ['icons/*.png', 'icons/*.svg'],
            // Manifest is in public/manifest.json — don't auto-generate
            manifest: false,
            workbox: {
              globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
              // Cache the participant list for offline use
              runtimeCaching: [
                {
                  urlPattern: /^https:\/\/.*\.supabase\.co\/rest\/v1\/participants/,
                  handler: 'NetworkFirst',
                  options: {
                    cacheName: 'supabase-participants',
                    // Mandatory with NetworkFirst: without it the strategy
                    // waits for the network forever instead of falling back
                    // to the cache, which is what froze the app on launch.
                    networkTimeoutSeconds: 8,
                    expiration: { maxAgeSeconds: 60 * 60 * 24 },
                  },
                },
              ],
            },
          }),
        ]),
  ],
  // Capacitor needs the dist output at the root of the webDir
  build: {
    outDir: 'dist',
  },
})
