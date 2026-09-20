import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import type { Connect, Plugin } from 'vite'

// The development server's own middlewares answer script, style and image
// paths from this project before Nitro runs. Requests for a site host belong
// to the application's host dispatch, so hand them to Nitro untouched.
function contentHostsBypassVite(): Plugin {
  return {
    name: 'agent-pages:content-hosts-bypass-vite',
    apply: 'serve',
    enforce: 'pre',
    configureServer(server) {
      const suffix = `.${(process.env.CONTENT_BASE_DOMAIN ?? '').toLowerCase()}`
      server.middlewares.use((req, res, next) => {
        const hostname = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '')
        if (suffix === '.' || !hostname.endsWith(suffix)) return next()
        const nitroHandler = server.middlewares.stack
          .map((layer) => layer.handle)
          .find((handle) => typeof handle === 'function' && handle.name === 'nitroDevMiddleware')
        if (!nitroHandler) return next(new Error('Nitro development middleware not found'))
        ;(nitroHandler as Connect.NextHandleFunction)(req, res, next)
      })
    },
  }
}

export default defineConfig({
  // Runtime configuration reaches the process through `node --env-file` in
  // development and the platform in production. Vite must not read `.env`
  // itself: its NODE_ENV=development would compile a production build with
  // the development JSX runtime, which fails at SSR time.
  envDir: false,
  ssr: { external: ['fs-ext', 'better-sqlite3'] },
  plugins: [
    contentHostsBypassVite(),
    tanstackStart(),
    nitro({
      preset: 'node-server',
      // Native flock must remain a runtime dependency, including its binary.
      traceDeps: ['fs-ext*'],
      rollupConfig: {
        external: (id) => id.endsWith('.node'),
      },
      // Nitro otherwise adds a global immutable rule for the client assets
      // path, which also matches untrusted site hosts before/after dispatch.
      routeRules: {
        '/assets/**': { headers: { 'cache-control': 'no-store' } },
      },
      plugins: ['./src/server/bootstrap-plugin.ts'],
      // Host dispatch runs in the application handler. Nitro must not answer an
      // asset request before that boundary has accepted the effective host.
      serveStatic: false,
    }),
    tailwindcss(),
    viteReact(),
  ],
  server: {
    host: '127.0.0.1',
    port: 3000,
  },
})
