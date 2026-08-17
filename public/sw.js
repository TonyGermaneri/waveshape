/*
 * The service worker, which does two jobs that have to be done by the same worker.
 *
 * --- Cross-origin isolation -------------------------------------------------------------
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
 * System tab says so.
 *
 * --- Offline ----------------------------------------------------------------------------
 *
 * The same interception makes the app installable and usable with no network. A scope can only
 * have one worker, so these cannot be two files: anything that served a cached response without
 * re-attaching the headers above would hand back a document that is no longer isolated, and the
 * app would quietly lose the lock-free ring the moment it went offline. Every response leaving
 * here — network or cache — goes through `withHeaders()` for exactly that reason.
 *
 * Two caching rules, decided by the shape of the URL:
 *
 *   assets/name-HASH.ext   cache first. Vite's hash is of the contents, so the name changes
 *                          whenever the bytes do. A hit can never be stale.
 *   everything else        network first, falling back to the cache. Covers the document, the
 *                          manifest and the icons, whose names stay put across builds.
 *
 * Source maps are left alone entirely: they are large, and only devtools ever asks for them.
 *
 * The file is deliberately dual-context: the same script is both the registration snippet the
 * page loads and the worker it registers, so there is only one path to keep in sync.
 */

const HEADERS = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

/*
 * Replaced by the `precache` plugin in vite.config.ts with `{version, files}` for the build
 * being written. It stays null everywhere else, which is the signal to skip caching altogether:
 * the dev server has no build output to precache, and serving yesterday's module graph back to
 * a page that is being edited would be worse than useless. Isolation still works either way.
 */
const PRECACHE = null /* WAVESHAPE_PRECACHE */

if (typeof window === 'undefined') {
  // ---------------------------------------------------------------- service worker context

  /** Versioned, so activating a new build cannot read a single byte of the old one's cache. */
  const CACHE = PRECACHE ? `waveshape-${PRECACHE.version}` : null

  /** `assets/index-DeM7-Ouf.js` — a Vite chunk or asset, named after a hash of its contents. */
  const IMMUTABLE = /\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/

  self.addEventListener('install', (event) => {
    self.skipWaiting()
    if (!CACHE) return
    event.waitUntil(
      caches.open(CACHE).then((cache) =>
        // One request at a time rather than `addAll`, which is all-or-nothing: a single 404
        // would fail the install, and an install that fails is a page that never becomes
        // isolated. Offline is the feature worth losing here; isolation is not.
        Promise.all(
          PRECACHE.files.map((file) =>
            cache
              .add(new Request(file, { cache: 'reload' }))
              .catch((error) => console.warn('[sw] not precached:', file, error)),
          ),
        ),
      ),
    )
  })

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        for (const name of await caches.keys()) {
          if (name.startsWith('waveshape-') && name !== CACHE) await caches.delete(name)
        }
        await self.clients.claim()
      })(),
    )
  })

  self.addEventListener('fetch', (event) => {
    const request = event.request

    // A cache-only request that is not same-origin cannot be served here; letting it fall
    // through to the network is the documented workaround for a long-standing Chrome bug.
    if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return

    event.respondWith(respond(event))
  })

  async function respond(event) {
    const request = event.request
    const url = new URL(request.url)

    const cacheable =
      CACHE !== null &&
      request.method === 'GET' &&
      url.origin === self.location.origin &&
      !url.pathname.endsWith('.map') &&
      // A range request is a slice of a resource. Storing the slice under the whole
      // resource's key would hand the next reader 206 bytes of a file it asked all of.
      !request.headers.has('range')

    if (!cacheable) return passthrough(request)
    if (IMMUTABLE.test(url.pathname)) return cacheFirst(event, request)
    return networkFirst(event, request)
  }

  /** The isolation headers, and nothing else. What every response did before there was a cache. */
  async function passthrough(request) {
    try {
      return withHeaders(await fetch(request))
    } catch (error) {
      console.error('[sw] request passthrough failed', request.url, error)
      return Response.error()
    }
  }

  async function cacheFirst(event, request) {
    const hit = await caches.match(request, { cacheName: CACHE })
    if (hit) return withHeaders(hit)
    const response = await fetch(request).catch(() => null)
    if (!response) return Response.error()
    store(event, request, response)
    return withHeaders(response)
  }

  async function networkFirst(event, request) {
    try {
      const response = await fetch(request)
      store(event, request, response)
      return withHeaders(response)
    } catch (error) {
      const hit = await caches.match(request, { cacheName: CACHE })
      if (hit) return withHeaders(hit)
      // Offline, and this exact URL was never cached — a deep link, or the start URL carrying
      // query parameters. The app is a single document, so the shell is the right answer to
      // any navigation within scope.
      if (request.mode === 'navigate') {
        const shell = await caches.match('./', { cacheName: CACHE })
        if (shell) return withHeaders(shell)
      }
      console.error('[sw] offline and nothing cached for', request.url, error)
      return Response.error()
    }
  }

  /**
   * Writes through to the cache without making the page wait for it, but keeps the worker
   * alive until it lands — a worker killed mid-put loses the entry silently.
   */
  function store(event, request, response) {
    // `basic` is a same-origin response we can actually read. Opaque and error responses have
    // nothing worth keeping, and a redirect stored under the requested URL would replay as a
    // redirect forever.
    if (!response.ok || response.type !== 'basic') return
    const copy = response.clone()
    event.waitUntil(
      caches
        .open(CACHE)
        .then((cache) => cache.put(request, copy))
        .catch((error) => console.warn('[sw] cache write failed', request.url, error)),
    )
  }

  function withHeaders(response) {
    // Opaque responses have an immutable, unreadable header list. Nothing to add.
    if (response.status === 0) return response

    const headers = new Headers(response.headers)
    for (const [name, value] of Object.entries(HEADERS)) headers.set(name, value)

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
} else {
  // ---------------------------------------------------------------- page context
  const RELOAD_FLAG = 'waveshape.coi.reloaded'
  const scriptUrl = document.currentScript && document.currentScript.src

  if (!window.isSecureContext) {
    console.warn(
      '[sw] not a secure context — SharedArrayBuffer is unavailable and capture will use the transfer fallback',
    )
  } else if (!navigator.serviceWorker || !scriptUrl) {
    console.warn('[sw] service workers unavailable — capture will use the transfer fallback')
  } else {
    // Registered even when the server already sends the isolation headers, which it does under
    // `vite dev` and `vite preview`: the worker is also what makes the app installable and
    // available offline, and its header pass is a no-op when the headers are already there.
    navigator.serviceWorker
      .register(scriptUrl)
      .then(async (registration) => {
        const controlled = Boolean(navigator.serviceWorker.controller)

        // A worker installing while another one is already driving this page means a new
        // build has been published. The document in front of you was served by the old one
        // and names chunks the new one may not have; one reload puts it all on one build.
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing
          if (!installing || !controlled) return
          installing.addEventListener('statechange', () => {
            if (installing.state === 'activated') window.location.reload()
          })
        })

        if (controlled) {
          // Already isolated by a worker, or by a server that sends the headers itself. Clear
          // the guard so a later visit to a host with neither can still bootstrap.
          try {
            sessionStorage.removeItem(RELOAD_FLAG)
          } catch {
            /* storage can be blocked; the guard is best-effort */
          }
          return
        }

        // Uncontrolled, but the server is supplying the headers on its own. Nothing to fix,
        // and the next load will pick the worker up for free.
        if (window.crossOriginIsolated) return

        // Uncontrolled and not isolated: nothing is adding the headers to this document. One
        // reload hands the page to the worker, which is when they start arriving. Guarded so
        // a worker that somehow fails to produce isolation cannot cause a reload loop.
        await navigator.serviceWorker.ready
        let alreadyReloaded = false
        try {
          alreadyReloaded = sessionStorage.getItem(RELOAD_FLAG) === '1'
          sessionStorage.setItem(RELOAD_FLAG, '1')
        } catch {
          /* storage blocked: fall through and reload at most this once */
        }
        if (!alreadyReloaded) window.location.reload()
      })
      .catch((error) => console.warn('[sw] registration failed', error))
  }
}
