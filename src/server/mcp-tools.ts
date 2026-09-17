import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { AppConfig } from './config'
import { DomainError, isDomainError, logFailure, type Principal } from './errors'
import { siteInputSchemas } from './site-input'
import type { SiteModule } from './sites'

async function result(operation: () => Promise<Record<string, unknown>>, summary: string): Promise<CallToolResult> {
  try {
    return { structuredContent: await operation(), content: [{ type: 'text', text: summary }] }
  } catch (cause) {
    const error = isDomainError(cause) ? cause : new DomainError('STORAGE_UNAVAILABLE', 'The operation could not be completed', undefined, { cause })
    const requestId = crypto.randomUUID()
    logFailure('tool_failed', cause, { requestId })
    return { isError: true, structuredContent: { error: { code: error.code, message: error.message, retryable: error.retryable,
      requestId, ...(error.details ? { details: error.details } : {}) } },
    content: [{ type: 'text', text: `${error.code}: ${error.message}` }] }
  }
}

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const writeAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }

async function boundedText(body: ReadableStream<Uint8Array>, maximumBytes: number): Promise<string | null> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let content = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        try { return content + decoder.decode() } catch { return null }
      }
      bytes += chunk.value.byteLength
      if (bytes > maximumBytes) return null
      try { content += decoder.decode(chunk.value, { stream: true }) } catch { return null }
    }
  } finally { await reader.cancel(); reader.releaseLock() }
}

export function registerSiteTools(server: McpServer, principal: Principal, sites: SiteModule, config: AppConfig) {
  const schemas = siteInputSchemas(config)
  const siteId = schemas.get.shape.siteId
  server.registerTool('create_site', {
    description: 'Create a private static site. The operationId UUID makes retries safe within the returned operation receipt lifetime.',
    inputSchema: schemas.create, annotations: { ...writeAnnotations, destructiveHint: false },
  }, (input) => result(() => sites.createSite(principal, input), 'Private site created.'))
  server.registerTool('list_sites', {
    description: 'List owned sites, up to 50 per page.', inputSchema: schemas.list, annotations: readAnnotations,
  }, (input) => result(() => sites.listSites(principal, input), 'Owned sites listed.'))
  server.registerTool('get_site', {
    description: 'Read an owned site’s metadata.', inputSchema: schemas.get, annotations: readAnnotations,
  }, (input) => result(() => sites.getSite(principal, input.siteId), 'Site metadata read.'))
  server.registerTool('list_files', {
    description: 'List up to 100 file entries, with the selected revision ID. Send that revisionId on subsequent pages and reads.',
    inputSchema: schemas.listFiles, annotations: readAnnotations,
  }, (input) => result(() => sites.listFiles(principal, input), 'Site files listed.'))
  server.registerTool('read_file', {
    description: 'Read bounded text from an owned site. Binary or large files return metadata and a bearer-authenticated REST download path.',
    inputSchema: schemas.read, annotations: readAnnotations,
  }, (input) => result(async () => {
    const file = await sites.openOwnedFile(principal, input)
    const { body, ...metadata } = file
    const downloadPath = `/api/sites/${input.siteId}/file?${new URLSearchParams({ path: file.path, revisionId: file.revisionId })}`
    if (!/\.(?:html?|css|m?js|json|svg|txt|md|xml|webmanifest|map)$/i.test(file.path) || file.sizeBytes > config.limits.maxMcpTextBytes) {
      await body.cancel()
      return { ...metadata, downloadPath }
    }
    const content = await boundedText(body, config.limits.maxMcpTextBytes)
    return content === null ? { ...metadata, downloadPath } : { ...metadata, content }
  }, 'Site file read.'))
  server.registerTool('write_files', {
    description: 'Atomically replace or add UTF-8 site files while preserving visibility. Requires current expectedVersion and an operationId UUID.',
    inputSchema: schemas.write.extend({ siteId }), annotations: writeAnnotations,
  }, (input) => result(() => sites.writeFiles(principal, input), 'Site files written.'))
  server.registerTool('delete_files', {
    description: 'Atomically delete named site files; root index.html must remain. Requires expectedVersion and an operationId UUID.',
    inputSchema: schemas.deleteFiles.extend({ siteId }), annotations: writeAnnotations,
  }, (input) => result(() => sites.deleteFiles(principal, input), 'Site files deleted.'))
  server.registerTool('set_site_visibility', {
    description: 'Explicitly make a site public, allowing anyone to read it, or private, revoking subsequent anonymous access. Does not recall downloaded copies.',
    inputSchema: schemas.visibility.extend({ siteId }), annotations: writeAnnotations,
  }, (input) => result(() => sites.setVisibility(principal, input), 'Site visibility changed.'))
  server.registerTool('set_site_expiration', {
    description: 'Set an owned site expiration relative to this call, or remove expiration with null. Expired sites cannot be revived.',
    inputSchema: schemas.expiration.extend({ siteId }), annotations: writeAnnotations,
  }, (input) => result(() => sites.setExpiration(principal, input), 'Site expiration changed.'))
  server.registerTool('delete_site', {
    description: 'Delete an owned site and deny new reads; disk cleanup may remain pending. Requires expectedVersion and an operationId UUID.',
    inputSchema: schemas.delete.extend({ siteId }), annotations: writeAnnotations,
  }, (input) => result(() => sites.deleteSite(principal, input), 'Site deleted.'))
}
