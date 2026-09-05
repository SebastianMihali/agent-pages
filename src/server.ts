import { randomBytes } from 'node:crypto'
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { createServerEntry } from '@tanstack/react-start/server-entry'
import { getRuntime } from './server/runtime'
import { createHostHandler } from './server/hosts'
import { createMcpHandler } from './server/mcp'
import { serveAppAsset } from './server/app-assets'
import { createAuthWebHandler } from './server/web-auth'
import { createSitesWebHandler } from './server/web-sites'
import { createContentHandler } from './server/content'
import { createApiHandler } from './server/api'
import { registerSiteTools } from './server/mcp-tools'
import { errorResponse, requireOrigin } from './server/errors'
import { cookieNames, readCookie } from './server/web-auth'

let dispatch: ReturnType<typeof createHostHandler> | undefined

export default createServerEntry({
  async fetch(request) {
    if (!dispatch) {
      const { config, auth, sites, access, admit, ready } = await getRuntime()
      const mcp = createMcpHandler(config, {
        authenticate: auth.readBearer,
        register: (server, principal) => registerSiteTools(server, principal, sites, config),
      })
      const webAuth = createAuthWebHandler(config, auth)
      const webSites = createSitesWebHandler(config, auth, sites, access)
      const api = createApiHandler(config, auth, sites)
      const renderApp = createStartHandler(async (context) => {
        const nonce = randomBytes(24).toString('base64')
        context.router.update({ ssr: { nonce } })
        context.responseHeaders.set('content-security-policy', `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${config.production ? '' : ' ws: wss:'}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; worker-src 'none'`)
        return defaultStreamHandler(context)
      })
      dispatch = createHostHandler(config, {
        app: async (incoming) => {
          const path = new URL(incoming.url).pathname
          if (path === '/mcp' || path.startsWith('/api/') || path.startsWith('/web/') || path.startsWith('/sites/')) {
            try {
              if (path === '/mcp' || path.startsWith('/api/')) auth.readBearer(incoming)
              else if (incoming.method !== 'GET') {
                requireOrigin(incoming, config.appOrigin)
                if (path !== '/web/login') auth.requireSession(readCookie(incoming, cookieNames(config).session))
              }
              const owned = await admit(async () => path === '/mcp' ? mcp(incoming) :
                await webAuth(incoming) ?? await webSites(incoming) ?? await api(incoming))
              if (owned) return owned
            } catch (error) { return errorResponse(error) }
          }
          if (path.startsWith('/web/') || path.startsWith('/api/') || path.startsWith('/sites/')) return new Response('Not found', { status: 404 })
          if (import.meta.env.PROD) {
            const asset = await serveAppAsset(incoming)
            if (asset) return asset
          }
          const response = await renderApp(incoming)
          response.headers.set('cache-control', 'no-store')
          response.headers.set('x-content-type-options', 'nosniff')
          response.headers.set('referrer-policy', 'no-referrer')
          response.headers.set('cross-origin-resource-policy', 'same-origin')
          response.headers.set('origin-agent-cluster', '?1')
          response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), document-domain=()')
          return response
        },
        content: createContentHandler(config, sites, access), ready,
      })
    }
    return dispatch(request)
  },
})
