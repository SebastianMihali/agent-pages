import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  // Runtime configuration reaches the process through `node --env-file` in
  // development and the platform in production. Vite must not read `.env`
  // itself: its NODE_ENV=development would compile a production build with
  // the development JSX runtime, which fails at SSR time.
  envDir: false,
  ssr: { external: ['fs-ext', 'better-sqlite3'] },
  plugins: [
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
