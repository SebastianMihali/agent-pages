import { sitePathProblem } from '../../shared/site-file'

export type PublicationLimits = {
  maxFileBytes: number
  maxBatchFiles: number
  maxMultipartBodyBytes: number
  maxFilesPerSite: number
  maxSiteBytes: number
}

type PickedFile = { relativePath: string; sizeBytes: number }
type ExistingFile = { path: string; sizeBytes: number }

export function planPublication({ mode, picked, existing, limits }: {
  mode: 'create' | 'write'
  picked: readonly PickedFile[]
  existing: readonly ExistingFile[]
  limits: PublicationLimits
}) {
  const files: Array<{ path: string; index: number; change: 'new' | 'overwrite' }> = []
  const ignored: Array<{ path: string; reason: string }> = []
  const blockers: string[] = []
  const candidates: Array<{ path: string; index: number; sizeBytes: number }> = []

  // Inspect original paths before stripping a folder: a hidden or malformed
  // parent must never turn into an acceptable destination by normalization.
  picked.forEach((file, index) => {
    const segments = file.relativePath.split('/')
    const junk = segments.find((segment) => segment.startsWith('.') || segment === '__MACOSX' || segment === 'Thumbs.db')
    const problem = sitePathProblem(file.relativePath)
    if (junk || problem) {
      ignored.push({ path: file.relativePath, reason: junk ? `Ignored system or hidden path: ${junk}` : problem!.message })
    } else {
      candidates.push({ path: file.relativePath, index, sizeBytes: file.sizeBytes })
    }
  })

  const firstFolder = candidates[0]?.path.split('/')[0]
  const stripFolder = mode === 'create' && firstFolder && candidates.every((file) => file.path.startsWith(`${firstFolder}/`))
  const original = new Map(existing.map((file) => [file.path, file.sizeBytes]))
  const result = new Map(original)
  const selected = new Set<string>()
  let uploadBytes = 0
  for (const file of candidates) {
    const path = stripFolder ? file.path.slice(firstFolder.length + 1) : file.path
    // Stripping can reveal the reserved root segment _agent.
    const problem = sitePathProblem(path)
    if (problem) {
      ignored.push({ path: file.path, reason: problem.message })
      continue
    }
    if (selected.has(path)) blockers.push(`Duplicate destination path: ${path}`)
    selected.add(path)
    files.push({ path, index: file.index, change: original.has(path) ? 'overwrite' : 'new' })
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) blockers.push(`Invalid file size: ${path}`)
    if (file.sizeBytes > limits.maxFileBytes) blockers.push(`File exceeds the file size limit: ${path}`)
    uploadBytes += file.sizeBytes
    result.set(path, file.sizeBytes)
  }

  if (!files.length) blockers.push('Select at least one supported file.')
  if (mode === 'create' && !selected.has('index.html')) blockers.push('A new site requires index.html at the site root.')
  if (files.length > limits.maxBatchFiles) blockers.push(`Select no more than ${limits.maxBatchFiles} files per publication.`)
  if (uploadBytes > limits.maxMultipartBodyBytes) blockers.push('The selection exceeds the upload size limit.')
  if (result.size > limits.maxFilesPerSite) blockers.push(`The resulting site exceeds the limit of ${limits.maxFilesPerSite} files.`)
  let siteBytes = 0
  for (const [path, sizeBytes] of result) {
    siteBytes += sizeBytes
    const segments = path.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join('/')
      if (result.has(parent)) blockers.push(`File and directory paths collide: ${parent} and ${path}`)
    }
  }
  if (siteBytes > limits.maxSiteBytes) blockers.push('The resulting site exceeds the site size limit.')
  return { files, ignored, blockers }
}
