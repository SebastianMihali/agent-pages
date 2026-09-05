import type { AppConfig } from '../config'
import type { AppDatabase } from '../db'
import type { Principal } from '../errors'

export type Visibility = 'private' | 'public'

export type TextFileInput = Readonly<{ path: string; content: string }>
export type BinaryFileInput = Readonly<{
  path: string
  body: Uint8Array | AsyncIterable<Uint8Array>
  maximumBytes: number
}>
export type FileInput = TextFileInput | BinaryFileInput

export type SiteView = Readonly<{
  id: string
  name: string
  visibility: Visibility
  version: number
  revisionId: string
  url: string
  openUrl: string
  createdAt: string
  updatedAt: string
  expiresAt: string | null
  sizeBytes: number
  fileCount: number
}>

export type ManifestEntry = Readonly<{
  path: string
  sizeBytes: number
  contentType: string
  digest: string
}>

export type MutationReceipt = Readonly<{
  operationId: string
  operationExpiresAt: string
}>

export type CreateResult = MutationReceipt & Readonly<{ site: SiteView }>
export type FileMutationResult = MutationReceipt & Readonly<{
  site: SiteView
  changedPaths: readonly string[]
  deletedPaths: readonly string[]
}>
export type VisibilityResult = MutationReceipt & Readonly<{ site: SiteView }>
export type DeleteResult = MutationReceipt & Readonly<{
  siteId: string
  version: number
  deleted: true
  cleanupPending: boolean
}>

export type OpenedFile = Readonly<{
  path: string
  revisionId: string
  digest: string
  sizeBytes: number
  contentType: string
  body: ReadableStream<Uint8Array>
}>

export interface RevisionLease {
  readonly site: Readonly<{
    id: string
    ownerId: string
    visibility: Visibility
    visibilityGeneration: number
    expiresAt: Date | null
  }>
  readonly revisionId: string
  readonly manifest: readonly ManifestEntry[]
  open(path: string): Promise<OpenedFile>
  release(): Promise<void>
}

export interface SiteModule {
  createSite(principal: Principal, command: Readonly<{
    operationId: string
    name: string
    files: readonly FileInput[]
    maximumUploadBytes?: number
    expiresInSeconds?: number | null
  }>): Promise<CreateResult>
  listSites(principal: Principal, query?: Readonly<{ cursor?: string; limit?: number }>): Promise<Readonly<{
    sites: readonly SiteView[]
    cursor: string | null
  }>>
  getSite(principal: Principal, siteId: string): Promise<SiteView>
  writeFiles(principal: Principal, command: Readonly<{
    operationId: string
    siteId: string
    expectedVersion: number
    files: readonly FileInput[]
    maximumUploadBytes?: number
  }>): Promise<FileMutationResult>
  deleteFiles(principal: Principal, command: Readonly<{
    operationId: string
    siteId: string
    expectedVersion: number
    paths: readonly string[]
  }>): Promise<FileMutationResult>
  setVisibility(principal: Principal, command: Readonly<{
    operationId: string
    siteId: string
    expectedVersion: number
    visibility: Visibility
  }>): Promise<VisibilityResult>
  deleteSite(principal: Principal, command: Readonly<{
    operationId: string
    siteId: string
    expectedVersion: number
  }>): Promise<DeleteResult>
  listFiles(principal: Principal, query: Readonly<{
    siteId: string
    revisionId?: string
    cursor?: string
    limit?: number
  }>): Promise<Readonly<{
    revisionId: string
    files: readonly ManifestEntry[]
    cursor: string | null
  }>>
  openOwnedFile(principal: Principal, query: Readonly<{
    siteId: string
    path: string
    revisionId?: string
  }>): Promise<OpenedFile>
  acquireActiveRevision(siteId: string, now?: Date): Promise<RevisionLease>
  recover(): Promise<void>
  runCleanup(now?: Date): Promise<Readonly<{ removedRevisions: number; removedSites: number }>>
  close(): Promise<void>
}

export type SiteModuleFaultPoint = 'before-revision-file-copy' | 'after-stage' | 'after-finalize' | 'after-commit'
export type SiteModuleOptions = Readonly<{
  now?: () => Date
  fault?: (point: SiteModuleFaultPoint) => void | Promise<void>
}>

export { createSiteModule } from './site-module'
export type { AppConfig, AppDatabase }
