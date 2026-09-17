const supportedExtensions = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'svg', 'ico', 'woff', 'woff2', 'txt', 'xml', 'webmanifest', 'map', 'md', 'pdf'])
const pathEncoder = new TextEncoder()

export function sitePathProblem(path: string): { code: 'INVALID_PATH' | 'UNSUPPORTED_MEDIA_TYPE'; message: string } | null {
  if (typeof path !== 'string' || pathEncoder.encode(path).byteLength > 512 || path.startsWith('/') || path.includes('\\') || path.includes('%') || [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    return { code: 'INVALID_PATH', message: 'File path is not a canonical relative POSIX path' }
  }
  const segments = path.split('/')
  if (segments.length > 32 || segments.some((part) => !part || part.startsWith('.')) || segments[0] === '_agent') {
    return { code: 'INVALID_PATH', message: 'File path contains a forbidden segment' }
  }
  const filename = segments[segments.length - 1]
  const dot = filename.lastIndexOf('.')
  if (dot < 0 || !supportedExtensions.has(filename.slice(dot + 1).toLowerCase())) {
    return { code: 'UNSUPPORTED_MEDIA_TYPE', message: `Unsupported file extension for ${path}` }
  }
  return null
}

// Uploaded text stays inert in the owner area, including HTML and SVG.
export function fileLanguage(path: string) {
  const extension = path.split('.').at(-1)?.toLowerCase()
  switch (extension) {
    case 'html': case 'htm': return 'html'
    case 'css': return 'css'
    case 'js': case 'mjs': return 'javascript'
    case 'json': case 'webmanifest': case 'map': return 'json'
    case 'svg': case 'xml': return 'xml'
    case 'txt': return 'text'
    default: return null
  }
}

export const maxEditorBytes = 256 * 1024

export function isRasterImage(path: string) {
  return /\.(png|jpe?g|webp|avif|gif|ico)$/i.test(path)
}
