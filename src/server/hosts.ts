import type { AppConfig } from './config'

type Handler = (request: Request) => Response | Promise<Response>

export function createHostHandler(config: AppConfig, handlers: {
  app: Handler
  content: (request: Request, siteId: string) => Response | Promise<Response>
  ready: () => boolean
}): Handler {
  return (request) => {
    const url = new URL(request.url)
    // Some Fetch adapters construct the URL from forwarded headers. They must
    // agree with the original Host; only the configured proxy may preserve it.
    const host = request.headers.get('host')
    if (host !== null && host.toLowerCase() !== url.host) {
      return new Response('Not found', { status: 404 })
    }
    if (url.host === config.appAuthority || url.host === `127.0.0.1:${config.port}`) {
      if (request.method === 'GET' && (url.pathname === '/health/live' || url.pathname === '/health/ready')) {
        const ready = url.pathname === '/health/live' || handlers.ready()
        return Response.json({ status: ready ? 'ok' : 'unavailable' }, {
          status: ready ? 200 : 503,
          headers: { 'cache-control': 'no-store' },
        })
      }
    }
    const port = config.contentPort ? `:${config.contentPort}` : ''
    if (url.host === config.appAuthority) return handlers.app(request)
    const suffix = `.${config.contentBaseDomain}${port}`
    if (url.host.endsWith(suffix)) {
      const siteId = url.host.slice(0, -suffix.length)
      if (/^[a-f0-9]{32}$/.test(siteId)) return handlers.content(request, siteId)
    }
    return new Response('Not found', { status: 404 })
  }
}

export function siteOrigin(config: AppConfig, siteId: string) {
  if (!/^[a-f0-9]{32}$/.test(siteId)) throw new Error('Invalid site identity')
  return `${config.secureCookies ? 'https' : 'http'}://${siteId}.${config.contentBaseDomain}${config.contentPort ? `:${config.contentPort}` : ''}`
}
