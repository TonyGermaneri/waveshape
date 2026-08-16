/*
 * Cross-origin isolation on a static host.
 *
 * SharedArrayBuffer — which the lock-free audio ring depends on — is only exposed to
 * cross-origin-isolated documents, and isolation requires two response headers:
 *
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * The dev and preview servers set them directly (see vite.config.ts). GitHub Pages, and static
 * hosts generally, give you no control over response headers at all. A service worker can
 * supply them anyway: it sits in front of every same-origin request and re-issues the response
 * with the headers attached. The first load is not yet isolated — no worker is controlling the
 * page — so it registers, reloads once, and comes back isolated.
 *
 * Without this the app still runs. The capture path falls back to pooled postMessage
 * transfers, which reintroduces allocation on a thread that should not have any, and the
 * System tab says so. This file is the difference between "works" and "works properly".
 *
 * The file is deliberately dual-context: the same script is both the registration snippet the
 * page loads and the worker it registers, so there is only one path to keep in sync.
 */

const HEADERS = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

if (typeof window === 'undefined') {
  // ---------------------------------------------------------------- service worker context
  self.addEventListener('install', () => self.skipWaiting())
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

  self.addEventListener('fetch', (event) => {
    const request = event.request

    // A cache-only request that is not same-origin cannot be served here; letting it fall
    // through to the network is the documented workaround for a long-standing Chrome bug.
    if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return

    event.respondWith(
      fetch(request)
        .then((response) => {
          // Opaque responses have an immutable, unreadable header list. Nothing to add.
          if (response.status === 0) return response

          const headers = new Headers(response.headers)
          for (const [name, value] of Object.entries(HEADERS)) headers.set(name, value)

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          })
        })
        .catch((error) => {
          console.error('[coi] request passthrough failed', error)
          return Response.error()
        }),
    )
  })
} else {
  // ---------------------------------------------------------------- page context
  const RELOAD_FLAG = 'waveshape.coi.reloaded'
  const scriptUrl = document.currentScript && document.currentScript.src

  if (window.crossOriginIsolated) {
    // Already isolated: a real server is sending the headers. Clear the reload guard so a
    // later visit to a host without them can still bootstrap.
    try {
      sessionStorage.removeItem(RELOAD_FLAG)
    } catch {
      /* storage can be blocked; the guard is best-effort */
    }
  } else if (!window.isSecureContext) {
    console.warn(
      '[coi] not a secure context — SharedArrayBuffer is unavailable and capture will use the transfer fallback',
    )
  } else if (!navigator.serviceWorker || !scriptUrl) {
    console.warn('[coi] service workers unavailable — capture will use the transfer fallback')
  } else {
    navigator.serviceWorker
      .register(scriptUrl)
      .then((registration) => {
        registration.addEventListener('updatefound', () => window.location.reload())

        // Freshly installed and not yet controlling this page: one reload hands the page to
        // the worker, which is when the headers start arriving. Guarded so a worker that
        // somehow fails to produce isolation cannot put the page in a reload loop.
        if (registration.active && !navigator.serviceWorker.controller) {
          let alreadyReloaded = false
          try {
            alreadyReloaded = sessionStorage.getItem(RELOAD_FLAG) === '1'
            sessionStorage.setItem(RELOAD_FLAG, '1')
          } catch {
            /* storage blocked: fall through and reload at most this once */
          }
          if (!alreadyReloaded) window.location.reload()
        }
      })
      .catch((error) => console.warn('[coi] registration failed', error))
  }
}
