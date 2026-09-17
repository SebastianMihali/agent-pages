import { describe, expect, it } from 'vitest'
import { planPublication, type PublicationLimits } from './publication-plan'

const limits: PublicationLimits = {
  maxFileBytes: 100, maxBatchFiles: 10, maxMultipartBodyBytes: 500,
  maxFilesPerSite: 20, maxSiteBytes: 1000,
}
const picked = (...paths: string[]) => paths.map((relativePath) => ({ relativePath, sizeBytes: 10 }))

describe('publication plan', () => {
  it('strips one folder only for creation, keeping original file indexes', () => {
    const input = picked('website/.DS_Store', 'website/index.html', 'website/assets/style.css')
    expect(planPublication({ mode: 'create', picked: input, existing: [], limits })).toMatchObject({
      files: [{ path: 'index.html', index: 1, change: 'new' }, { path: 'assets/style.css', index: 2, change: 'new' }],
      ignored: [{ path: 'website/.DS_Store' }], blockers: [],
    })
    expect(planPublication({ mode: 'write', picked: input, existing: [], limits }).files.map((file) => file.path))
      .toEqual(['website/index.html', 'website/assets/style.css'])
  })

  it('preserves single-file root destinations and does not flatten multiple folders', () => {
    expect(planPublication({ mode: 'create', picked: picked('index.html', 'styles.css'), existing: [], limits }).blockers).toEqual([])
    const plan = planPublication({ mode: 'create', picked: picked('one/index.html', 'two/style.css'), existing: [], limits })
    expect(plan.files.map((file) => file.path)).toEqual(['one/index.html', 'two/style.css'])
    expect(plan.blockers).toContain('A new site requires index.html at the site root.')
  })

  it.each(['.DS_Store', 'Thumbs.db', '__MACOSX/a.txt', '.git/config.txt', 'a/.secret.txt', 'video.mp4', 'LICENSE', '../a.txt', '/a.txt', 'a//b.txt', 'a%20b.txt', 'a\\b.txt', '_agent/index.html'])('ignores %s with a reason', (path) => {
    const plan = planPublication({ mode: 'write', picked: picked(path), existing: [], limits })
    expect(plan.files).toEqual([])
    expect(plan.ignored).toEqual([{ path, reason: expect.any(String) }])
    expect(plan.blockers).toContain('Select at least one supported file.')
  })

  it('does not make a hidden folder valid by stripping it, or expose a reserved root', () => {
    expect(planPublication({ mode: 'create', picked: picked('.hidden/index.html'), existing: [], limits }).files).toEqual([])
    expect(planPublication({ mode: 'create', picked: picked('site/_agent/index.html'), existing: [], limits }).files).toEqual([])
  })

  it('classifies overwrites against the manifest and counts replacement bytes once', () => {
    const plan = planPublication({ mode: 'write', picked: picked('index.html', 'guide.md', 'manual.pdf'),
      existing: [{ path: 'index.html', sizeBytes: 90 }, { path: 'keep.css', sizeBytes: 20 }],
      limits: { ...limits, maxSiteBytes: 50, maxFilesPerSite: 4 } })
    expect(plan.files.map((file) => file.change)).toEqual(['overwrite', 'new', 'new'])
    expect(plan.blockers).toEqual([])
  })

  it.each([
    [{ maxFileBytes: 9 }, 'File exceeds the file size limit: index.html'],
    [{ maxBatchFiles: 1 }, 'Select no more than 1 files per publication.'],
    [{ maxMultipartBodyBytes: 19 }, 'The selection exceeds the upload size limit.'],
    [{ maxFilesPerSite: 1 }, 'The resulting site exceeds the limit of 1 files.'],
    [{ maxSiteBytes: 19 }, 'The resulting site exceeds the site size limit.'],
  ])('blocks exceeded publication limit %j', (override, message) => {
    const plan = planPublication({ mode: 'write', picked: picked('index.html', 'a.txt'), existing: [], limits: { ...limits, ...override } })
    expect(plan.blockers).toContain(message)
  })

  it('blocks collisions independent of selection order and with unchanged files', () => {
    for (const paths of [['a.txt', 'a.txt/b.txt'], ['a.txt/b.txt', 'a.txt']]) {
      expect(planPublication({ mode: 'write', picked: picked(...paths), existing: [], limits }).blockers)
        .toContain('File and directory paths collide: a.txt and a.txt/b.txt')
    }
    for (const [selected, old] of [['a.txt', 'a.txt/b.txt'], ['a.txt/b.txt', 'a.txt']]) {
      expect(planPublication({ mode: 'write', picked: picked(selected), existing: [{ path: old, sizeBytes: 1 }], limits }).blockers)
        .toContain('File and directory paths collide: a.txt and a.txt/b.txt')
    }
    const duplicate = planPublication({ mode: 'write', picked: picked('a.txt', 'a.txt'), existing: [], limits })
    expect(duplicate.blockers).toContain('Duplicate destination path: a.txt')
    expect(duplicate.files.map((file) => file.change)).toEqual(['new', 'new'])
  })
})
