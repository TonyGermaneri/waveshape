import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

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

/** Written into the worker by the plugin below; see the matching constant in public/sw.js. */
const PRECACHE_PLACEHOLDER = 'null /* WAVESHAPE_PRECACHE */'

/**
 * Nothing worth carrying offline: sourcemaps, which only devtools ever asks for and which
 * outweigh the app several times over; whatever the platform littered the tree with; and the
 * worker itself, which cannot precache the file it is being written into.
 */
const NOT_PRECACHED = /(\.map$|(^|\/)\.|^sw\.js$)/

/**
 * Hands `public/sw.js` the list of files it should hold offline, and a version to key its cache
 * on. Both are only knowable once the build has been written, so they are patched into the copy
 * in `dist` rather than living in the source — where the placeholder stays `null`, which is the
 * worker's signal that it is running against a dev server and should not cache at all.
 *
 * The version is a digest of every precached byte, which gives the two properties the worker
 * needs from it: a build that changed nothing keeps its cache, and a build that changed anything
 * gets a new one and drops the old on activation. It also changes `sw.js` itself on every real
 * deploy, which is what makes the browser notice there is an update to install.
 */
function precache(): Plugin {
  let outDir = ''
  return {
    name: 'waveshape:precache',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    // Not `writeBundle`: the public directory is copied around the same time, and only by
    // `closeBundle` is everything that will ship guaranteed to be on disk.
    closeBundle() {
      const files = walk(outDir).sort()
      const digest = createHash('sha256')
      for (const file of files) {
        digest.update(file)
        digest.update(readFileSync(join(outDir, file)))
      }

      const swPath = join(outDir, 'sw.js')
      const source = readFileSync(swPath, 'utf8')
      if (!source.includes(PRECACHE_PLACEHOLDER)) {
        // Silence here would ship a worker that quietly never caches anything.
        this.error(`${swPath} has no ${PRECACHE_PLACEHOLDER} to fill in`)
      }

      const manifest = {
        version: digest.digest('hex').slice(0, 16),
        // './' rather than './index.html' first, because that is the URL a navigation actually
        // asks for and therefore the key it will be looked up under.
        files: ['./', ...files.map((file) => `./${file}`)],
      }
      writeFileSync(swPath, source.replace(PRECACHE_PLACEHOLDER, JSON.stringify(manifest)))
      this.info(`precaching ${manifest.files.length} files as waveshape-${manifest.version}`)
    },
  }
}

/** Every shipped file, as a URL path relative to the output root — `/` separated on any host. */
function walk(dir: string, root = dir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walk(path, root))
      continue
    }
    const name = relative(root, path).split(sep).join('/')
    if (!NOT_PRECACHED.test(name)) out.push(name)
  }
  return out
}

export default defineConfig({
  base: './',
  plugins: [precache()],
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
