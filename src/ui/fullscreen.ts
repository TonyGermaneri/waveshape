/**
 * Full screen.
 *
 * The whole document goes full screen rather than the canvas alone, because the overlay, the
 * readout and the axis labels are DOM siblings of the canvas — taking only the canvas would
 * leave the controls behind on the desktop. `resize()` is driven by the ResizeObserver on the
 * canvas, so nothing here has to tell the renderer about the new size.
 */

/** Older WebKit shipped this API prefixed and never renamed it. */
interface WebkitFullscreen {
  webkitFullscreenElement?: Element | null
  webkitRequestFullscreen?: () => Promise<void> | void
  webkitExitFullscreen?: () => Promise<void> | void
}

export function fullscreenSupported(): boolean {
  const el = document.documentElement as HTMLElement & WebkitFullscreen
  return typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function'
}

export function isFullscreen(): boolean {
  const doc = document as Document & WebkitFullscreen
  return Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement)
}

/** Resolves to the state actually reached, which is not always the state asked for. */
export async function setFullscreen(on: boolean): Promise<boolean> {
  const doc = document as Document & WebkitFullscreen
  const el = document.documentElement as HTMLElement & WebkitFullscreen
  try {
    if (on) {
      // `navigationUI: 'hide'` is a hint; browsers that do not honour it ignore the argument.
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' })
      else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen()
      else return false
    } else {
      if (doc.exitFullscreen) await doc.exitFullscreen()
      else if (doc.webkitExitFullscreen) await doc.webkitExitFullscreen()
    }
  } catch {
    // Rejected because the gesture was not user-activated, or the platform refuses outright
    // (iOS Safari only allows video elements). Reporting the real state is the honest answer.
  }
  return isFullscreen()
}

export function toggleFullscreen(): Promise<boolean> {
  return setFullscreen(!isFullscreen())
}

export function onFullscreenChange(listener: () => void): void {
  document.addEventListener('fullscreenchange', listener)
  document.addEventListener('webkitfullscreenchange', listener)
}
