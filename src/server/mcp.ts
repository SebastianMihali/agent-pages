import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { AppConfig } from './config'
import { errorResponse, requireOrigin } from './errors'
import type { Principal } from './errors'
import { readJson } from './body'

export function createMcpHandler(config: AppConfig, dependencies: {
  authenticate: (request: Request) => Principal | Promise<Principal>
  register: (server: McpServer, principal: Principal) => void
}) {
  return async (request: Request): Promise<Response> => {
    let server: McpServer | undefined
    try {
      requireOrigin(request, config.appOrigin, false)
      const principal = await dependencies.authenticate(request)
      if (request.method !== 'POST') {
        return new Response(null, { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } })
      }
      const parsedBody = await readJson(request, config.limits.maxJsonBodyBytes)
      server = new McpServer({ name: 'agent-pages', version: '0.1.0' })
      dependencies.register(server, principal)
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
      await server.connect(transport)
      const response = await transport.handleRequest(request, { parsedBody })
      response.headers.set('cache-control', 'no-store')
      return response
    } catch (error) { return errorResponse(error) }
    finally { await server?.close() }
  }
}
