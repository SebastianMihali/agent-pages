import { z } from 'zod'
import type { AppConfig } from './config'
import { DomainError } from './errors'

export function siteInputSchemas(config: AppConfig) {
  const siteId = z.string().regex(/^[a-f0-9]{32}$/)
  const operationId = z.uuid()
  const expectedVersion = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  const path = z.string().min(1).max(512)
  const files = z.array(z.strictObject({ path, content: z.string() })).min(1).max(config.limits.maxBatchFiles)
  const cursor = z.string().min(1).max(2048).optional()
  const revisionId = z.string().regex(/^[a-f0-9]{32}$/).optional()
  const expiresInSeconds = z.number().int().min(60).max(2592000).nullable()
  return {
    create: z.strictObject({ operationId, name: z.string().trim().min(1).max(100), files,
      expiresInSeconds: expiresInSeconds.optional() }),
    list: z.strictObject({ cursor, limit: z.number().int().min(1).max(50).optional() }),
    get: z.strictObject({ siteId }),
    read: z.strictObject({ siteId, path, revisionId }),
    listFiles: z.strictObject({ siteId, revisionId, cursor, limit: z.number().int().min(1).max(100).optional() }),
    write: z.strictObject({ operationId, expectedVersion, files }),
    deleteFiles: z.strictObject({ operationId, expectedVersion, paths: z.array(path).min(1).max(config.limits.maxBatchFiles) }),
    visibility: z.strictObject({ operationId, expectedVersion, visibility: z.enum(['private', 'public']) }),
    expiration: z.strictObject({ operationId, expectedVersion, expiresInSeconds }),
    delete: z.strictObject({ operationId, expectedVersion }),
  }
}

export function parseSiteInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new DomainError('INVALID_INPUT', 'Request fields are invalid or unsupported')
  return parsed.data
}
