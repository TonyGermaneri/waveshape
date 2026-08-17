/**
 * Installing the app, and what it has kept for when there is no network.
 *
 * A browser decides on its own when a page is installable, and tells you by firing
 * `beforeinstallprompt` — once, early, and usually before any of this app's own setup has
 * finished. The event has to be caught and kept at module scope for that reason: by the time
 * the System tab is built there is nothing left to listen for.
 *
 * Only Chromium fires it. Safari and Firefox install from a menu item instead and expose no
 * hook at all, so `canInstall()` is false there and the control says where to look instead of
 * pretending it can do the job.
 *
 * The offline half is deliberately a report on what is actually in Cache Storage rather than on
 * what should be: a worker that failed to precache is exactly the case worth seeing, and it is
 * invisible from anywhere else.
 */

/** Chromium-only, and not in lib.dom. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/** iOS Safari reports a home-screen launch here and nowhere else. */
interface IosStandalone {
  standalone?: boolean
}

let deferred: BeforeInstallPromptEvent | null = null
let installedThisSession = false
const listeners = new Set<() => void>()

function announce(): void {
  for (const listener of listeners) listener()
}

window.addEventListener('beforeinstallprompt', (event) => {
  // Suppressing the browser's own mini-infobar is what buys the right to prompt later, from
  // the Install control, where the offer is an answer to something the reader went looking for.
  event.preventDefault()
  deferred = event as BeforeInstallPromptEvent
  announce()
})

window.addEventListener('appinstalled', () => {
  // Spent: the event cannot be prompted twice, and there is nothing left to install.
  deferred = null
  installedThisSession = true
  announce()
})

/** Fires when the answer to `canInstall()` or `isInstalled()` changes. */
export function onInstallChange(listener: () => void): void {
  listeners.add(listener)
}

/** True when the page is running as an installed app rather than in a browser tab. */
export function isInstalled(): boolean {
  if (installedThisSession) return true
  if ((navigator as Navigator & IosStandalone).standalone) return true
  // `minimal-ui` and `fullscreen` are the other two an installed launch can land in; a tab is
  // always `browser`.
  return ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay'].some(
    (mode) => window.matchMedia(`(display-mode: ${mode})`).matches,
  )
}

/** True when a prompt is in hand and can still be shown. */
export function canInstall(): boolean {
  return deferred !== null
}

/**
 * Shows the browser's install dialog. Resolves to what the reader chose — or to false when
 * there was no prompt to show, which is every browser outside Chromium.
 */
export async function promptInstall(): Promise<boolean> {
  const event = deferred
  if (!event) return false
  // A prompt is single-use whatever the outcome. Dropping it here rather than on the result
  // keeps a double click from calling `prompt()` twice, which throws.
  deferred = null
  announce()
  try {
    await event.prompt()
    const { outcome } = await event.userChoice
    return outcome === 'accepted'
  } catch {
    return false
  }
}

let offline = 'checking…'

/**
 * Re-reads what the worker is holding. Cheap, asynchronous and idempotent, so the System tab
 * calls it every time it is built rather than trying to guess when the answer changed — the
 * precache lands during the load that registers the worker, which is a race nothing here wins.
 */
export async function refreshOfflineState(): Promise<void> {
  const was = offline
  offline = await readOfflineState()
  if (offline !== was) announce()
}

async function readOfflineState(): Promise<string> {
  if (!navigator.serviceWorker) return 'unavailable — no service worker'
  try {
    const prefix = 'waveshape-'
    const names = (await caches.keys()).filter((name) => name.startsWith(prefix))
    // Half of the digest the build stamped on the cache: enough to tell two deploys apart by
    // eye, which is all anyone reads it for.
    if (names.length) return `held for offline — build ${names[0].slice(prefix.length, prefix.length + 8)}`
    // A worker is in front of every request but has stored nothing: the dev server, where
    // caching is switched off on purpose (see public/sw.js).
    if (navigator.serviceWorker.controller) return 'not stored — served live'
    return 'no worker yet — reload to hand the page over'
  } catch {
    // Cache Storage is absent outside a secure context, and blocked outright by some privacy
    // settings. Neither is an error worth showing as one.
    return 'unavailable'
  }
}

/** One line on whether this build would still open with the network gone. */
export function offlineStatus(): string {
  return offline
}
