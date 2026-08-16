import { defineConfig } from 'vite'

/**
 * SharedArrayBuffer — which the lock-free audio ring depends on — is only exposed to
 * cross-origin-isolated documents. That requires both COOP and COEP response headers.
 * Without them the app still runs, but the capture path silently degrades to the
 * postMessage transfer fallback (see src/audio/ring.ts).
 */
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

export default defineConfig({
  base: './',
  server: {
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  worker: {
    // AudioWorklet.addModule() and Worker(..., {type:'module'}) both want real ES modules.
    format: 'es',
  },
  build: {
    target: 'esnext',
    sourcemap: true,
  },
})
