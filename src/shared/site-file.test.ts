import { describe, expect, it } from 'vitest'
import { fileLanguage, sitePathProblem } from './site-file'

describe('shared site path rules', () => {
  it.each(['index.html', 'nested/page.htm', 'assets/file.CSS', 'docs/readme.md', 'document.PDF',
    'data.webmanifest', 'app.js.map', '日本語/ページ.html', `${'é'.repeat(253)}.html`, `${'a/'.repeat(31)}index.html`])('accepts %s', (path) => {
    expect(sitePathProblem(path)).toBeNull()
  })

  it.each(['', '/index.html', 'a\\file.html', 'a%20file.html', 'bad\u0000.html', 'bad\u007f.html', '../index.html',
    './index.html', 'a//index.html', '.git/config.txt', 'a/.hidden.txt', '_agent/session.html',
    `${'é'.repeat(254)}.html`, `${'a/'.repeat(32)}index.html`])('rejects an invalid path: %s', (path) => {
    expect(sitePathProblem(path)).toMatchObject({ code: 'INVALID_PATH', message: expect.any(String) })
  })

  it.each(['README', 'docs.md/README', 'movie.mp4', 'archive.zip', 'script.sh', 'file.'])('rejects an unsupported extension: %s', (path) => {
    expect(sitePathProblem(path)).toEqual({ code: 'UNSUPPORTED_MEDIA_TYPE', message: `Unsupported file extension for ${path}` })
  })

  it('keeps Markdown and PDF outside the existing text editor interface', () => {
    expect(fileLanguage('readme.md')).toBeNull()
    expect(fileLanguage('guide.pdf')).toBeNull()
    expect(fileLanguage('notes.txt')).toBe('text')
  })
})
